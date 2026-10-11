/**
 * Artifact contract (pai-artifact-1): what PAI delivers is an executable, versioned, independently verifiable artifact
 * (an algorithm or a model), not a chat answer. One manifest per immutable version names its typed operations with
 * input/output schemas, capabilities and limits, the runtime and every pinned dependency with licence and source, the
 * provenance of its code, the digests of every file it ships, and the evidence that validated it.
 *
 * Kinds are plugins (`ArtifactAdapter`): adding an algorithm or a model means registering one adapter; the registry
 * and the workflow engine never branch on a specific artifact. See docs/adr/0001-artifacts-and-workflows.md.
 */
import type { EngineRuntime } from "../kernel/engine-runtime.js";
import { z } from "zod";
import type { Config } from "../config.js";

export const ARTIFACT_KINDS = ["algorithm", "model"] as const;
export const LIFECYCLE = ["draft", "validated", "released", "deprecated"] as const;
export type Lifecycle = (typeof LIFECYCLE)[number];
/** Allowed transitions; `validated` only through the adapter's own validation, `released`/`deprecated` only by a person. */
export const TRANSITIONS: Record<Lifecycle, Lifecycle[]> = { draft: ["validated"], validated: ["released", "deprecated"], released: ["deprecated"], deprecated: [] };

const Name = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);
const Semver = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/);
const Sha = z.string().regex(/^[a-f0-9]{64}$/);
export const ArtifactRef = z.string().regex(/^[a-z][a-z0-9-]{1,62}@\d{1,4}\.\d{1,4}\.\d{1,4}$/, "exact artifact version name@x.y.z");

export const Operation = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,30}$/), description: z.string().max(400),
  /** Named inputs and outputs with their data schema ids; the workflow engine type-checks wiring with these. */
  inputs: z.record(z.string(), z.string()), outputs: z.record(z.string(), z.string()),
  /** "none": pure computation on its inputs (re-running after an interruption is safe). Anything else needs reconciliation. */
  effects: z.enum(["none", "external-write"]),
}).strict();
export const Dependency = z.object({ name: z.string(), version: z.string(), license: z.string(), source: z.string(),
  role: z.enum(["solver", "runtime", "library"]) }).strict();
export const ArtifactManifest = z.object({
  schema: z.literal("pai-artifact-1"),
  name: Name, version: Semver, kind: z.enum(ARTIFACT_KINDS), adapter: Name,
  title: z.string().max(120), description: z.string().max(2000),
  operations: z.array(Operation).min(1).max(8),
  capabilities: z.array(z.string().max(200)).max(30), limits: z.record(z.string(), z.number()),
  runtime: z.object({ python: z.string(), lock: z.string(), entrypoints: z.record(z.string(), z.string()) }).strict(),
  dependencies: z.array(Dependency).max(40),
  license: z.string(), provenance: z.object({ repository: z.string(), sourceCommit: z.string().nullable(), builtAt: z.string(), builtBy: z.string() }).strict(),
  /** Every shipped file with its digest; the artifact's code runs only from these bytes. */
  files: z.record(z.string(), Sha),
  scope: z.string().max(600), physicalValidation: z.literal(false),
}).strict();
export type ArtifactManifest = z.infer<typeof ArtifactManifest>;

/** Usage of one execution (pai-usage-1). Native compute and model tokens are separate; unknown stays unknown. */
export const Usage = z.object({
  schema: z.literal("pai-usage-1"), tenant: z.string(), task: z.string(), artifact: z.string().nullable(), node: z.string().nullable(),
  native: z.object({ wallSeconds: z.number(), cpuSeconds: z.number().nullable(), maxRssKb: z.number().nullable(), storageBytes: z.number() }).strict(),
  model: z.object({ status: z.enum(["none", "measured", "unknown"]), provider: z.string().nullable(), model: z.string().nullable(), priceVersion: z.string().nullable(),
    inputTokens: z.number().nullable(), outputTokens: z.number().nullable() }).strict(),
  recordedAt: z.string(),
}).strict();
export type Usage = z.infer<typeof Usage>;
export const NO_MODEL: Usage["model"] = { status: "none", provider: null, model: null, priceVersion: null, inputTokens: null, outputTokens: null };

/** Result of running one operation of one artifact version. */
export interface OperationResult {
  /** "ok": the operation completed and its outputs are valid data; outputs may still describe a negative domain outcome. */
  state: "ok" | "failed";
  outputs: Record<string, unknown>;
  /** Short domain status for conditions and the UI (e.g. feasible / partial / infeasible / timeout / feasible-plan). */
  status: string;
  error?: string;
  usage: { cpuSeconds: number | null; maxRssKb: number | null; wallSeconds: number; storageBytes: number };
  receipts: { command: string[]; exitCode: number | null; stdoutSha256: string; seconds: number; runtime?: EngineRuntime }[];
}
export interface RunContext { config: Config; directory: string; files: Record<string, Buffer>; manifest: ArtifactManifest }

/** A plugin for one artifact family. Registered once in `registry.ts`; nothing else branches on artifact names. */
export interface ArtifactAdapter {
  id: string;
  /** Build the manifest and files of a version from this release's trusted sources. */
  build(config: Config, version: string, actor: string): Promise<{ manifest: ArtifactManifest; files: Record<string, Buffer> }>;
  /** Parameters an operation accepts (validated before any run). */
  params: Record<string, z.ZodType>;
  /** Data schema ids this adapter defines. */
  schemas: string[];
  /** Validate data against a schema id this adapter owns (inputs before a run, outputs after). */
  validateData(schemaId: string, value: unknown): string[];
  run(ctx: RunContext, operation: string, inputs: Record<string, unknown>, params: Record<string, unknown>): Promise<OperationResult>;
  /** The adapter's own acceptance: benchmark runs whose verified results gate `draft -> validated`. */
  validate(ctx: RunContext): Promise<{ passed: boolean; evidence: Record<string, unknown> }>;
  /** Labelled synthetic inputs for trying a workflow (never customer data). */
  sample?: { params: z.ZodType; generate(ctx: RunContext, params: Record<string, unknown>): Promise<unknown> };
  /** Whether the runtime this deployment provides matches the manifest's pins (checked before every run). */
  runtimeReady(config: Config, manifest: ArtifactManifest): Promise<{ ready: boolean; reason?: string }>;
}
