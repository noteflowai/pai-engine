/**
 * Aerodynamics lane: an Ahmed-type body (CadQuery) solved with OpenFOAM v2512 (snappyHexMesh + simpleFoam, k-ω SST)
 * in the pinned OpenCFD image, on two mesh levels. Reference body and candidate are solved natively; the four checks
 * (drag coefficient, two-level grid convergence, iterative convergence, mesh quality) go through the same JUnit →
 * EvalArc comparison, feedback recheck and release gate as the other lanes. Steady RANS is a design comparison, not a
 * wind-tunnel validation.
 */
import { runEngine } from "./kernel/engine-runtime.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { NativeAdapters, writePrivate } from "./adapters.js";
import type { Config } from "./config.js";
import { Id, type Project, type Receipt, type DiffResult } from "./contracts.js";
import { canonical, DomainError, sha256 } from "./domain.js";
import { nativeRun } from "./kernel/native-run.js";
import type { Store } from "./store.js";
import type { LiveBus } from "./live.js";
import { NativeEvent, type SceneStage } from "./kernel/native-events.js";

export const AERO_CHECKS = ["drag-coefficient", "grid-convergence", "iterative-convergence", "mesh-quality"] as const;
export const AERO_FILES = ["checks.json", "cfd.json", "body.step", "body.stl", "aero.glb", "forces-3.dat", "forces-4.dat", "checkMesh-3.log", "checkMesh-4.log"] as const;
export const AeroParameters = z.object({
  slantAngleDeg: z.number().min(0).max(40), noseRadius: z.number().min(0.05).max(0.15), length: z.number().min(0.8).max(1.3), height: z.number().min(0.24).max(0.34),
}).strict();
export type AeroParameters = z.infer<typeof AeroParameters>;
export const AeroRequirements = z.object({
  maxDragCoefficient: z.number().min(0.05).max(2), maxGridChange: z.number().min(0.005).max(0.5), maxIterativeBand: z.number().min(1e-5).max(0.2),
}).strict();
export type AeroRequirementsValue = z.infer<typeof AeroRequirements>;
/** The Ahmed reference body (25° slant) is the baseline of every review. */
export const AERO_REFERENCE: z.infer<typeof AeroParameters> = { slantAngleDeg: 25, noseRadius: 0.1, length: 1.044, height: 0.288 };
// Two snappyHexMesh levels (3 → 4) change Cd by 9–10 % on this body without prism layers, hence 0.12 (see docs/AERO.md).
export const DEFAULT_AERO_REQUIREMENTS: z.infer<typeof AeroRequirements> = { maxDragCoefficient: 0.24, maxGridChange: 0.12, maxIterativeBand: 0.01 };
export const AERO_LEVELS = [3, 4] as const;
export const AeroRequest = z.object({
  requestId: Id, projectRevision: z.number().int().positive(), feedbackId: Id.optional(),
  parameters: AeroParameters, requirements: AeroRequirements.default(DEFAULT_AERO_REQUIREMENTS),
}).strict();
const Check = z.object({ id: z.enum(AERO_CHECKS), passed: z.boolean(), observed: z.number(), required: z.number(), unit: z.string(), method: z.string() }).strict();
export const AeroChecks = z.object({
  schema: z.literal("pai-cfd-checks-1"), engine: z.string(), variant: z.literal("aero-body"), parameters: AeroParameters,
  checks: z.array(Check).length(AERO_CHECKS.length), scope: z.literal("steady-rans-cfd"), physicalValidation: z.literal(false),
}).strict();
export type AeroChecks = z.infer<typeof AeroChecks>;
const Level = z.object({ level: z.number().int(), cells: z.number().int(), meshOk: z.boolean(), openfoam: z.string(), iterations: z.number().int(),
  cd: z.number(), cl: z.number(), window: z.number().int(), cdDrift: z.number(), cdBand: z.number(), seconds: z.number() }).strict();
export interface AeroReview {
  id: string; projectId: string; projectRevision: number; request: z.infer<typeof AeroRequest>; requirementDigest: string;
  state: "running" | "completed" | "failed" | "interrupted"; error?: string; createdAt: string; finishedAt?: string; feedbackId?: string;
  verdict?: "accepted-aero-body" | "rejected"; baseline?: AeroChecks; candidate?: AeroChecks; diff?: DiffResult;
  cfd?: Partial<Record<"baseline" | "candidate", { levels: z.infer<typeof Level>[]; frontalAreaM2: number; seconds: number; image: string; runner?: string;
    remote?: { level: number; jobId: string; image?: string; seconds?: number; nproc?: number }[] }>>;
  receipts: Receipt[]; sourceDigests: Record<string, string>; files: Record<string, string>;
  stages?: Partial<Record<"baseline" | "candidate", SceneStage[]>>; scope: "steady-rans-cfd"; physicalValidation: false;
}

function checksXml(value: AeroChecks) {
  const ids = new Set(value.checks.map(c => c.id));
  if (ids.size !== AERO_CHECKS.length || AERO_CHECKS.some(id => !ids.has(id))) throw new DomainError("AERO_CHECK_COVERAGE", "Native CFD check IDs must be unique and complete");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="body.aero" tests="${AERO_CHECKS.length}">`
    + [...value.checks].sort((a, b) => a.id < b.id ? -1 : 1).map(c =>
      `<testcase classname="body.aero" name="${c.id}">${c.passed ? "" : '<failure message="Native CFD check failed"/>'}</testcase>`).join("") + "</testsuite>\n";
}
export function aeroCaseText(run: AeroReview) {
  return `# Aerodynamics review — Ahmed-type body\n\nDecision: ${run.verdict ?? "pending"}; parameters: ${canonical(run.request.parameters)}.\n`
    + `Native ${run.candidate?.engine ?? "OpenFOAM"} (snappyHexMesh + simpleFoam, k-ω SST); EvalArc blocking changes: ${run.diff?.blocking_changes ?? "unknown"}.\n`
    + `Checks: ${run.candidate?.checks.map(c => `${c.id}=${c.passed} (${c.observed})`).join(", ") ?? "unknown"}.\n`
    + `Review: ${run.id}; requirement SHA-256: ${run.requirementDigest}.\n`
    + "Scope: steady RANS with wall functions on two snappyHexMesh levels; a design-comparison drag coefficient, not a wind-tunnel or road measurement.\n";
}
/** The OpenCFD image is configured by digest (PAI_OPENFOAM_IMAGE); docker is the local runner. */
export const aeroConfigured = (config: Config) => Boolean((config.openfoamImage || config.solverBatch?.cfdJobDefinition) && config.cadquery && config.physicsPython);
/** AWS Batch when its CFD job definition is configured (the hosted default), otherwise the local docker image. */
export const aeroRunner = (config: Config) => config.solverBatch?.cfdJobDefinition ? "batch" as const : "docker" as const;

export async function reviewAero(store: Store, config: Config, project: Project, input: unknown, live?: LiveBus): Promise<AeroReview> {
  const request = AeroRequest.parse(input);
  if (!aeroConfigured(config)) throw new DomainError("CFD_NOT_CONFIGURED", "Aerodynamics needs PAI_OPENFOAM_IMAGE (pinned OpenCFD image), CadQuery and the physics toolchain", 503);
  const record: AeroReview = { id: randomUUID(), projectId: project.id, projectRevision: request.projectRevision, request,
    requirementDigest: sha256(canonical({ projectRequirements: project.requirements, aeroRequirements: request.requirements })),
    state: "running", createdAt: new Date().toISOString(), feedbackId: request.feedbackId, receipts: [], sourceDigests: {}, files: {},
    scope: "steady-rans-cfd", physicalValidation: false };
  const directory = join(config.state, "aero", record.id);
  return nativeRun({ store, live, project, kind: "aero-review", evidenceKind: "aero-body", request, record, failure: "CFD_FAILED",
    recheck: { message: "Aerodynamics recheck must bind the same feedback and unchanged requirements", sameRequirements: original => canonical(original.request.requirements) === canonical(request.requirements) },
    work: async (record, publish) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const native = (f: string) => join(config.repository, "native", f);
      const scripts = ["cfd_review.py", "cfd_body.py", "cfd_case.py", "cfd_run.sh"];
      const digests = async () => Object.fromEntries(await Promise.all(scripts.map(async f => [f.replace(/_/g, "-"), sha256(await readFile(native(f)))])));
      const adapters = new NativeAdapters(config);
      const before = await digests(), nativeBefore = await adapters.sourceDigests();
      const runnerKind = aeroRunner(config);
      record.sourceDigests = { ...nativeBefore, ...before, "openfoam-image": runnerKind === "batch" ? `batch:${config.solverBatch!.cfdJobDefinition}` : config.openfoamImage!,
        ...(runnerKind === "batch" ? { "cfd-job.py": sha256(await readFile(native("cfd_job.py"))) } : {}), "cadquery-lock": sha256(await readFile(native("cadquery-requirements.txt"))) };
      // Reference and candidate solve concurrently; each gets half of the host's cores.
      // Local: reference and candidate share the host's cores. Batch: each case gets its own 16-vCPU job.
      const processors = runnerKind === "batch" ? 16 : Math.max(2, Math.floor((config.cfdProcessors ?? 8) / 2));
      await Promise.all((["baseline", "candidate"] as const).map(async name => {
        const target = join(directory, name);
        const parameters = name === "baseline" ? AERO_REFERENCE : request.parameters;
        const label = `OpenFOAM ${name === "baseline" ? "参考车身（Ahmed 25°）" : `候选车身（后斜角 ${parameters.slantAngleDeg}°）`} · 两级网格`;
        publish(request.requestId, { kind: "step", id: `cfd-${name}`, label, status: "running", which: name });
        const inputFile = join(directory, `${name}-input.json`);
        await writePrivate(inputFile, JSON.stringify({ parameters, requirements: request.requirements, cadquery: config.cadquery, levels: AERO_LEVELS,
          iterations: 1200, speedMs: 40, processors, runner: runnerKind === "batch"
            ? { kind: "batch", queue: config.solverBatch!.queue, jobDefinition: config.solverBatch!.cfdJobDefinition, bucket: config.solverBatch!.bucket,
                region: config.solverBatch!.region, run: record.id, name, timeoutSeconds: 7200 }
            : { kind: "docker", image: config.openfoamImage } }));
        let observed = Promise.resolve();
        const observe = (line: string) => {
          if (!line.startsWith("PAI_EVENT ")) return;
          observed = observed.then(async () => {
            const raw = (() => { try { return JSON.parse(line.slice(10)); } catch { return undefined; } })();
            if (raw?.type === "level") {
              publish(request.requestId, { kind: "step", id: `cfd-${name}-l${raw.level}`, label: `${name === "baseline" ? "参考" : "候选"} · 网格 level ${raw.level}：${raw.cells} 单元，Cd ${raw.cd}`,
                status: "done", which: name });
              return;
            }
            const parsed = NativeEvent.safeParse(raw);
            if (!parsed.success || parsed.data.type !== "stage") return;
            const e = parsed.data, digest = sha256(await readFile(join(target, e.file)));
            record.stages = { ...record.stages, [name]: [...(record.stages?.[name] ?? []), { index: e.index, id: e.id, label: e.label, file: e.file, sha256: digest, objects: e.objects }] };
            store.put("aero-review", record);
            publish(request.requestId, { kind: "stage", which: name, index: e.index, id: e.id, label: e.label, objects: e.objects, url: `/api/aero/${record.id}/stages/${name}/${e.index}`, sha256: digest });
          }).catch(() => { /* presentation only */ });
        };
        const args = ["-I", native("cfd_review.py"), "--input", inputFile, "--output", target];
        const r = await runEngine(config, { engine: "physics", program: config.physicsPython!, args, cwd: config.repository, mounts: { read: [inputFile], write: [target] },
          timeoutMs: 7_200_000, onLine: observe, network: config.solverBatch?.cfdJobDefinition ? "aws" : "none" });
        await observed;
        await writePrivate(join(directory, `${name}.stdout.log`), r.stdout);
        await writePrivate(join(directory, `${name}.stderr.log`), r.stderr);
        record.receipts.push({ adapter: "openfoam-native", command: ["python", ...args], startedAt: r.startedAt, finishedAt: r.finishedAt, exitCode: r.exitCode,
          stdoutSha256: sha256(r.stdout), sourceDigests: { script: before["cfd-review.py"], image: record.sourceDigests["openfoam-image"] } });
        publish(request.requestId, { kind: "step", id: `cfd-${name}`, label, status: r.exitCode === 0 ? "done" : "failed", which: name, detail: `exit ${r.exitCode}` });
        if (r.exitCode !== 0) throw new DomainError("CFD_FAILED", `Native CFD failed (${name}); retain receipts and inspect local artifacts`, 422);
        const checks = AeroChecks.parse(JSON.parse(await readFile(join(target, "checks.json"), "utf8")));
        if (canonical(checks.parameters) !== canonical(parameters)) throw new DomainError("CFD_CONTEXT", "Native CFD solved different parameters");
        const cfd = JSON.parse(await readFile(join(target, "cfd.json"), "utf8")) as { levels: unknown; body: { frontalAreaM2: number }; seconds: number; image: string; runner?: string;
          remote?: { level: number; jobId: string; image?: string; seconds?: number; nproc?: number }[] };
        record.cfd = { ...record.cfd, [name]: { levels: z.array(Level).parse(cfd.levels), frontalAreaM2: cfd.body.frontalAreaM2, seconds: cfd.seconds, image: cfd.image,
          runner: cfd.runner, remote: cfd.remote } };
        record[name] = checks;
        for (const file of AERO_FILES) record.files[`${name}/${file}`] = sha256(await readFile(join(target, file)));
        store.put("aero-review", record);
      }));
      for (const name of ["baseline", "candidate"] as const) {
        await writeFile(join(directory, name === "baseline" ? "baseline.xml" : "current.xml"), checksXml(record[name]!), { mode: 0o600, flag: "wx" });
      }
      publish(request.requestId, { kind: "step", id: "evalarc", label: "EvalArc 独立对照参考车身与候选车身", status: "running" });
      const diff = await adapters.diff(directory);
      publish(request.requestId, { kind: "step", id: "evalarc", label: "EvalArc 独立对照参考车身与候选车身", status: "done", detail: `blocking ${diff.value.blocking_changes}` });
      const lost = record.baseline!.checks.filter(c => c.passed && !record.candidate!.checks.find(n => n.id === c.id)!.passed).length;
      if (diff.value.blocking_changes !== lost || diff.value.gate_passed !== (lost === 0)) throw new DomainError("CFD_DIFF_MISMATCH", "Native CFD checks and independent comparison disagree");
      if (canonical(before) !== canonical(await digests()) || canonical(nativeBefore) !== canonical(await adapters.sourceDigests())) {
        throw new DomainError("SOURCE_CHANGED", "Native verifier changed during CFD production");
      }
      record.diff = diff.value; record.receipts.push(diff.receipt);
      return record.candidate!.checks.every(c => c.passed) ? "accepted-aero-body" : "rejected";
    } });
}
