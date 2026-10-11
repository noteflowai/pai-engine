import { runEngine } from "./kernel/engine-runtime.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writePrivate } from "./adapters.js";
import type { Config } from "./config.js";
import { Id, type Project, type Receipt } from "./contracts.js";
import { canonical, DomainError, sha256 } from "./domain.js";
import type { Store } from "./store.js";
import type { LiveBus } from "./live.js";
import { solverDataset } from "./dataset.js";
import { CAD_FAMILIES, CadParameters, CadRequirements, PillowParameters, structuralFits, type CadRequirements as CadReq } from "./cad.js";

/**
 * Physics-aware design optimisation (native/cad_optimize.py):
 * - a Gaussian-process surrogate and Optuna NSGA-II *rank* candidates;
 * - cheap B-Rep checks screen candidates before an expensive solve;
 * - CadQuery and CalculiX *measure* every reported point.
 *
 * Predictions are never evidence. The recommendation is the lightest measured feasible point, and it becomes an
 * ordinary parametric review (two-mesh FEA, baseline, EvalArc) with provenance to this record.
 */
export const MAX_OPTIMIZE_EVALUATIONS = 28;
export const OPTIMIZE_STRATEGIES = ["gp-nsga2", "botorch-qlognehvi"] as const;
/** Whether the optional BoTorch lock is installed in the physics venv (probed once per interpreter path). */
const botorchProbe = new Map<string, Promise<string | null>>();
export function botorchVersion(config: Config): Promise<string | null> {
  if (!config.physicsPython) return Promise.resolve(null);
  if (!botorchProbe.has(config.physicsPython)) {
    botorchProbe.set(config.physicsPython, runEngine(config.repository, { engine: "physics", program: config.physicsPython, args: ["-I", "-c", "import botorch; print(botorch.__version__)"], cwd: config.repository, mounts: { write: [] }, timeoutMs: 60_000 })
      .then(r => r.exitCode === 0 ? r.stdout.trim() : null).catch(() => null));
  }
  return botorchProbe.get(config.physicsPython)!;
}
export const OptimizeBudget = z.object({
  initial: z.number().int().min(4).max(16), rounds: z.number().int().min(1).max(4), perRound: z.number().int().min(2).max(4),
}).strict().refine(b => b.initial + b.rounds * b.perRound <= MAX_OPTIMIZE_EVALUATIONS, { message: `at most ${MAX_OPTIMIZE_EVALUATIONS} solver evaluations` });
export const DEFAULT_OPTIMIZE_BUDGET = { initial: 8, rounds: 3, perRound: 3 };
/** A design an AI planner proposes as a starting point, with its own first-principles estimate (scored later). */
/** Searched axes of the pillow block (native/cad_optimize.py FAMILIES); the rest of the recipe is fixed. */
export const PILLOW_OPT_BOUNDS = { width: [80, 120], depth: [14, 24], baseThickness: [6, 14], boltPitch: [54, 76] } as const;
const PillowAxes = z.object(Object.fromEntries(Object.entries(PILLOW_OPT_BOUNDS).map(([k, [lo, hi]]) => [k, z.number().min(lo).max(hi)])) as Record<keyof typeof PILLOW_OPT_BOUNDS, z.ZodNumber>).strict();
const BracketAxes = z.object({ thickness: CadParameters.shape.thickness, width: CadParameters.shape.width, plateHeight: CadParameters.shape.plateHeight }).strict();
export const OptimizeSeed = z.object({
  parameters: z.union([BracketAxes, PillowAxes]),
  expectedDeflectionMm: z.number().positive().max(10).optional(), expectedMassG: z.number().positive().max(10000).optional(),
  // Prose is clipped, not rejected; the numbers above are what gets scored.
  rationale: z.string().trim().transform(v => v.length > 400 ? `${v.slice(0, 399)}…` : v).optional(),
}).strict();
export const OptimizeRequest = z.object({
  requestId: Id, projectRevision: z.number().int().positive(),
  requirements: CadRequirements.refine(r => Boolean(r.structural), { message: "optimisation needs frozen structural requirements", path: ["structural"] }),
  budget: OptimizeBudget.default(DEFAULT_OPTIMIZE_BUDGET), seeds: z.array(OptimizeSeed).max(4).default([]),
  /** gp-nsga2: scikit-learn GPs + Optuna NSGA-II (default). botorch-qlognehvi: BoTorch constrained batch qLogNEHVI. */
  strategy: z.enum(OPTIMIZE_STRATEGIES).default("gp-nsga2"),
  /** Where solved points run: this host, or one AWS Batch job per point (default when configured). */
  solver: z.enum(["local", "batch"]).optional(),
  /** Reuse earlier solver measurements of the same recipe and load to train the surrogate (ranking only). */
  warmStart: z.boolean().default(true),
  /** Part family; the pillow block uses its own axes and bearing load case (gp-nsga2, on this host). */
  family: z.enum(CAD_FAMILIES).default("nema17-bracket"),
}).strict().superRefine((r, ctx) => {
  const pillow = r.family === "pillow-block";
  if (r.requirements.structural && !structuralFits(r.family, r.requirements.structural)) ctx.addIssue({ code: "custom", path: ["requirements", "structural"], message: `structural load case does not fit the ${r.family}` });
  r.seeds.forEach((s, i) => { if (!(pillow ? PillowAxes : BracketAxes).safeParse(s.parameters).success) ctx.addIssue({ code: "custom", path: ["seeds", i, "parameters"], message: `seed axes do not fit the ${r.family}` }); });
});

const Point = z.object({
  index: z.number().int(), origin: z.enum(["reference", "ai-seed", "initial", "screen", "exploit", "explore", "bo"]),
  remote: z.object({ jobId: z.string(), image: z.string().nullable().optional(), seconds: z.number().nullable().optional() }).strict().optional(),
  fidelity: z.enum(["geometry", "fea", "failed"]), parameters: z.union([CadParameters, PillowParameters]), boreDistortionMm: z.number().optional(),
  /** null: geometry-only screen that passed the B-Rep checks but was not solved (multi-fidelity prior). */
  feasible: z.boolean().nullable(), failed: z.array(z.string()), seconds: z.number(),
  mass: z.number().optional(), deflectionMm: z.number().optional(), stressMPa: z.number().optional(), minWallMm: z.number().optional(), holeEdgeMm: z.number().optional(),
  elements: z.number().int().optional(), error: z.string().optional(),
  checks: z.array(z.object({ id: z.string(), passed: z.boolean(), observed: z.unknown(), required: z.unknown() })).optional(),
  prediction: z.object({ deflectionMm: z.number(), deflectionSigmaLog: z.number(), stressMPa: z.number(), massG: z.number(), boreDistortionMm: z.number().optional() }).strict().optional(),
  estimate: z.object({ expectedDeflectionMm: z.number().optional(), expectedMassG: z.number().optional(), rationale: z.string().optional() }).strict().optional(),
}).strict();
export const OptimizeResult = z.object({
  schema: z.literal("pai-cad-optimize-1"), family: z.enum(CAD_FAMILIES).optional(), fixed: z.record(z.string(), z.number()).optional(), warmStart: z.object({ points: z.number().int(), extraRounds: z.number().int(), lightestPriorMassG: z.number().nullable() }).strict().nullable().optional(), optuna: z.string(), strategy: z.enum(OPTIMIZE_STRATEGIES).optional(), surrogate: z.string(), search: z.string(), requirements: CadRequirements,
  budget: z.object({ initial: z.number(), rounds: z.number(), perRound: z.number() }).strict(), axes: z.array(z.string()), bounds: z.record(z.string(), z.array(z.number())),
  points: z.array(Point).min(1).max(80), feasibleCount: z.number().int(), lightestFeasible: z.number().int().nullable(), pareto: z.array(z.number().int()),
  rounds: z.array(z.object({ round: z.number().int(), trainedOn: z.number().int(), looMeanAbsError: z.record(z.string(), z.number()),
    surrogateTrials: z.number().int(), screenedGeometry: z.number().int(), proposed: z.array(z.number().int()), skipped: z.string().optional() }).strict()),
  calibration: z.array(z.object({ index: z.number().int(), predicted: z.number(), measured: z.number(), relativeError: z.number() }).strict()),
  aiSeeds: z.array(z.object({ index: z.number().int(), expected: z.number().nullable().optional(), measured: z.number().nullable().optional(), relativeError: z.number().nullable() }).strict()),
  scope: z.literal("parametric-part-geometry-and-linear-static-fea"), physicalValidation: z.literal(false), limits: z.string(),
}).strict();
export type OptimizePoint = z.infer<typeof Point>;
export interface CadOptimization {
  id: string; projectId: string; projectRevision: number; request: z.infer<typeof OptimizeRequest>; requirementDigest: string;
  state: "running" | "completed" | "failed" | "interrupted"; error?: string; createdAt: string; finishedAt?: string;
  result?: z.infer<typeof OptimizeResult>; receipts: Receipt[]; sourceDigests: Record<string, string>; files: Record<string, string>;
  scope: "parametric-part-geometry-and-linear-static-fea"; physicalValidation: false;
  /** local: solved on this host; batch: one AWS Batch job per solved point (digests and tool versions checked). */
  solver?: "local" | "batch";
  /** Earlier solver measurements (same recipe and load) that trained the surrogate; they are not results of this run. */
  warmStart?: { points: number; sources: string[] };
}

export async function optimizeCad(store: Store, config: Config, project: Project, input: unknown, live?: LiveBus): Promise<CadOptimization> {
  const request = OptimizeRequest.parse(input);
  if (!config.cadquery || !config.physicsPython || !config.ccx) {
    throw new DomainError("PHYSICS_NOT_CONFIGURED", "Optimisation needs CadQuery and the pinned physics toolchain (npm run setup:cad, npm run setup:physics)", 503);
  }
  const record: CadOptimization = { id: randomUUID(), projectId: project.id, projectRevision: request.projectRevision, request,
    requirementDigest: sha256(canonical({ projectRequirements: project.requirements, cadRequirements: request.requirements })),
    state: "running", createdAt: new Date().toISOString(), receipts: [], sourceDigests: {}, files: {},
    scope: "parametric-part-geometry-and-linear-static-fea", physicalValidation: false };
  const claimed = store.claim(request.requestId, sha256(canonical({ kind: "cad-optimize", projectId: project.id, request })), record, "cad-optimize");
  if (claimed !== record.id) return store.get<CadOptimization>("cad-optimize", claimed)!;
  const publish = (event: Parameters<LiveBus["publish"]>[1]) => live?.publish(request.requestId, event);
  publish({ kind: "record", recordKind: "cad-optimize", recordId: record.id });
  const directory = join(config.state, "cad-optimize", record.id);
  try {
    if (project.revision !== request.projectRevision) throw new DomainError("REVISION_CONFLICT", "Freeze the current requirement revision");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const native = (f: string) => join(config.repository, "native", f);
    const pillow = request.family === "pillow-block";
    const scripts = ["cad_optimize.py", "cad_point.py", "fea_core.py", pillow ? "fea_pillow.py" : "fea_bracket.py", pillow ? "cad_bearing.py" : "cad_recipe.py", "cad_checks.py"];
    const digests = async () => Object.fromEntries(await Promise.all(scripts.map(async f => [f.replace(/_/g, "-"), sha256(await readFile(native(f)))])));
    const before = await digests();
    // Warm start from the solver dataset: same recipe (pilot bore 22.5 mm), same load and lever, fine-mesh FEA.
    const s = request.requirements.structural!;
    // The solver dataset holds bracket measurements only; the pillow block starts cold.
    const rows = request.warmStart && !pillow ? solverDataset(store).data.filter(r => r.domain === "structural-fea" && r.inputs.forceN === s.forceN && r.inputs.leverMm === s.leverMm
      && r.inputs.pilotBore === 22.5 && Number.isFinite(r.outputs.stressMPa) && r.outputs.deflectionMm > 0) : [];
    const seen = new Set<string>();
    const prior = rows.filter(r => { const k = `${r.inputs.thickness}:${r.inputs.width}:${r.inputs.plateHeight}`; return !seen.has(k) && (seen.add(k), true); })
      .slice(-60).map(r => ({ parameters: { thickness: r.inputs.thickness, width: r.inputs.width, plateHeight: r.inputs.plateHeight },
        deflectionMm: r.outputs.deflectionMm, stressMPa: r.outputs.stressMPa, mass: r.outputs.massG,
        ...(Number.isFinite(r.outputs.minWallMm) && Number.isFinite(r.outputs.holeEdgeMm) ? { minWallMm: r.outputs.minWallMm, holeEdgeMm: r.outputs.holeEdgeMm } : {}), source: r.recordId }));
    record.warmStart = { points: prior.length, sources: [...new Set(prior.map(p => p.source))] };
    const solver = request.solver ?? (config.solverBatch ? "batch" : "local");
    if (solver === "batch" && !config.solverBatch) throw new DomainError("SOLVER_NOT_CONFIGURED", "AWS Batch solver is not configured (PAI_SOLVER_QUEUE, PAI_SOLVER_JOB_DEFINITION, PAI_SOLVER_BUCKET)", 503);
    record.solver = solver;
    if (request.strategy === "botorch-qlognehvi" && !(await botorchVersion(config))) {
      throw new DomainError("BOTORCH_NOT_CONFIGURED", "BoTorch is not installed in the physics toolchain (npm run setup:physics -- --with-botorch)", 503);
    }
    record.sourceDigests = { ...before, ...(solver === "batch" ? { "solver-job.py": sha256(await readFile(native("solver_job.py"))), "solver-lock": sha256(await readFile(native("solver-requirements.txt"))) } : {}),
      ...(request.strategy === "botorch-qlognehvi" ? { "botorch-lock": sha256(await readFile(native("bo-requirements.txt"))) } : {}),
      "physics-lock": sha256(await readFile(native("physics-requirements.txt"))), "cadquery-lock": sha256(await readFile(native("cadquery-requirements.txt"))),
      ccx: sha256(await readFile(config.ccx)) };
    const inputFile = join(directory, "input.json");
    await writePrivate(inputFile, JSON.stringify({ family: request.family, cadquery: config.cadquery, ccx: config.ccx, requirements: request.requirements, budget: request.budget, seeds: request.seeds, strategy: request.strategy, parallel: 2, prior,
      ...(solver === "batch" ? { backend: "batch", batch: { ...config.solverBatch!, run: record.id, timeoutSeconds: 1800 } } : {}) }));
    const total = request.budget.initial + 1 + request.budget.rounds * request.budget.perRound;
    publish({ kind: "step", id: "optimize", label: `物理寻优：约 ${total} 次 CalculiX 求解 + 代理模型排序`, status: "running" });
    const observe = (line: string) => {
      if (!line.startsWith("PAI_EVENT ")) return;
      try {
        const e = JSON.parse(line.slice(10)) as { type?: string; phase?: string; index?: number; origin?: string; mass?: number; deflectionMm?: number; failed?: string[]; fidelity?: string; parameters?: Record<string, number>; trainedOn?: number };
        if (e.type === "phase") publish({ kind: "step", id: `phase-${e.phase}`, label: e.phase === "initial" ? "初始设计：参考件 + AI 种子 + Sobol 点" : `第 ${e.phase?.split("-")[1]} 轮：代理模型（${e.trainedOn} 个实测点训练）→ ${request.strategy === "botorch-qlognehvi" ? "BoTorch qLogNEHVI 批量采集" : "NSGA-II 排序"}`, status: "done" });
        if (e.type !== "point") return;
        const p = e.parameters!;
        publish({ kind: "step", id: `opt-point-${e.index}`, label: `${e.origin} · ${pillow ? `W=${p.width} · D=${p.depth} · 底座 ${p.baseThickness} · 孔距 ${p.boltPitch}` : `t=${p.thickness} · W=${p.width} · H=${p.plateHeight}`}${e.fidelity === "geometry" ? "（几何筛除）" : ""}`,
          status: e.failed?.length ? "failed" : "done", detail: `${e.mass ?? "—"} g${e.deflectionMm !== undefined ? ` · ${e.deflectionMm} mm` : ""}${e.failed?.length ? ` · ${e.failed.join(", ")}` : " · 全部通过"}` });
      } catch { /* Presentation only. */ }
    };
    const args = ["-I", native("cad_optimize.py"), "--input", inputFile, "--output", directory];
    const r = await runEngine(config.repository, { engine: "physics", program: config.physicsPython, args, cwd: config.repository, mounts: { read: [inputFile], write: [directory] },
      timeoutMs: Math.max(600_000, total * 120_000), onLine: observe });
    await writePrivate(join(directory, "stdout.log"), r.stdout); await writePrivate(join(directory, "stderr.log"), r.stderr);
    record.receipts.push({ adapter: "cad-optimize", command: ["python", "cad_optimize.py"], startedAt: r.startedAt, finishedAt: r.finishedAt,
      exitCode: r.exitCode, stdoutSha256: sha256(r.stdout), sourceDigests: before });
    if (r.exitCode !== 0) throw new DomainError("CAD_OPTIMIZE_FAILED", "Native optimisation failed; retain receipts and inspect local artifacts", 422);
    const text = await readFile(join(directory, "optimize.json"), "utf8");
    const result = OptimizeResult.parse(JSON.parse(text));
    if (canonical(result.requirements) !== canonical(request.requirements) || (result.family ?? "nema17-bracket") !== request.family) throw new DomainError("CAD_OPTIMIZE_CONTEXT", "Optimisation output does not match the request");
    // Recompute the summary from the measured points: the native summary is not trusted on its own.
    const solved = result.points.filter(p => p.fidelity === "fea");
    const recomputed = solved.filter(p => p.feasible).sort((a, b) => a.mass! - b.mass! || a.index - b.index)[0]?.index ?? null;
    if (recomputed !== result.lightestFeasible || result.points.some(p => (p.feasible === null
        // Unsolved geometry-only screens (the BoTorch multi-fidelity prior) are neither feasible nor infeasible.
        ? p.fidelity !== "geometry" || p.failed.length > 0
        : p.feasible !== (p.failed.length === 0) || (p.feasible && p.fidelity !== "fea")))) {
      throw new DomainError("CAD_OPTIMIZE_INCONSISTENT", "Optimisation summary disagrees with its measured points");
    }
    if (canonical(await digests()) !== canonical(before)) throw new DomainError("SOURCE_CHANGED", "Native optimisation scripts changed during the run");
    record.files["optimize.json"] = sha256(text);
    record.result = result;
    record.state = "completed";
    publish({ kind: "step", id: "optimize", label: `物理寻优：约 ${total} 次 CalculiX 求解 + 代理模型排序`, status: "done",
      detail: `${result.feasibleCount} 个实测可行点${result.lightestFeasible ? ` · 最轻 #${result.lightestFeasible}` : ""}` });
  } catch (e) {
    record.state = "failed";
    record.error = e instanceof DomainError ? `${e.code}: ${e.message}` : "CAD_OPTIMIZE_FAILED: check native configuration and retained local receipts";
  }
  record.finishedAt = new Date().toISOString();
  store.put("cad-optimize", record);
  publish({ kind: "done", state: record.state, recordId: record.id, detail: record.error });
  return record;
}

/** A formal parametric review request for one measured, solved optimisation point. */
export function optimizePointRequest(run: CadOptimization, index: number, requestId: string, revision: number) {
  const point = run.result?.points.find(p => p.index === index);
  if (!point || point.fidelity !== "fea") throw new DomainError("NOT_FOUND", "Solved optimisation point not found", 404);
  return { requestId, projectRevision: revision, variant: "parametric" as const, requirements: run.request.requirements as CadReq,
    parameters: point.parameters, ...(run.request.family === "pillow-block" ? { family: "pillow-block" as const } : {}), fromOptimize: { optimizeId: run.id, point: index } };
}
