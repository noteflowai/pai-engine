import { enginePath, runEngine, toolDigest } from "./kernel/engine-runtime.js";
import { randomUUID } from "node:crypto";
import { readFile, readdir, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { NativeAdapters, writePrivate } from "./adapters.js";
import type { Config } from "./config.js";
import { Id, type Feedback, type Project, type Receipt, type DiffResult } from "./contracts.js";
import { canonical, DomainError, sha256 } from "./domain.js";
import { nativeRun } from "./kernel/native-run.js";
import { Store } from "./store.js";
import type { LiveBus } from "./live.js";
import { NativeEvent, type SceneStage } from "./kernel/native-events.js";
import { CAD_FAMILIES, familyOf, PILLOW_PRESETS, type CadFamily } from "./part-family.js";
export { CAD_FAMILIES, familyOf, PILLOW_PRESETS, type CadFamily } from "./part-family.js";
import { ISOLATION, sandboxArgs, sandboxRuntime, sandboxStatus, type SandboxRuntime } from "./sandbox.js";
import { invokeRuntime } from "./agentcore.js";

/**
 * Parametric CAD review: a controlled CadQuery/OCCT recipe for a NEMA 17 motor-mount bracket.
 * Baseline (reference parameters) and candidate are produced natively, measured on the B-Rep,
 * mapped to JUnit and compared by EvalArc. Editable STEP plus STL/GLB/SVG are retained by digest.
 * Nominal geometry and DFM rules of thumb only — no FEA, tolerance stack-up or physical test.
 */
export const GEOMETRY_CHECKS = ["solid-valid", "nema17-interface", "motor-interference", "min-wall", "hole-edge-distance", "mass", "envelope"] as const;
/**
 * Part families. Each has its own trusted recipe and B-Rep interface checks (native script); mass, envelope, wall,
 * edge distance, DFM and CAM are shared. FEA load cases, sweeps, optimisation and generated code exist for the bracket.
 */
export const FAMILY_CHECKS: Record<CadFamily, readonly string[]> = {
  "nema17-bracket": GEOMETRY_CHECKS,
  "pillow-block": ["solid-valid", "bearing-seat", "shoulder", "min-wall", "hole-edge-distance", "mass", "envelope"],
};
export const FAMILY_SCRIPT: Record<CadFamily, string> = { "nema17-bracket": "cad_bracket.py", "pillow-block": "cad_bearing.py" };
/** Structural checks from the native FEA (Gmsh + CalculiX); present only when structural requirements are frozen. */
export const FEA_CHECKS = ["max-deflection", "max-stress", "bore-distortion"] as const;
/** FEA checks per family: the bearing housing also measures how much the load distorts its seat. */
export const FAMILY_FEA_CHECKS: Record<CadFamily, readonly (typeof FEA_CHECKS)[number][]> = {
  "nema17-bracket": ["max-deflection", "max-stress"], "pillow-block": ["max-deflection", "max-stress", "bore-distortion"] };
/** Native FEA script and its deck/result stem per family (native/fea_core.py holds the shared mesher, deck and solve). */
export const FAMILY_FEA: Record<CadFamily, { script: string; stem: string }> = {
  "nema17-bracket": { script: "fea_bracket.py", stem: "bracket" }, "pillow-block": { script: "fea_pillow.py", stem: "pillow" } };
export const feaFiles = (family: CadFamily) => ["fea.json", "fea.glb", `${FAMILY_FEA[family].stem}-fine.inp`, `${FAMILY_FEA[family].stem}-fine.frd`];
/** 3-axis milling DFM (native/cad_dfm.py on the B-Rep, shop assumptions in native/dfm-shop.json); opt-in like FEA. */
export const DFM_CHECKS = ["machining-setups", "hole-drillability", "fastener-access", "unit-cost"] as const;
/** CAM (opt-in under dfm): FreeCAD CAM + OpenCAMLib programs per setup, checked by an independent dexel simulation. */
export const CAM_CHECKS = ["cam-toolpath", "cycle-time"] as const;
export const CAD_CHECKS = [...GEOMETRY_CHECKS, "bearing-seat", "shoulder", ...FEA_CHECKS, ...DFM_CHECKS, ...CAM_CHECKS] as const;
export const CamRequirements = z.object({ maxCycleMinutes: z.number().min(1).max(10000) }).strict();
export const DfmRequirements = z.object({ maxSetups: z.number().int().min(1).max(6), maxUnitCostEur: z.number().min(0.1).max(100000),
  cam: CamRequirements.optional() }).strict();
export const CAM_FILE = /^(cam\.json|cam-verify\.json|cam-job\.json|cam-sim\.png|setup[+-][XYZ]\.nc)$/;
export type DfmRequirements = z.infer<typeof DfmRequirements>;
export const DEFAULT_DFM: DfmRequirements = { maxSetups: 2, maxUnitCostEur: 25 };
export const CAD_PRESETS = ["reference", "lightweight", "undersize-bore", "compact"] as const;
/** Pillow-block presets (native/cad_bearing.py PRESETS): 6202 housing reference and three single-fault variants. */
/** "generated": the candidate solid comes from CadQuery code (AI, external agent or maintainer) run in the OS sandbox. */
export const CAD_VARIANTS = [...CAD_PRESETS, ...PILLOW_PRESETS, "parametric", "generated"] as const;
/** Bounded explicit parameters of the trusted recipe (variant "parametric", e.g. a chosen sweep point); mirrors native/cad_recipe.py BOUNDS. */
export const CadParameters = z.object({
  thickness: z.number().min(2).max(8), width: z.number().min(46).max(80), plateHeight: z.number().min(40).max(60), pilotBore: z.number().min(21).max(24),
}).strict();
export type CadParameters = z.infer<typeof CadParameters>;
/** Mirrors native/cad_bearing.py BOUNDS. */
export const PillowParameters = z.object({
  width: z.number().min(60).max(140), depth: z.number().min(14).max(40), baseDepth: z.number().min(20).max(60), axisHeight: z.number().min(22).max(60),
  baseThickness: z.number().min(6).max(20), boltPitch: z.number().min(40).max(120), seatDiameter: z.number().min(34.9).max(35.2),
  shoulderDiameter: z.number().min(17).max(34), crown: z.number().min(2).max(20).optional(),
}).strict();
export const CadSource = z.object({ language: z.literal("cadquery-2.8"), code: z.string().min(40).max(20_000) }).strict();
export type CadSource = z.infer<typeof CadSource>;
export const CAD_FILES = ["part.step", "part.stl", "part.glb", "assembly.glb", "drawing.svg", "checks.json"] as const;
/** Every FEA artefact name a review may hold (both families); a review records only its family's (feaFiles). */
export const FEA_FILES = ["fea.json", "fea.glb", "bracket-fine.inp", "bracket-fine.frd", "pillow-fine.inp", "pillow-fine.frd"] as const;
/**
 * Structural load case, nominal 6061-T6.
 * - NEMA 17 bracket: belt-driven stepper, radial force at the pulley, `leverMm` from the mounting face.
 * - Pillow block: radial shaft load through the bearing (`leverMm` 0, at the bearing centre), `direction` away from or
 *   toward the base, and the seat distortion limit `maxBoreDistortionMm` (out-of-roundness under load).
 */
export const StructuralRequirements = z.object({
  forceN: z.number().min(1).max(20000), leverMm: z.number().min(0).max(200),
  safetyFactor: z.number().min(1).max(10), maxDeflectionMm: z.number().min(0.001).max(10),
  direction: z.enum(["away-from-base", "toward-base"]).optional(), maxBoreDistortionMm: z.number().min(0.0005).max(1).optional(),
}).strict();
export type StructuralRequirements = z.infer<typeof StructuralRequirements>;
export const DEFAULT_STRUCTURAL: StructuralRequirements = { forceN: 60, leverMm: 50, safetyFactor: 2, maxDeflectionMm: 0.06 };
/**
 * Pillow-block default: 1 kN lifting the shaft (about 0.27 of the 6202 static rating C0 = 3.75 kN), bearing centre
 * moving ≤ 10 µm and seat out-of-roundness ≤ 6 µm, close to the IT5/2 seat form practice for Ø35 (5.5 µm).
 */
export const PILLOW_STRUCTURAL: StructuralRequirements = { forceN: 1000, leverMm: 0, safetyFactor: 2, maxDeflectionMm: 0.01,
  direction: "away-from-base", maxBoreDistortionMm: 0.006 };
export const FAMILY_STRUCTURAL: Record<CadFamily, StructuralRequirements> = { "nema17-bracket": DEFAULT_STRUCTURAL, "pillow-block": PILLOW_STRUCTURAL };
/** Whether a structural block fits the family's load case. */
export const structuralFits = (family: CadFamily, s: StructuralRequirements) => family === "pillow-block"
  ? s.leverMm === 0 && s.direction !== undefined && s.maxBoreDistortionMm !== undefined && s.forceN <= 20000
  : s.direction === undefined && s.maxBoreDistortionMm === undefined && s.forceN <= 2000;
const mm = z.number().min(1).max(2000);
export const CadRequirements = z.object({
  maxMassG: z.number().min(1).max(10000), minWallMm: z.number().min(0.5).max(50),
  edgeDistanceFactor: z.number().min(1).max(4), requireNoInterference: z.boolean(), maxEnvelopeMm: z.tuple([mm, mm, mm]),
  structural: StructuralRequirements.optional(),
  dfm: DfmRequirements.optional(),
}).strict();
export type CadRequirements = z.infer<typeof CadRequirements>;
export const DEFAULT_CAD_REQUIREMENTS: CadRequirements = { maxMassG: 80, minWallMm: 3, edgeDistanceFactor: 1.5, requireNoInterference: true, maxEnvelopeMm: [80, 40, 60] };
export const FAMILY_DEFAULTS: Record<CadFamily, CadRequirements> = {
  "nema17-bracket": DEFAULT_CAD_REQUIREMENTS,
  // 6202 housing in 6061: ≥ 5 mm around the bearing seat; footprint ≤ 120 × 40, height ≤ 60 mm.
  "pillow-block": { maxMassG: 250, minWallMm: 5, edgeDistanceFactor: 1.5, requireNoInterference: true, maxEnvelopeMm: [120, 40, 60] },
};
export const CadRequest = z.object({
  requestId: Id, projectRevision: z.number().int().positive(), variant: z.enum(CAD_VARIANTS),
  requirements: CadRequirements, feedbackId: Id.optional(), source: CadSource.optional(), parameters: z.union([CadParameters, PillowParameters]).optional(),
  /** Part family for "parametric"; presets carry their own family. */
  family: z.enum(CAD_FAMILIES).optional(),
  /** Provenance only: the sweep and point a parametric candidate was chosen from. */
  fromSweep: z.object({ sweepId: Id, point: z.number().int().min(1).max(36) }).strict().optional(),
  /** Provenance only: the physics optimisation and solved point a parametric candidate was chosen from. */
  fromOptimize: z.object({ optimizeId: Id, point: z.number().int().min(1).max(80) }).strict().optional(),
}).strict()
  .refine(r => (r.variant === "generated") === Boolean(r.source), { message: "variant generated requires source code, and only generated takes source", path: ["source"] })
  .refine(r => (r.variant === "parametric") === Boolean(r.parameters), { message: "variant parametric requires parameters, and only parametric takes them", path: ["parameters"] })
  .refine(r => !r.fromSweep || r.variant === "parametric", { message: "fromSweep only applies to parametric candidates", path: ["fromSweep"] })
  .refine(r => !r.fromOptimize || (r.variant === "parametric" && !r.fromSweep), { message: "fromOptimize only applies to parametric candidates", path: ["fromOptimize"] })
  .refine(r => !r.family || r.variant === "parametric" || r.variant === "generated" || familyOf({ variant: r.variant }) === r.family, { message: "family must match the preset", path: ["family"] })
  .refine(r => r.variant !== "parametric" || (familyOf(r) === "pillow-block" ? PillowParameters : CadParameters).safeParse(r.parameters).success,
    { message: "parameters must match the part family", path: ["parameters"] })
  .refine(r => !r.requirements.structural || structuralFits(familyOf(r), r.requirements.structural),
    { message: "structural load case must match the part family (pillow block: leverMm 0, direction, maxBoreDistortionMm; bracket: forceN ≤ 2000 without them)", path: ["requirements", "structural"] })
  ;
export const CadChecks = z.object({
  schema: z.literal("pai-cad-checks-1"), variant: z.enum(CAD_VARIANTS), cadquery: z.string(), ocp: z.string(), units: z.literal("mm"),
  mass: z.number(), volume: z.number(), boundingBox: z.array(z.number()).length(3),
  checks: z.array(z.object({ id: z.enum(CAD_CHECKS), passed: z.boolean() }).passthrough()).min(7).max(12),
  scope: z.literal("parametric-part-geometry"), physicalValidation: z.literal(false),
}).passthrough();
export type CadChecks = z.infer<typeof CadChecks>;
export interface CadReview {
  id: string; projectId: string; projectRevision: number; request: z.infer<typeof CadRequest>;
  requirementDigest: string; state: "running" | "completed" | "failed" | "interrupted"; error?: string;
  createdAt: string; finishedAt?: string; feedbackId?: string; verdict?: "accepted-cad-part" | "rejected";
  baseline?: CadChecks; candidate?: CadChecks; diff?: DiffResult;
  /** Native FEA summaries (coarse/fine meshes, convergence) per part, when structural requirements are frozen. */
  fea?: Partial<Record<"baseline" | "candidate", FeaSummary>>;
  receipts: Receipt[]; sourceDigests: Record<string, string>; files: Record<string, string>;
  stages?: Partial<Record<"baseline" | "candidate", SceneStage[]>>;
  /** Generated candidate: code digest, isolation layers and the sandbox outcome. */
  sandbox?: { codeSha256: string; isolation: readonly string[]; status: "ok" | "policy" | "error" | "limit"; violations?: string[]; error?: string; motorAxisZ?: number;
    /** Where the code ran and which layers the runtime reported as active (AgentCore). */
    transport?: "local" | "agentcore"; layers?: { astPolicy: boolean; processLockdown: boolean; bubblewrap: boolean; microvm: boolean } };
  scope: "parametric-part-geometry"; physicalValidation: false;
}

const FeaResult = z.object({
  schema: z.literal("pai-fea-1"), solver: z.string(), mesher: z.string(), element: z.string(), material: z.object({ name: z.string(), E: z.number(), nu: z.number(), yield: z.number() }).passthrough(),
  load: z.object({ forceN: z.number(), leverMm: z.number() }).passthrough(),
  meshes: z.record(z.string(), z.object({ nodes: z.number().int(), elements: z.number().int(), axisDisplacementMm: z.number(), peakVonMisesMPa: z.number(), seconds: z.number() }).passthrough()),
  convergence: z.object({ axisDisplacement: z.number(), peakVonMises: z.number(), boreDistortion: z.number().optional() }).strict(), displayScale: z.number(), colorScaleMaxMPa: z.number(),
  checks: z.array(z.object({ id: z.enum(FEA_CHECKS), passed: z.boolean(), observed: z.number(), required: z.number() }).passthrough()).min(2).max(3),
  scope: z.literal("linear-static-nominal"), physicalValidation: z.literal(false),
}).strict();
export type FeaSummary = Omit<z.infer<typeof FeaResult>, "checks">;

function checksXml(value: CadChecks, expected: readonly string[]) {
  const ids = new Set(value.checks.map(c => c.id));
  if (ids.size !== value.checks.length || ids.size !== expected.length || expected.some(id => !ids.has(id as never))) {
    throw new DomainError("CAD_CHECK_COVERAGE", "Native CAD check IDs must be unique and complete");
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="bracket.cad" tests="${expected.length}">`
    + [...value.checks].sort((a, b) => a.id < b.id ? -1 : 1).map(c =>
      `<testcase classname="bracket.cad" name="${c.id}">${c.passed ? "" : '<failure message="Native CAD geometry check failed"/>'}</testcase>`).join("")
    + "</testsuite>\n";
}
export function cadCaseText(run: CadReview) {
  const family = familyOf(run.request);
  return `# Parametric CAD part review — ${family === "pillow-block" ? "6202 pillow-block bearing housing" : "NEMA 17 motor-mount bracket"}\n\nDecision: ${run.verdict ?? "pending"}; variant: ${run.request.variant}.\n`
    + `Native CadQuery ${run.candidate?.cadquery ?? "unknown"} / OCCT ${run.candidate?.ocp ?? "unknown"}; EvalArc blocking changes: ${run.diff?.blocking_changes ?? "unknown"}.\n`
    + `Checks: ${run.candidate?.checks.map(c => `${c.id}=${c.passed}`).join(", ") ?? "unknown"}.\n`
    + (run.sandbox ? `Generated CadQuery code SHA-256 ${run.sandbox.codeSha256}, executed in an OS sandbox (${run.sandbox.isolation.join(", ")}); outcome ${run.sandbox.status}.\n` : "")
    + `Mass ${run.candidate?.mass ?? "?"} g (6061 aluminium, nominal). Review: ${run.id}; requirement SHA-256: ${run.requirementDigest}.\n`
    + (run.fea?.candidate ? `FEA: ${run.fea.candidate.solver}, ${run.fea.candidate.element}, ${run.fea.candidate.load.forceN} N; linear static, nominal material.\n` : "")
    + (run.fea ? "Scope: nominal parametric geometry with editable STEP, DFM rules of thumb and linear static FEA. No tolerance stack-up, fatigue or physical test.\n"
      : "Scope: nominal parametric geometry with editable STEP and DFM rules of thumb. No FEA, tolerance stack-up, process simulation or physical test.\n");
}

/**
 * Run untrusted code in the sandbox. Only an exact BREP solid and a small result file leave it; the solid is then
 * measured by a second sandboxed process with the shared checks. Outcomes other than "ok" fail the review with a reason.
 */
async function buildGenerated(config: Config, publish: LiveBus["publish"], record: CadReview, directory: string, runtime: SandboxRuntime,
  source: CadSource, codeSha256: string, requestId: string) {
  const code = join(directory, "candidate-code.py"), out = join(directory, "candidate-src");
  await writePrivate(code, source.code);
  await mkdir(out, { recursive: true, mode: 0o700 });
  record.sandbox = { codeSha256, isolation: ISOLATION, status: "error" };
  publish(requestId, { kind: "step", id: "cad-sandbox", label: "在隔离沙箱中运行生成代码", status: "running", which: "candidate" });
  const argv = [runtime.python, "-I", "-W", "ignore", join(runtime.native, "cad_sandbox.py"), "--code", code, "--output", out, "--cpu-seconds", "60"];
  let exitCode: number | null = null, stdout = "", startedAt = new Date().toISOString(), finishedAt = startedAt;
  try {
    const r = await runEngine(config, { engine: "cad", program: config.bwrap ?? "bwrap", args: sandboxArgs(config, runtime, { readOnly: [code], writable: [out] }, argv),
      cwd: config.repository, mounts: { read: [code], write: [out] }, timeoutMs: 120_000, untrusted: true });
    ({ exitCode, stdout, startedAt, finishedAt } = r);
    await writePrivate(join(directory, "sandbox.stderr.log"), r.stderr);
  } catch (error) {
    if (!(error instanceof DomainError && error.code === "NATIVE_INTERRUPTED")) throw error;
    finishedAt = new Date().toISOString();
  }
  record.receipts.push({ adapter: "cadquery-sandbox", command: ["bwrap", ...ISOLATION.map(x => `[${x}]`), "python", "cad_sandbox.py"], startedAt, finishedAt,
    exitCode: exitCode ?? -1, stdoutSha256: sha256(stdout), sourceDigests: { code: codeSha256 } });
  const Outcome = z.object({ status: z.enum(["ok", "policy", "error", "limit"]), violations: z.array(z.string()).optional(), type: z.string().optional(),
    message: z.string().optional(), motorAxisZ: z.number().optional() });
  const outcome = await readFile(join(out, "result.json"), "utf8").then(t => Outcome.parse(JSON.parse(t))).catch(() => undefined);
  // No result file means the process was stopped (CPU/wall limit, memory) before it could report.
  const status = exitCode === 0 && outcome?.status === "ok" ? "ok" : outcome?.status && outcome.status !== "ok" ? outcome.status : "limit";
  record.sandbox = { ...record.sandbox, status, violations: outcome?.violations, motorAxisZ: outcome?.motorAxisZ,
    error: status === "ok" ? undefined : status === "limit" ? outcome?.message ?? "超出沙箱资源或时间上限（CPU 60 s、内存 3 GiB、墙钟 120 s）"
      : status === "policy" ? outcome?.violations?.join("；") : `${outcome?.type ?? "Error"}: ${outcome?.message ?? ""}`.slice(0, 600) };
  publish(requestId, { kind: "step", id: "cad-sandbox", label: "在隔离沙箱中运行生成代码", status: status === "ok" ? "done" : "failed", which: "candidate",
    detail: status === "ok" ? `BREP 实体 · 电机轴 z=${outcome?.motorAxisZ} mm` : record.sandbox.error?.slice(0, 160) });
  if (status !== "ok") {
    const code = { policy: "CAD_CODE_POLICY", error: "CAD_CODE_ERROR", limit: "CAD_CODE_LIMIT" }[status];
    throw new DomainError(code, `生成代码没有产生可检查的实体：${record.sandbox.error}`, 422);
  }
  record.files["candidate/generated.brep"] = sha256(await readFile(join(out, "generated.brep")));
}

/**
 * AgentCore sandbox transport: the job runs in a fresh microVM (new session) with no network route or credentials.
 * It builds and measures with the same native scripts; returned files are written only after their digests verify,
 * then the local review continues exactly as for a local candidate (EvalArc, lifecycle, feedback).
 */
const RemoteFile = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int(), base64: z.string() });
const RemoteJob = z.object({
  status: z.enum(["ok", "policy", "error", "limit"]), error: z.string().nullable().optional(), type: z.string().nullable().optional(), violations: z.array(z.string()).optional(),
  layers: z.object({ astPolicy: z.boolean(), processLockdown: z.boolean(), bubblewrap: z.boolean(), microvm: z.boolean() }),
  codeSha256: z.string(), motorAxisZ: z.number().optional(), brepSha256: z.string().optional(), version: z.string().optional(),
  checks: z.unknown().optional(), files: z.record(z.string(), RemoteFile).optional(),
}).passthrough();
async function buildRemote(config: Config, publish: LiveBus["publish"], record: CadReview, target: string, source: CadSource, codeSha256: string,
  requirements: CadRequirements, requestId: string) {
  record.sandbox = { codeSha256, isolation: ["agentcore-microvm-per-job", "no-network-route", "no-credentials", ...ISOLATION], status: "error", transport: "agentcore" };
  publish(requestId, { kind: "step", id: "cad-sandbox", label: "在 AgentCore 隔离 microVM 中运行生成代码", status: "running", which: "candidate" });
  const startedAt = new Date().toISOString();
  const raw = await invokeRuntime<unknown>(config.agentcoreSandboxArn!, { op: "cad-code", code: source.code, requirements, family: familyOf(record.request) }, { timeoutMs: 600_000 });
  const finishedAt = new Date().toISOString();
  const job = RemoteJob.parse(raw);
  if (job.codeSha256 !== codeSha256) throw new DomainError("CAD_SANDBOX_MISMATCH", "AgentCore sandbox ran different code", 502);
  record.receipts.push({ adapter: "agentcore-cad-sandbox", command: ["InvokeAgentRuntime", "cad-code", `image ${job.version ?? "?"}`], startedAt, finishedAt,
    exitCode: job.status === "ok" ? 0 : 1, stdoutSha256: sha256(JSON.stringify({ ...job, files: undefined })), sourceDigests: { code: codeSha256 } });
  const layers = job.layers;
  record.sandbox = { ...record.sandbox, status: job.status, violations: job.violations, motorAxisZ: job.motorAxisZ, layers,
    error: job.status === "ok" ? undefined : (job.status === "policy" ? job.violations?.join("；") : `${job.type ?? job.status}: ${job.error ?? ""}`)?.slice(0, 600) };
  publish(requestId, { kind: "step", id: "cad-sandbox", label: "在 AgentCore 隔离 microVM 中运行生成代码", status: job.status === "ok" ? "done" : "failed", which: "candidate",
    detail: job.status === "ok" ? `BREP 实体 · 电机轴 z=${job.motorAxisZ} mm · bubblewrap ${layers.bubblewrap ? "启用" : "未启用"}` : record.sandbox.error?.slice(0, 160) });
  if (job.status !== "ok") {
    const code = { policy: "CAD_CODE_POLICY", error: "CAD_CODE_ERROR", limit: "CAD_CODE_LIMIT" }[job.status];
    throw new DomainError(code, `生成代码没有产生可检查的实体：${record.sandbox.error}`, 422);
  }
  if (!layers.microvm) throw new DomainError("CAD_SANDBOX_UNVERIFIED", "AgentCore sandbox did not report a microVM boundary", 502);
  const files = job.files ?? {};
  for (const name of [...CAD_FILES, ...Object.keys(files).filter(n => /^stages\/\d{2}-[a-z-]+\.glb$/.test(n))]) {
    const f = files[name];
    if (!f) throw new DomainError("CAD_SANDBOX_INCOMPLETE", `AgentCore sandbox did not return ${name}`, 502);
    const data = Buffer.from(f.base64, "base64");
    if (data.length !== f.bytes || sha256(data) !== f.sha256) throw new DomainError("CAD_SANDBOX_DIGEST", `${name} digest mismatch`, 502);
    if (name.startsWith("stages/")) await mkdir(join(target, "stages"), { recursive: true, mode: 0o700 });
    await writeFile(join(target, name), data, { mode: 0o600 });
  }
  record.files["candidate/generated.brep"] = job.brepSha256!;
  const stages = Object.keys(files).filter(n => n.startsWith("stages/")).sort();
  record.stages = { ...record.stages, candidate: stages.map((file, i) => ({ index: i + 1, id: file.slice(10, -4), label: i === 0 ? "生成代码的实体" : "装配检查：NEMA 17 电机",
    file, sha256: files[file].sha256, objects: i === 0 ? ["Bracket"] : ["Bracket", "NEMA 17 motor"] })) };
  for (const s of record.stages.candidate!) publish(requestId, { kind: "stage", which: "candidate", index: s.index, id: s.id, label: s.label, objects: s.objects,
    url: `/api/cad/${record.id}/stages/candidate/${s.index}`, sha256: s.sha256 });
}

/**
 * Generated code is refused before any record exists: no sandbox means no execution, and a policy violation never
 * reaches the sandbox. Call before reviewCad (which must claim its request before its first await).
 */
export async function precheckCad(store: Store, config: Config, input: unknown) {
  const request = CadRequest.parse(input);
  if (request.variant !== "generated" || store.requestRun(request.requestId) || !config.cadquery) return;
  const status = await sandboxStatus(config);
  if (!status.available) throw new DomainError("CAD_SANDBOX_UNAVAILABLE", `生成代码需要 OS 沙箱：${status.reason}`, 503);
  const violations = await checkCadCode(config, request.source!.code);
  if (violations.length) throw new DomainError("CAD_CODE_POLICY", `代码不符合沙箱策略：${violations.slice(0, 5).join("；")}`, 422);
}

export async function reviewCad(store: Store, config: Config, project: Project, input: unknown, live?: LiveBus): Promise<CadReview> {
  const request = CadRequest.parse(input);
  const publish: LiveBus["publish"] = (key, event) => live?.publish(key, event);
  if (!config.cadquery) throw new DomainError("CAD_NOT_CONFIGURED", "Set PAI_CADQUERY_PYTHON to a pinned CadQuery interpreter (npm run setup:cad)", 503);
  const cadqueryPython = config.cadquery;
  // Fail closed: frozen structural requirements are never silently skipped.
  if (request.requirements.structural && (!config.physicsPython || !config.ccx)) {
    throw new DomainError("FEA_NOT_CONFIGURED", "Structural requirements need the pinned FEA toolchain (npm run setup:physics: PAI_PHYSICS_PYTHON, PAI_CCX)", 503);
  }
  const generated = request.variant === "generated" ? request.source! : undefined;
  if (request.fromSweep && !store.requestRun(request.requestId)) {
    // Provenance must be true: the sweep is this project's, completed, and measured exactly these parameters.
    const sweep = store.get<{ projectId: string; state: string; result?: { points: { index: number; parameters: unknown }[] } }>("cad-sweep", request.fromSweep.sweepId);
    const point = sweep?.result?.points.find(p => p.index === request.fromSweep!.point);
    if (!sweep || sweep.projectId !== project.id || sweep.state !== "completed" || !point || canonical(point.parameters) !== canonical(request.parameters)) {
      throw new DomainError("INVALID_SWEEP_POINT", "fromSweep must reference a measured point of a completed sweep of this project with identical parameters", 422);
    }
  }
  if (request.fromOptimize && !store.requestRun(request.requestId)) {
    const run = store.get<{ projectId: string; state: string; request: { requirements: unknown }; result?: { points: { index: number; fidelity: string; parameters: unknown }[] } }>("cad-optimize", request.fromOptimize.optimizeId);
    const point = run?.result?.points.find(p => p.index === request.fromOptimize!.point);
    if (!run || run.projectId !== project.id || run.state !== "completed" || !point || point.fidelity !== "fea"
        || canonical(point.parameters) !== canonical(request.parameters) || canonical(run.request.requirements) !== canonical(request.requirements)) {
      throw new DomainError("INVALID_OPTIMIZE_POINT", "fromOptimize must reference a solved point of a completed optimisation of this project with identical parameters and requirements", 422);
    }
  }
  const record: CadReview = { id: randomUUID(), projectId: project.id, projectRevision: request.projectRevision, request,
    requirementDigest: sha256(canonical({ projectRequirements: project.requirements, cadRequirements: request.requirements })),
    state: "running", createdAt: new Date().toISOString(), feedbackId: request.feedbackId,
    receipts: [], sourceDigests: {}, files: {}, scope: "parametric-part-geometry", physicalValidation: false };
  const directory = join(config.state, "cad", record.id);
  return nativeRun({ store, live, project, kind: "cad-review", evidenceKind: "cad-part", request, record, failure: "CAD_FAILED",
    recheck: { message: "CAD recheck must bind the same feedback and unchanged part requirements", sameRequirements: original => canonical(original.request.requirements) === canonical(request.requirements) },
    work: async record => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const native = (file: string) => join(config.repository, "native", file);
      const family = familyOf(request);
      const script = native(FAMILY_SCRIPT[family]), lock = native("cadquery-requirements.txt");
      const structural = request.requirements.structural;
      const cam = request.requirements.dfm?.cam;
      if (cam && !camConfigured(config)) throw new DomainError("CAM_NOT_CONFIGURED", "CAM needs the pinned FreeCAD toolchain (npm run setup:cam) or the PAISolver CAM job", 503);
      const used = [...(request.requirements.dfm ? ["cad_dfm.py", "dfm-shop.json"] : []), ...(cam ? ["cam_part.py", "cam_verify.py", "cam-requirements.txt", ...(camRunner(config) === "batch" ? ["cam_remote.py", "cam_job.py"] : [])] : []), FAMILY_SCRIPT[family], ...(family === "nema17-bracket" ? ["cad_recipe.py"] : []), "cad_checks.py", ...(generated ? ["cad_code_policy.py", "cad_sandbox.py", "cad_generated.py", "cad_bearing.py"].filter(f => f !== FAMILY_SCRIPT[family]) : []),
        ...(structural ? [FAMILY_FEA[family].script, "fea_core.py"] : [])];
      const scriptDigests = async () => Object.fromEntries(await Promise.all(used.map(async f => [f.replace(/_/g, "-"), sha256(await readFile(native(f)))])));
      const adapters = new NativeAdapters(config);
      const scriptHash = sha256(await readFile(script));
      const scriptsBefore = await scriptDigests();
      const nativeBefore = await adapters.sourceDigests();
      const codeSha256 = generated ? sha256(generated.code) : undefined;
      record.sourceDigests = { ...nativeBefore, ...scriptsBefore, "cadquery-lock": sha256(await readFile(lock)), "cadquery-python": await toolDigest(config, "cad", cadqueryPython, async () => sha256(await readFile(cadqueryPython))),
        ...(structural ? { "physics-lock": sha256(await readFile(native("physics-requirements.txt"))), "ccx": await toolDigest(config, "physics", config.ccx!, async () => sha256(await readFile(config.ccx!))) } : {}),
        ...(codeSha256 ? { "generated-code": codeSha256 } : {}) };
      const remote = Boolean(generated && config.agentcoreSandboxArn);
      const runtime = generated && !remote ? await sandboxRuntime(config) : undefined;
      const bwrap = config.bwrap ?? "bwrap";
      // Reference and candidate are produced concurrently (each its own directory and native processes), like the aero
      // lane; both always settle before the record moves on, so a failure never races with the other part's writes.
      const cadquery = cadqueryPython;
      const ownReceipts = { baseline: [] as Receipt[], candidate: [] as Receipt[] };
      // The baseline is the family's reference design.
      const reference = family === "pillow-block" ? "pillow-block" : "reference";
      const parts = await Promise.allSettled(([["baseline", reference], ["candidate", request.variant]] as const).map(async ([name, variant]) => {
        const target = join(directory, name);
        // Receipts per part, merged in a fixed order (baseline, candidate) once both settle, so records are deterministic.
        const own = ownReceipts[name];
        const part = new Proxy(record, { get: (t, k) => k === "receipts" ? own : Reflect.get(t, k), set: (t, k, v) => k === "receipts" ? false : Reflect.set(t, k, v) });
        const label = `CadQuery ${name === "baseline" ? "基准零件" : "候选零件"}（${variant}）`;
        publish(request.requestId, { kind: "step", id: `cad-${name}`, label, status: "running", which: name });
        const input = join(directory, `${name}-input.json`);
        await writePrivate(input, JSON.stringify({ variant, family, requirements: request.requirements, ...(codeSha256 ? { codeSha256 } : {}),
          ...(variant === "parametric" ? { parameters: request.parameters } : {}) }));
        await mkdir(target, { recursive: true, mode: 0o700 });
        const sandboxed = Boolean(generated && name === "candidate");
        if (sandboxed && remote) {
          await buildRemote(config, publish, part, target, generated!, codeSha256!, request.requirements, request.requestId);
          publish(request.requestId, { kind: "step", id: `cad-${name}`, label, status: "done", which: name, detail: "AgentCore microVM" });
        } else if (sandboxed) await buildGenerated(config, publish, part, directory, runtime!, generated!, codeSha256!, request.requestId);
        let observed = Promise.resolve();
        const observe = (line: string) => {
          if (!line.startsWith("PAI_EVENT ")) return;
          observed = observed.then(async () => {
            const parsed = NativeEvent.safeParse((() => { try { return JSON.parse(line.slice(10)); } catch { return undefined; } })());
            if (!parsed.success || parsed.data.type !== "stage") return;
            const e = parsed.data;
            const digest = sha256(await readFile(join(target, e.file)));
            const stage: SceneStage = { index: e.index, id: e.id, label: e.label, file: e.file, sha256: digest, objects: e.objects };
            record.stages = { ...record.stages, [name]: [...(record.stages?.[name] ?? []), stage] };
            store.put("cad-review", record);
            publish(request.requestId, { kind: "stage", which: name, index: e.index, id: e.id, label: e.label, objects: e.objects,
              url: `/api/cad/${record.id}/stages/${name}/${e.index}`, sha256: digest });
          }).catch(() => { /* Presentation events never fail the native review. */ });
        };
        if (!(sandboxed && remote)) {
        const args = sandboxed
          ? sandboxArgs(config, runtime!, { readOnly: [input, join(directory, "candidate-src")], writable: [target] },
            [runtime!.python, "-I", "-W", "ignore", join(runtime!.native, "cad_generated.py"), "--input", input, "--source", join(directory, "candidate-src"), "--output", target])
          : ["-I", "-W", "ignore", script, "--input", input, "--output", target];
        const r = await runEngine(config, { engine: "cad", program: sandboxed ? bwrap : cadquery, args, cwd: config.repository,
          mounts: { read: [input, ...(sandboxed ? [join(directory, "candidate-src")] : [])], write: [target] }, timeoutMs: 180_000, onLine: observe, untrusted: sandboxed });
        await observed;
        await writePrivate(join(directory, `${name}.stdout.log`), r.stdout);
        await writePrivate(join(directory, `${name}.stderr.log`), r.stderr);
        own.push({ adapter: sandboxed ? "cadquery-sandbox-check" : "cadquery-native", command: sandboxed ? ["bwrap", "…", "python", "cad_generated.py"] : ["python", ...args], startedAt: r.startedAt, finishedAt: r.finishedAt,
          exitCode: r.exitCode, runtime: r.runtime, stdoutSha256: sha256(r.stdout),
          sourceDigests: sandboxed ? { script: scriptsBefore["cad-generated.py"], checks: scriptsBefore["cad-checks.py"] } : { script: scriptHash, checks: scriptsBefore["cad-checks.py"] } });
        publish(request.requestId, { kind: "step", id: `cad-${name}`, label, status: r.exitCode === 0 ? "done" : "failed", which: name, detail: `exit ${r.exitCode}` });
        store.put("cad-review", record);
        if (r.exitCode !== 0) throw new DomainError("CAD_FAILED", "Native CAD production failed; retain receipts and inspect local artifacts", 422);
        }
        const checks = CadChecks.parse(JSON.parse(await readFile(join(target, "checks.json"), "utf8")));
        if (checks.variant !== variant) throw new DomainError("CAD_CONTEXT", "Native CAD variant mismatch");
        if (canonical(checks.checks.map(c => c.id)) !== canonical(FAMILY_CHECKS[family])) throw new DomainError("CAD_CONTEXT", "Native CAD produced unexpected checks");
        if (structural) {
          const fea = await runFea(config, publish, part, request.requestId, name, target, checks, structural, family);
          checks.checks.push(...fea.checks);
          const { checks: _measured, ...summary } = fea;
          record.fea = { ...record.fea, [name]: summary };
        }
        record[name] = checks;
        const dfm = request.requirements.dfm;
        if (dfm) {
          publish(request.requestId, { kind: "step", id: `dfm-${name}`, label: `DFM：三轴铣削装夹、钻孔与单件成本（${name === "baseline" ? "基准" : "候选"}）`, status: "running", which: name });
          const r = await runEngine(config, { engine: "cad", program: cadquery, args: ["-I", "-W", "ignore", native("cad_dfm.py"), "--step", join(target, "part.step"), "--shop", native("dfm-shop.json"),
            "--requirements", JSON.stringify(dfm), "--output", join(target, "dfm.json")], cwd: config.repository, mounts: { write: [target] }, timeoutMs: 180_000 });
          own.push({ adapter: "cadquery-dfm", command: ["python", "cad_dfm.py"], startedAt: r.startedAt, finishedAt: r.finishedAt, exitCode: r.exitCode, runtime: r.runtime,
            stdoutSha256: sha256(r.stdout), sourceDigests: { script: sha256(await readFile(native("cad_dfm.py"))), shop: sha256(await readFile(native("dfm-shop.json"))) } });
          publish(request.requestId, { kind: "step", id: `dfm-${name}`, label: `DFM（${name === "baseline" ? "基准" : "候选"}）`, status: r.exitCode === 0 ? "done" : "failed", which: name,
            detail: (() => { try { const d = JSON.parse(r.stdout.trim().split("\n").at(-1)!); return `${d.setups.length} 次装夹（${d.setups.join("、")}）· 估算 ${d.unitCostEur} EUR · 加工 ${d.machiningMinutes} min`; } catch { return `exit ${r.exitCode}`; } })() });
          if (r.exitCode !== 0) throw new DomainError("DFM_FAILED", "Native DFM analysis failed; retain receipts", 422);
          const measured = z.object({ schema: z.literal("pai-dfm-1"), checks: z.array(z.object({ id: z.enum(DFM_CHECKS), passed: z.boolean() }).passthrough()).length(DFM_CHECKS.length) }).passthrough()
            .parse(JSON.parse(await readFile(join(target, "dfm.json"), "utf8")));
          checks.checks.push(...measured.checks as typeof checks.checks);
          if (dfm.cam) checks.checks.push(...await runCam(config, publish, part, request.requestId, name, target, dfm.cam) as typeof checks.checks);
        }
        const expected = [...FAMILY_CHECKS[family], ...(structural ? FAMILY_FEA_CHECKS[family] : []), ...(dfm ? DFM_CHECKS : []), ...(dfm?.cam ? CAM_CHECKS : [])];
        await writeFile(join(directory, name === "baseline" ? "baseline.xml" : "current.xml"), checksXml(checks, expected), { mode: 0o600, flag: "wx" });
        for (const file of [...CAD_FILES, ...(structural ? feaFiles(family) : []), ...(dfm ? ["dfm.json"] : [])]) record.files[`${name}/${file}`] = sha256(await readFile(join(target, file)));
        if (dfm?.cam) for (const f of await readdir(target)) if (CAM_FILE.test(f)) record.files[`${name}/${f}`] = sha256(await readFile(join(target, f)));
        if (structural) await readFile(join(target, "fea.png")).then(b => { record.files[`${name}/fea.png`] = sha256(b); }, () => undefined);
        store.put("cad-review", record);
      }));
      record.receipts.push(...ownReceipts.baseline, ...ownReceipts.candidate);
      const failedPart = parts.find((p): p is PromiseRejectedResult => p.status === "rejected");
      if (failedPart) throw failedPart.reason;
      publish(request.requestId, { kind: "step", id: "evalarc", label: "EvalArc 独立对照基准与候选零件", status: "running" });
      const diff = await adapters.diff(directory);
      publish(request.requestId, { kind: "step", id: "evalarc", label: "EvalArc 独立对照基准与候选零件", status: "done", detail: `blocking ${diff.value.blocking_changes}` });
      const lost = record.baseline!.checks.filter(c => c.passed && !record.candidate!.checks.find(n => n.id === c.id)!.passed).length;
      if (diff.value.blocking_changes !== lost || diff.value.gate_passed !== (lost === 0)) throw new DomainError("CAD_DIFF_MISMATCH", "Native CAD checks and independent comparison disagree");
      if (sha256(await readFile(script)) !== scriptHash || canonical(scriptsBefore) !== canonical(await scriptDigests())
          || canonical(nativeBefore) !== canonical(await adapters.sourceDigests())) {
        throw new DomainError("SOURCE_CHANGED", "Native verifier changed during CAD production");
      }
      record.diff = diff.value; record.receipts.push(diff.receipt);
      // The candidate is judged against the frozen requirements (as in every other lane); the baseline only anchors the
      // EvalArc comparison. A reference that misses a tightened requirement must not reject a candidate that meets it.
      return record.candidate!.checks.every(c => c.passed) ? "accepted-cad-part" : "rejected";
    } });
}

/** Native structural analysis of one built part: Gmsh mesh → CalculiX → measured deflection and stress. */
async function runFea(config: Config, publish: LiveBus["publish"], record: CadReview, requestId: string, name: "baseline" | "candidate",
  target: string, checks: CadChecks, structural: StructuralRequirements, family: CadFamily = "nema17-bracket") {
  const pillow = family === "pillow-block";
  // The bracket load sits on the motor bores, placed from the declared axis height; the pillow block finds its seat
  // and bolt bores on the mesh by cylinder fits, so it needs no declared parameters.
  const parameters = pillow ? {} : (checks as { parameters?: Record<string, number> }).parameters
    ?? (record.sandbox?.motorAxisZ !== undefined ? { motorAxisHeight: record.sandbox.motorAxisZ } : undefined);
  if (!pillow && !parameters?.motorAxisHeight) throw new DomainError("FEA_CONTEXT", "The part does not declare its motor axis height; FEA load cannot be placed", 422);
  const label = `CalculiX 结构分析：${name === "baseline" ? "基准零件" : "候选零件"}（Gmsh C3D10，两级网格${pillow ? "，轴承孔余弦载荷" : ""}）`;
  publish(requestId, { kind: "step", id: `fea-${name}`, label, status: "running", which: name });
  const input = join(target, "..", `${name}-fea-input.json`);
  const description = pillow ? `radial bearing load ${structural.direction}, cosine pressure over the loaded half of the seat; M8 bores fixed`
    : "radial pulley force, statically equivalent on the four M3 bores";
  await writePrivate(input, JSON.stringify({ step: join(target, "part.step"), parameters, ccx: enginePath(config, "physics", config.ccx!), requirements: structural,
    load: { forceN: structural.forceN, leverMm: structural.leverMm, ...(pillow ? { direction: structural.direction } : {}), description } }));
  const { script: file } = FAMILY_FEA[family];
  const script = join(config.repository, "native", file);
  const r = await runEngine(config, { engine: "physics", program: config.physicsPython!, args: ["-I", script, "--input", input, "--output", target],
    cwd: config.repository, mounts: { read: [input], write: [target] }, timeoutMs: 900_000 });
  await writePrivate(join(target, "..", `${name}.fea.stdout.log`), r.stdout);
  await writePrivate(join(target, "..", `${name}.fea.stderr.log`), r.stderr);
  record.receipts.push({ adapter: "calculix-fea", command: ["python", file], startedAt: r.startedAt, finishedAt: r.finishedAt,
    exitCode: r.exitCode, stdoutSha256: sha256(r.stdout), sourceDigests: { script: sha256(await readFile(script)), core: sha256(await readFile(join(config.repository, "native/fea_core.py"))),
      ccx: await toolDigest(config, "physics", config.ccx!, async () => sha256(await readFile(config.ccx!))) }, runtime: r.runtime });
  publish(requestId, { kind: "step", id: `fea-${name}`, label, status: r.exitCode === 0 ? "done" : "failed", which: name, detail: `exit ${r.exitCode}` });
  if (r.exitCode !== 0) throw new DomainError("FEA_FAILED", "Native FEA failed; retain receipts and inspect the solver log", 422);
  const fea = FeaResult.parse(JSON.parse(await readFile(join(target, "fea.json"), "utf8")));
  if (canonical(fea.checks.map(c => c.id)) !== canonical(FAMILY_FEA_CHECKS[family])) throw new DomainError("FEA_CONTEXT", "Native FEA produced unexpected checks");
  const expected = { forceN: structural.forceN, leverMm: structural.leverMm, ...(pillow ? { direction: structural.direction } : {}), description: fea.load.description };
  if (canonical(fea.load) !== canonical(expected)) throw new DomainError("FEA_CONTEXT", "FEA load differs from the frozen structural requirements");
  await renderResult(config, record, join(target, "fea.glb"), join(target, "fea.png"));
  return fea;
}

/**
 * CAM for one part: FreeCAD 1.1 CAM operations (ocp-freecad-cam) + OpenCAMLib raster write one G-code program per setup;
 * native/cam_verify.py then simulates material removal from the G-code alone (dexel height map) and reports gouges,
 * residual material, plunge overload, rapid collisions and cycle time. A part that cannot be programmed as designed
 * (exit 3: a hole without a free drill corridor) is a failed check, not a tool fault.
 */
/** Where CAM programs are generated: the PAISolver Batch job when configured (hosted), else the local FreeCAD venv. */
export const camRunner = (config: Config) => config.solverBatch?.camJobDefinition && config.physicsPython ? "batch" as const : config.camPython ? "local" as const : undefined;
export const camConfigured = (config: Config) => Boolean(camRunner(config) && config.cadquery);
async function runCam(config: Config, publish: LiveBus["publish"], record: CadReview, requestId: string, name: "baseline" | "candidate",
  target: string, req: z.infer<typeof CamRequirements>) {
  const native = (f: string) => join(config.repository, "native", f), who = name === "baseline" ? "基准" : "候选";
  publish(requestId, { kind: "step", id: `cam-${name}`, label: `CAM：FreeCAD 刀路 + 独立切削仿真（${who}）`, status: "running", which: name });
  const b = config.solverBatch;
  const gen = camRunner(config) === "batch"
    // Programs from one Batch job (FreeCAD in the PAISolver CAM image); files re-hashed against the job's result here.
    ? await runEngine(config, { engine: "cam", program: config.physicsPython!, args: ["-I", native("cam_remote.py"), "--step", join(target, "part.step"), "--dfm", join(target, "dfm.json"), "--output", target,
        "--queue", b!.queue, "--job-definition", b!.camJobDefinition!, "--bucket", b!.bucket, "--region", b!.region, "--run", record.id, "--name", name,
        "--timeout-seconds", "3600"], cwd: config.repository, mounts: { write: [target] }, timeoutMs: 3_900_000, network: "aws" })
    : await runEngine(config, { engine: "cam", program: config.camPython!, args: ["-I", native("cam_part.py"), "--step", join(target, "part.step"), "--dfm", join(target, "dfm.json"),
        "--shop", native("dfm-shop.json"), "--output", target], cwd: tmpdir(), mounts: { write: [target] }, timeoutMs: 1_800_000 });
  await writePrivate(join(target, "..", `${name}.cam.log`), `${gen.stdout}\n${gen.stderr}`);
  record.receipts.push({ adapter: camRunner(config) === "batch" ? "freecad-cam-batch" : "freecad-cam", command: ["python", camRunner(config) === "batch" ? "cam_remote.py" : "cam_part.py"], startedAt: gen.startedAt, finishedAt: gen.finishedAt, exitCode: gen.exitCode, runtime: gen.runtime,
    stdoutSha256: sha256(gen.stdout), sourceDigests: { script: sha256(await readFile(native("cam_part.py"))), lock: sha256(await readFile(native("cam-requirements.txt"))),
      shop: sha256(await readFile(native("dfm-shop.json"))) } });
  if (gen.exitCode === 3) {
    publish(requestId, { kind: "step", id: `cam-${name}`, label: `CAM（${who}）：按设计无法编程`, status: "failed", which: name });
    const why = gen.stderr.trim().split("\n").at(-1) ?? "not machinable as designed";
    return [{ id: "cam-toolpath", passed: false, observed: why, required: "verified program", unit: "", method: "FreeCAD CAM + OpenCAMLib; no program possible" },
      { id: "cycle-time", passed: false, observed: null, required: req.maxCycleMinutes, unit: "min", method: "no program" }];
  }
  if (gen.exitCode !== 0) throw new DomainError("CAM_FAILED", "Native CAM failed; retain receipts and inspect the log", 422);
  // Hosted: the simulation is its own Batch job (a separate container from the generator; the 2 vCPU host stays free).
  const ver = camRunner(config) === "batch"
    ? await runEngine(config, { engine: "cam", program: config.physicsPython!, args: ["-I", native("cam_remote.py"), "--verify", "--step", join(target, "part.step"), "--dfm", join(target, "dfm.json"), "--output", target,
        "--queue", b!.queue, "--job-definition", b!.camJobDefinition!, "--bucket", b!.bucket, "--region", b!.region, "--run", record.id, "--name", name,
        "--timeout-seconds", "3600"], cwd: config.repository, mounts: { write: [target] }, timeoutMs: 3_900_000, network: "aws" })
    : await runEngine(config, { engine: "cad", program: config.cadquery!, args: ["-I", "-W", "ignore", native("cam_verify.py"), "--step", join(target, "part.step"), "--cam", join(target, "cam.json"),
        "--shop", native("dfm-shop.json"), "--output", join(target, "cam-verify.json")], cwd: config.repository, mounts: { write: [target] }, timeoutMs: 1_800_000 });
  record.receipts.push({ adapter: camRunner(config) === "batch" ? "cam-dexel-verify-batch" : "cam-dexel-verify", command: ["python", camRunner(config) === "batch" ? "cam_remote.py --verify" : "cam_verify.py"], startedAt: ver.startedAt, finishedAt: ver.finishedAt, exitCode: ver.exitCode, runtime: ver.runtime,
    stdoutSha256: sha256(ver.stdout), sourceDigests: { script: sha256(await readFile(native("cam_verify.py"))) } });
  if (ver.exitCode !== 0) throw new DomainError("CAM_VERIFY_FAILED", "CAM verification could not run; retain receipts", 422);
  const v = z.object({ schema: z.literal("pai-cam-verify-1"), passed: z.boolean(), cycleMinutes: z.number(),
    checks: z.array(z.object({ id: z.string(), passed: z.boolean(), observed: z.unknown() }).passthrough()) }).passthrough()
    .parse(JSON.parse(await readFile(join(target, "cam-verify.json"), "utf8")));
  const failed = v.checks.filter(c => !c.passed).map(c => c.id);
  publish(requestId, { kind: "step", id: `cam-${name}`, label: `CAM（${who}）`, status: v.passed ? "done" : "failed", which: name,
    detail: `${v.passed ? "仿真无过切、无残料、无快移碰撞" : `未通过：${failed.join("、")}`} · 节拍 ${v.cycleMinutes} min` });
  return [{ id: "cam-toolpath", passed: v.passed, observed: failed.length ? failed : "verified", required: "no gouge, residual, overload or rapid collision", unit: "",
    method: "G-code simulated on a 0.1 mm dexel height map per setup (native/cam_verify.py), independent of FreeCAD" },
    { id: "cycle-time", passed: v.cycleMinutes <= req.maxCycleMinutes, observed: v.cycleMinutes, required: req.maxCycleMinutes, unit: "min",
      method: "Feed moves at programmed feeds + rapids at the shop rapid rate; no acceleration, tool change or loading time" }];
}

/**
 * Picture of a native result (vertex-coloured GLB → PNG) for visual review, rendered by native Blender when it is
 * configured. Presentation evidence: recorded by digest, never part of a verdict. A render failure is recorded and
 * leaves the review unaffected.
 */
export async function renderResult(config: Config, record: { receipts: Receipt[] }, glb: string, png: string) {
  if (!config.blender) return false;
  const script = join(config.repository, "native/render_glb.py");
  const r = await runEngine(config, { engine: "blender", program: config.blender, args: ["--background", "--factory-startup", "--disable-autoexec", "--python-exit-code", "2", "--python", script, "--", "--input", glb, "--output", png],
    cwd: config.repository, mounts: { read: [glb], write: [dirname(png)] }, timeoutMs: 180_000, gpu: "preferred" });
  await writePrivate(`${png}.log`, `${r.stdout}\n${r.stderr}`);
  record.receipts.push({ adapter: "blender-render", command: ["blender", "render_glb.py"], startedAt: r.startedAt, finishedAt: r.finishedAt, exitCode: r.exitCode, runtime: r.runtime,
    stdoutSha256: sha256(r.stdout), sourceDigests: { script: sha256(await readFile(script)), "blender-gpu": sha256(await readFile(join(config.repository, "native/blender_gpu.py"))) } });
  return r.exitCode === 0;
}

/** Layer 1 (static policy) as a fast pre-check; never executes the code. Returns the violations. */
export async function checkCadCode(config: Config, code: string): Promise<string[]> {
  const directory = join(config.state, "cad-policy");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, `${randomUUID()}.py`);
  await writePrivate(file, code);
  try {
    const r = await runEngine(config, { engine: "cad", program: config.cadquery ?? "python3", args: ["-I", join(config.repository, "native/cad_code_policy.py"), file],
      cwd: config.repository, mounts: { read: [file], write: [] }, timeoutMs: 15_000 });
    const out = z.object({ ok: z.boolean(), violations: z.array(z.string()) }).parse(JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}"));
    return out.violations;
  } finally { await rm(file, { force: true }); }
}
export const CAD_TEMPLATE_FILE = "native/cad_template.py";
export const CAD_TEMPLATES: Record<CadFamily, string> = { "nema17-bracket": CAD_TEMPLATE_FILE, "pillow-block": "native/cad_template_pillow.py" };
