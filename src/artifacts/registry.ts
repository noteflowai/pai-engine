/**
 * Artifact registry: immutable versions, lifecycle, validation, signed packages, import, run.
 *
 * - A version (name@x.y.z) is created once; its manifest digest is its identity. Re-creating it with other content is
 *   refused, never overwritten. Its files are stored with it, so it runs from its own bytes, not from the repository.
 * - draft -> validated only by the adapter's own acceptance benchmark (native runs + independent verifier);
 *   validated -> released and -> deprecated only by a person. Deprecated versions cannot be newly pinned by workflows.
 * - Export is a signed package (pai-artifact-package-1, same signer as release packages); verification is offline.
 * - Import accepts only packages whose code is byte-identical to an adapter this release trusts: no remote code is
 *   loaded. Imported versions start as draft and must be validated here.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import { canonical, DomainError, sha256 } from "../domain.js";
import type { Store } from "../store.js";
import { FileEntry, PackageSubmission, signer, signManifest, verifyManifestSignature } from "../signing.js";
import { ArtifactManifest, NO_MODEL, TRANSITIONS, Usage, type ArtifactAdapter, type Lifecycle, type OperationResult } from "./contract.js";
import { logisticsAdapter } from "./logistics.js";
import { yardAdapter } from "./yard.js";

/** The plugin registry: the one place an artifact family is added. */
export const ADAPTERS: Record<string, ArtifactAdapter> = { [logisticsAdapter.id]: logisticsAdapter, [yardAdapter.id]: yardAdapter };
export const adapterOf = (id: string) => { const a = ADAPTERS[id]; if (!a) throw new DomainError("UNKNOWN_ADAPTER", `No artifact adapter ${id}`, 422); return a; };

export interface ArtifactVersion {
  id: string; revision: number; tenant: string; manifest: ArtifactManifest; digest: string;
  files: Record<string, string>; state: Lifecycle;
  history: { at: string; actor: string; from: Lifecycle | null; to: Lifecycle; reason: string }[];
  validation?: { at: string; passed: boolean; evidence: Record<string, unknown>; usage: Usage; runId: string };
  origin: "built" | "imported";
}
const FILE_KIND = "artifact-file";
export const artifactDigest = (m: ArtifactManifest) => sha256(canonical(m));
const tenantOf = (_actor: string) => "workspace"; // single-tenant deployment; every record carries its tenant for isolation later

export const CreateArtifact = z.object({ adapter: z.string(), version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/) }).strict();
export async function createArtifact(store: Store, config: Config, input: unknown, actor: string): Promise<ArtifactVersion> {
  const req = CreateArtifact.parse(input);
  const { manifest, files } = await adapterOf(req.adapter).build(config, req.version, actor);
  return register(store, ArtifactManifest.parse(manifest), files, actor, "built");
}

function register(store: Store, manifest: ArtifactManifest, files: Record<string, Buffer>, actor: string, origin: ArtifactVersion["origin"]) {
  const id = `${manifest.name}@${manifest.version}`;
  for (const [name, bytes] of Object.entries(files)) if (manifest.files[name] !== sha256(bytes)) throw new DomainError("ARTIFACT_FILE", `${name} differs from the manifest`, 422);
  if (Object.keys(files).length !== Object.keys(manifest.files).length) throw new DomainError("ARTIFACT_FILE", "Files and manifest disagree", 422);
  // Identity excludes build time and builder, so rebuilding the same sources is the same version, other content is not.
  const content = sha256(canonical({ ...manifest, provenance: { ...manifest.provenance, builtAt: null, builtBy: null } }));
  const existing = store.get<ArtifactVersion>("artifact", id);
  if (existing) {
    const prior = sha256(canonical({ ...existing.manifest, provenance: { ...existing.manifest.provenance, builtAt: null, builtBy: null } }));
    if (prior !== content) throw new DomainError("ARTIFACT_IMMUTABLE", `${id} already exists with different content; publish a new version`, 409);
    return existing;
  }
  for (const [name, bytes] of Object.entries(files)) {
    const key = `${id}/${name}`;
    if (!store.get(FILE_KIND, key)) store.insert(FILE_KIND, { id: key, sha256: sha256(bytes), contentBase64: bytes.toString("base64") } as never);
  }
  const record: ArtifactVersion = { id, revision: 1, tenant: tenantOf(actor), manifest, digest: artifactDigest(manifest), files: manifest.files, state: "draft",
    history: [{ at: new Date().toISOString(), actor, from: null, to: "draft", reason: origin === "built" ? "built from trusted sources" : "imported from a verified package" }], origin };
  store.insert("artifact", record);
  return record;
}

export function artifactFiles(store: Store, a: ArtifactVersion): Record<string, Buffer> {
  return Object.fromEntries(Object.entries(a.files).map(([name, digest]) => {
    const f = store.get<{ sha256: string; contentBase64: string }>(FILE_KIND, `${a.id}/${name}`);
    const bytes = f ? Buffer.from(f.contentBase64, "base64") : Buffer.alloc(0);
    if (!f || sha256(bytes) !== digest) throw new DomainError("ARTIFACT_FILE", `Stored file ${name} of ${a.id} is missing or modified`, 500);
    return [name, bytes];
  }));
}
export const getArtifact = (store: Store, id: string) => {
  const a = store.get<ArtifactVersion>("artifact", id);
  if (!a) throw new DomainError("NOT_FOUND", `Artifact ${id} not found`, 404);
  return a;
};

function transition(store: Store, a: ArtifactVersion, to: Lifecycle, actor: string, reason: string, extra: Partial<ArtifactVersion> = {}) {
  if (!TRANSITIONS[a.state].includes(to)) throw new DomainError("INVALID_TRANSITION", `${a.id}: ${a.state} cannot become ${to}`, 409);
  const next = { ...a, ...extra, revision: a.revision + 1, state: to, history: [...a.history, { at: new Date().toISOString(), actor, from: a.state, to, reason }] };
  store.put("artifact", next, a.revision);
  return next;
}

/** Run one operation of an exact version in a private directory; checks the runtime pins and the data schemas first. */
export async function runOperation(store: Store, config: Config, a: ArtifactVersion, operation: string, inputs: Record<string, unknown>,
  params: Record<string, unknown>, directory: string): Promise<OperationResult> {
  const adapter = adapterOf(a.manifest.adapter);
  const op = a.manifest.operations.find(o => o.id === operation);
  if (!op) throw new DomainError("UNKNOWN_OPERATION", `${a.id} has no operation ${operation}`, 422);
  for (const [name, schema] of Object.entries(op.inputs)) {
    const problems = adapter.validateData(schema, inputs[name]);
    if (problems.length) throw new DomainError("INVALID_INPUT", `${name} (${schema}): ${problems.join("; ")}`, 422);
  }
  const parsedParams = adapter.params[operation]?.safeParse(params ?? {});
  if (!parsedParams?.success) throw new DomainError("INVALID_PARAMS", `${operation}: ${parsedParams?.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")}`, 422);
  const ready = await adapter.runtimeReady(config, a.manifest);
  if (!ready.ready) throw new DomainError("RUNTIME_NOT_READY", ready.reason ?? "runtime differs from the artifact's pins", 503);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const result = await adapter.run({ config, directory, files: artifactFiles(store, a), manifest: a.manifest }, operation, inputs, parsedParams.data as Record<string, unknown>);
  if (result.state === "ok") for (const [name, schema] of Object.entries(op.outputs)) {
    const problems = adapter.validateData(schema, result.outputs[name]);
    if (problems.length) return { ...result, state: "failed", status: "error", error: `output ${name} does not match ${schema}: ${problems.join("; ")}` };
  }
  return result;
}

export const usageRecord = (tenant: string, task: string, artifact: string | null, node: string | null, u: OperationResult["usage"]): Usage => Usage.parse({
  schema: "pai-usage-1", tenant, task, artifact, node, native: { wallSeconds: Math.round(u.wallSeconds * 1000) / 1000, cpuSeconds: u.cpuSeconds, maxRssKb: u.maxRssKb, storageBytes: u.storageBytes },
  model: NO_MODEL, recordedAt: new Date().toISOString() });

/** A labelled synthetic input generated by the artifact's own code (for trying a workflow; never customer data). */
export async function sampleInput(store: Store, config: Config, id: string, input: unknown) {
  const a = getArtifact(store, id), adapter = adapterOf(a.manifest.adapter);
  if (!adapter.sample) throw new DomainError("NO_SAMPLES", `${id} provides no samples`, 404);
  const params = adapter.sample.params.parse(input ?? {}) as Record<string, unknown>;
  const directory = join(config.state, "artifacts", "samples", randomUUID());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { return await adapter.sample.generate({ config, directory, files: artifactFiles(store, a), manifest: a.manifest }, params); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

export async function validateArtifact(store: Store, config: Config, id: string, actor: string): Promise<ArtifactVersion> {
  const a = getArtifact(store, id);
  if (a.state !== "draft") throw new DomainError("INVALID_TRANSITION", `${id} is ${a.state}; only a draft is validated`, 409);
  const adapter = adapterOf(a.manifest.adapter);
  const ready = await adapter.runtimeReady(config, a.manifest);
  if (!ready.ready) throw new DomainError("RUNTIME_NOT_READY", ready.reason ?? "runtime not ready", 503);
  const runId = randomUUID(), directory = join(config.state, "artifacts", "validation", runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const t0 = Date.now();
  try {
    const r = await adapter.validate({ config, directory, files: artifactFiles(store, a), manifest: a.manifest });
    const usage = usageRecord(a.tenant, `validate:${runId}`, a.id, null, { wallSeconds: (Date.now() - t0) / 1000, cpuSeconds: null, maxRssKb: null, storageBytes: 0 });
    const validation = { at: new Date().toISOString(), passed: r.passed, evidence: r.evidence, usage, runId };
    if (!r.passed) {
      // The failed benchmark is kept on the draft; it never becomes validated.
      const next = { ...a, revision: a.revision + 1, validation };
      store.put("artifact", next, a.revision);
      return next;
    }
    return transition(store, a, "validated", actor, "acceptance benchmark passed (native runs, independent verifier)", { validation });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export const Transition = z.object({ to: z.enum(["released", "deprecated"]), reason: z.string().trim().min(5).max(500) }).strict();
export function decideArtifact(store: Store, id: string, input: unknown, actor: string) {
  const req = Transition.parse(input);
  const a = getArtifact(store, id);
  if (req.to === "released" && !a.validation?.passed) throw new DomainError("NOT_VALIDATED", `${id} has no passing validation`, 409);
  return transition(store, a, req.to, actor, req.reason);
}

// ---------------------------------------------------------------- signed packages
export const ArtifactPackage = z.object({
  schema: z.literal("pai-artifact-package-1"), manifest: ArtifactManifest, state: z.enum(["validated", "released", "deprecated"]),
  validation: z.object({ at: z.string(), passed: z.literal(true), evidence: z.record(z.string(), z.unknown()) }).passthrough(),
  history: z.array(z.unknown()), files: z.record(z.string(), FileEntry),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.object({ algorithm: z.enum(["ECDSA_P256_SHA256", "ED25519"]), keyId: z.string(), publicKeyPem: z.string(), value: z.string(), signedAt: z.string() }).strict(),
  physicalValidation: z.literal(false),
}).strict();
export type ArtifactPackage = z.infer<typeof ArtifactPackage>;
export const packageManifest = (p: Omit<ArtifactPackage, "manifestSha256" | "signature">) => canonical({ schema: p.schema, manifest: p.manifest, state: p.state,
  validation: p.validation, history: p.history, files: Object.fromEntries(Object.entries(p.files).map(([k, f]) => [k, { sha256: f.sha256, bytes: f.bytes }])),
  physicalValidation: p.physicalValidation });

export async function exportArtifact(store: Store, config: Config, id: string): Promise<ArtifactPackage> {
  const a = getArtifact(store, id);
  if (a.state === "draft" || !a.validation?.passed) throw new DomainError("NOT_VALIDATED", `${id} must be validated before it is packaged`, 409);
  const files = artifactFiles(store, a);
  const body = { schema: "pai-artifact-package-1" as const, manifest: a.manifest, state: a.state as "validated" | "released" | "deprecated",
    validation: { at: a.validation.at, passed: true as const, evidence: a.validation.evidence, runId: a.validation.runId }, history: a.history,
    files: Object.fromEntries(Object.entries(files).sort().map(([k, b]) => [k, { sha256: sha256(b), bytes: b.length, contentBase64: b.toString("base64") }])),
    physicalValidation: false as const };
  return { ...body, ...await signManifest(config, packageManifest(body)) };
}

/** Offline verification of a package: file digests against the artifact manifest, the package manifest and the signature. */
export function verifyArtifactPackage(input: unknown, trustedPublicKeyPem?: string) {
  const parsed = ArtifactPackage.safeParse(input);
  if (!parsed.success) throw new DomainError("PACKAGE_SCHEMA", parsed.error.issues.slice(0, 5).map(i => `${i.path.join(".")}: ${i.message}`).join("; "), 422);
  const p = parsed.data;
  for (const [name, f] of Object.entries(p.files)) {
    const b = Buffer.from(f.contentBase64, "base64");
    if (b.length !== f.bytes || sha256(b) !== f.sha256 || p.manifest.files[name] !== f.sha256) throw new DomainError("PACKAGE_FILE", `Modified file: ${name}`, 422);
  }
  if (Object.keys(p.files).length !== Object.keys(p.manifest.files).length) throw new DomainError("PACKAGE_FILE", "Package files differ from the manifest", 422);
  const { manifestSha256, signature, ...body } = p;
  const pinned = verifyManifestSignature(packageManifest(body), manifestSha256, signature, trustedPublicKeyPem);
  return { valid: true as const, artifact: `${p.manifest.name}@${p.manifest.version}`, digest: artifactDigest(p.manifest), state: p.state, files: Object.keys(p.files).length,
    signer: { keyId: signature.keyId, algorithm: signature.algorithm, trusted: pinned ?? false, pinned: pinned !== undefined }, physicalValidated: false as const };
}

/** Everything an artifact claims except who built it, when, and from which commit (that is attested by the signer). */
const claims = (m: ArtifactManifest) => canonical({ ...m, provenance: null });

/**
 * Import a package. The signer must be trusted: this deployment's own key, or a key the operator pins for this import
 * (obtained out of band). No remote code and no foreign claims: the package's files and every manifest claim
 * (operations, effects, schemas, limits, dependency pins, scope) must equal what this release's adapter builds.
 */
export async function importArtifact(store: Store, config: Config, input: unknown, actor: string) {
  const req = PackageSubmission.parse(input);
  const own = (await signer(config)).publicKeyPem;
  const verified = verifyArtifactPackage(req.package, req.trustedPublicKeyPem ?? own);
  if (!verified.signer.trusted) throw new DomainError("UNTRUSTED_SIGNER", "The package is signed by a key this deployment does not trust; pin the expected public key", 422);
  const p = req.package as ArtifactPackage;
  const adapter = adapterOf(p.manifest.adapter);
  const local = await adapter.build(config, p.manifest.version, actor);
  const foreign = Object.entries(p.manifest.files).filter(([name, digest]) => local.manifest.files[name] !== digest).map(([name]) => name);
  if (foreign.length || Object.keys(local.manifest.files).length !== Object.keys(p.manifest.files).length) {
    throw new DomainError("UNTRUSTED_CODE", `Package code differs from the trusted ${adapter.id} sources (${foreign.join(", ") || "file set"}); not imported`, 422);
  }
  if (claims(local.manifest) !== claims(p.manifest)) throw new DomainError("UNTRUSTED_CLAIMS", `Package manifest claims differ from the trusted ${adapter.id} build; not imported`, 422);
  const files = Object.fromEntries(Object.entries(p.files).map(([k, f]) => [k, Buffer.from(f.contentBase64, "base64")]));
  return { verified, artifact: register(store, ArtifactManifest.parse(p.manifest), files, actor, "imported") };
}
