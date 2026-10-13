/**
 * Third artifact family: structural surrogates, i.e. learned models that predict a part's FEA results from its geometry
 * (ADR 0001; first of kind "model").
 *
 * A version packages a model trained by native/surrogate_train.py on a dataset measured by native/surrogate_dataset.py
 * (every row a CadQuery + Gmsh + CalculiX run on AWS Batch, with digests and pinned versions). Build checks the chain:
 * dataset rows -> features -> weights -> benchmark, and that the packaged scripts are the ones that trained.
 * Acceptance re-runs the shipped weights on the shipped held-out rows and gates on rank correlation, relative error and
 * conformal coverage. Predictions are suggestions: they rank or screen candidates; the native solver decides, and a part
 * outside the training domain is flagged instead of predicted with false confidence.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writePrivate } from "../adapters.js";
import type { Config } from "../config.js";
import { DomainError, sha256 } from "../domain.js";
import { runEngine, startWorker, type Engine, type EngineWorker } from "../kernel/engine-runtime.js";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { ArtifactAdapter, ArtifactManifest, OperationResult, RunContext } from "./contract.js";
import { lockVersions, materialise, sourceCommit } from "./native-artifact.js";

/** Acceptance gate, fixed before any benchmark result was seen (2026-10-12 proposal); mass is near-geometric, so stricter. */
export const SURROGATE_GATE = {
  deflectionMm: { minSpearman: 0.9, maxMedianRelError: 0.1 }, stressMPa: { minSpearman: 0.9, maxMedianRelError: 0.1 },
  mass: { minSpearman: 0.95, maxMedianRelError: 0.05 }, minConformalCoverage: 0.8,
} as const;
const TARGETS = ["deflectionMm", "stressMPa", "mass"] as const;
const MAX_STEP_BYTES = 8_000_000;

export const PartGeometry = z.object({ schema: z.literal("pai-part-geometry-1"), family: z.enum(["nema17-bracket", "pillow-block"]),
  stepBase64: z.string().min(16).max(Math.ceil(MAX_STEP_BYTES * 4 / 3) + 4), label: z.string().max(200).optional() }).strict();
const Range = z.tuple([z.number(), z.number()]);
export const SurrogatePrediction = z.object({ schema: z.literal("pai-surrogate-prediction-1"), deflectionMm: z.number(), stressMPa: z.number(), mass: z.number(),
  sigmaLog: z.record(z.string(), z.number()), interval90: z.object({ deflectionMm: Range, stressMPa: Range, mass: Range }).strict(),
  inDomain: z.boolean(), outsideDomain: z.array(z.string()), ms: z.number(), authority: z.literal("suggestion") }).strict();
const Metrics = z.record(z.string(), z.object({ spearman: z.number().nullable(), medianRelError: z.number(), p90RelError: z.number(), maxRelError: z.number() }).strict());
const Evaluation = z.object({ schema: z.literal("pai-surrogate-evaluation-1"), heldOut: z.number(), metrics: Metrics, conformal90Coverage: z.record(z.string(), z.number()),
  weightsSha256: z.string() }).strict();
const SCHEMAS: Record<string, z.ZodType> = { "pai-part-geometry-1": PartGeometry, "pai-surrogate-prediction-1": SurrogatePrediction };
const issues = (r: { success: boolean; error?: z.ZodError }) => r.success ? [] : r.error!.issues.slice(0, 8).map(i => `${i.path.join(".") || "(root)"}: ${i.message}`);
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** The gate applied to an evaluation; returns the failed criteria (empty = admitted). */
export function surrogateGate(ev: { metrics: Record<string, { spearman: number | null; medianRelError: number }>; conformal90Coverage: Record<string, number> }) {
  const failed: string[] = [];
  for (const k of TARGETS) {
    const m = ev.metrics[k], g = SURROGATE_GATE[k];
    if (!m || m.spearman === null || m.spearman < g.minSpearman) failed.push(`${k}: Spearman ${m?.spearman ?? "n/a"} < ${g.minSpearman}`);
    if (!m || m.medianRelError > g.maxMedianRelError) failed.push(`${k}: median relative error ${m?.medianRelError} > ${g.maxMedianRelError}`);
    if ((ev.conformal90Coverage[k] ?? 0) < SURROGATE_GATE.minConformalCoverage) failed.push(`${k}: 90 % interval coverage ${ev.conformal90Coverage[k]} < ${SURROGATE_GATE.minConformalCoverage}`);
  }
  return failed;
}

async function step(ctx: RunContext, engine: Engine, program: string, args: string[], timeoutMs: number) {
  const t0 = Date.now();
  const r = await runEngine(ctx.config, { engine, program, args, cwd: ctx.directory, mounts: { write: [ctx.directory] }, timeoutMs });
  return { r, receipt: { command: ["python", args.find(a => a.endsWith(".py"))?.split("/").at(-1) ?? "?", ...args.filter(a => !a.startsWith("/") && !a.endsWith(".py"))],
    exitCode: r.exitCode, stdoutSha256: sha256(r.stdout + r.stderr), seconds: (Date.now() - t0) / 1000, runtime: r.runtime } };
}
const lastJson = (s: string) => JSON.parse(s.trim().split("\n").at(-1) ?? "{}");

/**
 * Resident inference (featurize in the cad engine, ensemble in the physics engine), one pair per artifact version,
 * started on first use and closed after 15 idle minutes. The workers run the artifact's own modules
 * (native/engine_worker.py imports them from the materialised, digest-checked bytes), so a resident prediction is
 * byte-identical to a one-shot one; any worker fault ends that pair and the request falls back to the one-shot path.
 */
const IDLE_MS = 15 * 60_000;
type Pair = { feat: EngineWorker; pred: EngineWorker; code: string; scratch: string; timer?: NodeJS.Timeout };
const pool = new Map<string, Promise<Pair>>();
async function pairFor(ctx: RunContext): Promise<Pair> {
  const key = sha256(JSON.stringify([ctx.manifest.name, ctx.manifest.version, ctx.manifest.files]));
  const have = pool.get(key);
  if (have) { const p = await have.catch(() => undefined); if (p && p.feat.alive() && p.pred.alive()) return touch(key, p); pool.delete(key); p?.feat.close(); p?.pred.close(); }
  const made = (async () => {
    const base = join(ctx.config.state, "surrogate", "serve", key.slice(0, 16));
    const code = await materialise({ ...ctx, directory: base }), scratch = join(base, "requests");
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const worker = join(ctx.config.repository, "native", "engine_worker.py");
    const feat = await startWorker(ctx.config, { engine: "cad", program: ctx.config.cadquery!, args: ["-I", "-W", "ignore", worker, "--code", code, "--module", "surrogate_featurize"],
      cwd: scratch, mounts: { read: [code], write: [scratch] } });
    const pred = await startWorker(ctx.config, { engine: "physics", program: ctx.config.physicsPython!, args: ["-I", worker, "--code", code, "--module", "surrogate_train",
      "--entry", "predict", "--cache", "load"], cwd: scratch, mounts: { read: [code], write: [scratch] } }).catch(e => { feat.close(); throw e; });
    return touch(key, { feat, pred, code, scratch });
  })();
  pool.set(key, made);
  made.catch(() => pool.delete(key));
  return made;
}
function touch(key: string, p: Pair) {
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(() => { p.feat.close(); p.pred.close(); pool.delete(key); }, IDLE_MS);
  p.timer.unref();
  return p;
}
type Reply = { ok: boolean; stdout?: string; error?: string };
/** Resident prediction; undefined means "use the one-shot path" (no worker, or the worker failed). */
async function residentPredict(ctx: RunContext, bytes: Buffer) {
  let pair: Pair;
  try { pair = await pairFor(ctx); } catch { return undefined; }
  const dir = join(pair.scratch, randomUUID());
  await mkdir(dir, { mode: 0o700 });
  try {
    const stepFile = join(dir, "part.step"), feats = join(dir, "part.npz");
    await writePrivate(stepFile, bytes);
    const t0 = Date.now();
    const f = await pair.feat.request<Reply>({ argv: ["--step", stepFile, "--output", feats] }, 60_000);
    const t1 = Date.now();
    const receipt = (label: string, r: Reply, w: EngineWorker, from: number, to: number) => ({ command: ["worker", label], exitCode: r.ok ? 0 : 1,
      stdoutSha256: sha256(r.stdout ?? r.error ?? ""), seconds: (to - from) / 1000, runtime: w.runtime });
    if (!f.ok) return { failed: "featurize failed (the STEP did not tessellate)", receipts: [receipt("surrogate_featurize.py", f, pair.feat, t0, t1)] };
    const p = await pair.pred.request<Reply>({ namespace: { weights: join(pair.code, "weights.pt"), features: feats, domain: join(pair.code, "domain.json") } }, 30_000);
    const receipts = [receipt("surrogate_featurize.py", f, pair.feat, t0, t1), receipt("surrogate_train.py predict", p, pair.pred, t1, Date.now())];
    if (!p.ok) return { failed: "prediction failed", receipts };
    return { prediction: SurrogatePrediction.parse(lastJson(p.stdout ?? "")), receipts, ms: Date.now() - t0 };
  } catch {
    pair.feat.close(); pair.pred.close();
    return undefined;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

export function structuralSurrogate(family: "nema17-bracket" | "pillow-block"): ArtifactAdapter {
  const short = family === "pillow-block" ? "pillow" : "bracket";
  const id = `structural-surrogate-${short}`, dataset = `fea-${short}-v1`;
  const title = family === "pillow-block" ? "轴承座结构代理模型：由几何预测受载失圆前的挠度、应力与质量" : "电机支架结构代理模型：由几何预测挠度、应力与质量";
  return {
    id,
    params: { predict: z.object({}).strict() },
    schemas: Object.keys(SCHEMAS),
    validateData: (schemaId, value) => SCHEMAS[schemaId] ? issues(SCHEMAS[schemaId].safeParse(value)) : [`unknown schema ${schemaId}`],

    async build(config, version, actor) {
      const native = (f: string) => readFile(join(config.repository, "native", f));
      const model = join(config.state, "surrogate", "models", dataset), data = join(config.state, "surrogate", "datasets", dataset);
      const read = (p: string) => readFile(p).catch(() => { throw new DomainError("SURROGATE_NOT_TRAINED", `${dataset}: ${p.split("/").slice(-2).join("/")} is missing (tools/hosted_surrogate_train.sh)`, 409); });
      const files: Record<string, Buffer> = {
        "surrogate_featurize.py": await native("surrogate_featurize.py"), "surrogate_train.py": await native("surrogate_train.py"),
        "bo-requirements.txt": await native("bo-requirements.txt"), "cadquery-requirements.txt": await native("cadquery-requirements.txt"),
        "weights.pt": await read(join(model, "weights.pt")), "heldout.npz": await read(join(model, "heldout.npz")), "domain.json": await read(join(model, "domain.json")),
        "training-benchmark.json": await read(join(model, "benchmark.json")), "dataset-manifest.json": await read(join(data, "manifest.json")),
        "dataset-rows.jsonl": await read(join(data, "rows.jsonl")), "dataset-spec.json": await read(join(data, "spec.json")),
      };
      // The chain must hold: rows -> manifest -> weights -> benchmark, trained by exactly the packaged scripts.
      const bench = JSON.parse(files["training-benchmark.json"].toString()), man = JSON.parse(files["dataset-manifest.json"].toString());
      const broken = [hash(files["dataset-rows.jsonl"]) !== man.rowsSha256 && "rows.jsonl differs from the dataset manifest",
        bench.rowsSha256 !== man.rowsSha256 && "the model was trained on other rows", hash(files["weights.pt"]) !== bench.weightsSha256 && "weights differ from the training report",
        bench.scripts?.["surrogate_train.py"] !== hash(files["surrogate_train.py"]) && "surrogate_train.py differs from the one that trained",
        bench.scripts?.["surrogate_featurize.py"] !== hash(files["surrogate_featurize.py"]) && "surrogate_featurize.py differs from the one that trained",
        man.family !== family && `dataset family ${man.family}`].filter(Boolean);
      if (broken.length) throw new DomainError("SURROGATE_PROVENANCE", broken.join("; "), 409);
      const bo = lockVersions(files["bo-requirements.txt"].toString()), cq = lockVersions(files["cadquery-requirements.txt"].toString());
      const manifest: ArtifactManifest = {
        schema: "pai-artifact-1", name: id, version, kind: "model", adapter: id, title,
        description: `Learned structural surrogate for the ${family} family: from the part's geometry alone (2048 surface points with normals, surface area, `
          + `volume, extents; no recipe parameters) to max deflection, max von Mises stress and mass under the family's load case, with conformal 90 % `
          + `intervals and an out-of-domain flag. Trained on ${man.measured} CalculiX measurements (dataset ${dataset}, rows ${String(man.rowsSha256).slice(0, 12)}…). `
          + "Predictions rank and screen only; every decision is measured by the native solver.",
        operations: [{ id: "predict", description: "Featurize the STEP (CadQuery/OCCT tessellation, seeded by its digest) and run the deep ensemble; prediction, interval, domain check",
          inputs: { geometry: "pai-part-geometry-1" }, outputs: { prediction: "pai-surrogate-prediction-1" }, effects: "none" }],
        capabilities: ["geometry-only input (works without recipe parameters)", "deflection, stress and mass", "conformal 90 % intervals",
          "out-of-domain flag", "bit-reproducible CPU inference", "held-out acceptance re-check"],
        limits: { maxStepBytes: MAX_STEP_BYTES, trainRows: bench.train, heldOutRows: bench.heldOut },
        runtime: { python: "3.12", lock: "bo-requirements.txt", entrypoints: { featurize: "surrogate_featurize.py", predict: "surrogate_train.py" } },
        dependencies: [{ name: "torch", version: bo.torch, license: "BSD-3-Clause", source: `https://pypi.org/project/torch/${bo.torch}/`, role: "runtime" },
          { name: "cadquery", version: cq.cadquery, license: "Apache-2.0", source: `https://pypi.org/project/cadquery/${cq.cadquery}/`, role: "library" },
          { name: "cadquery-ocp", version: cq["cadquery-ocp"], license: "Apache-2.0", source: `https://pypi.org/project/cadquery-ocp/${cq["cadquery-ocp"]}/`, role: "library" }],
        license: "MIT (artifact code and weights); dependencies under their own licences",
        provenance: { repository: "noteflowai/pai-engine", sourceCommit: sourceCommit(config.repository), builtAt: new Date().toISOString(), builtBy: actor },
        files: Object.fromEntries(Object.entries(files).map(([k, b]) => [k, sha256(b)])),
        scope: `The ${family} recipe family under its default load case, inside the trained geometry domain; synthetic designs, simulated (CalculiX) labels. `
          + "Not a solver: it never decides acceptance, and it is not physical validation.",
        physicalValidation: false,
      };
      return { manifest, files };
    },

    async runtimeReady(config: Config, manifest) {
      if (!config.physicsPython || !config.cadquery) return { ready: false, reason: "needs the physics (PyTorch) and CadQuery toolchains" };
      const want = manifest.dependencies.find(d => d.name === "torch")?.version;
      const r = await runEngine(config, { engine: "physics", program: config.physicsPython, args: ["-I", "-c", "import torch; print(torch.__version__)"], cwd: config.state, mounts: { write: [] }, timeoutMs: 60_000 }).catch(() => undefined);
      const have = r?.exitCode === 0 ? r.stdout.trim() : undefined;
      return have === want ? { ready: true } : { ready: false, reason: `runtime torch ${have ?? "unavailable"} differs from the artifact's pin ${want}` };
    },

    async run(ctx, operation, inputs): Promise<OperationResult> {
      if (operation !== "predict") throw new DomainError("UNKNOWN_OPERATION", `Operation ${operation} is not part of this artifact`, 422);
      const g = PartGeometry.parse(inputs.geometry);
      if (g.family !== family) throw new DomainError("SURROGATE_FAMILY", `This surrogate is for ${family}, not ${g.family}`, 422);
      const t0 = Date.now(), stepFile = join(ctx.directory, "part.step"), feats = join(ctx.directory, "part.npz");
      const bytes = Buffer.from(g.stepBase64, "base64");
      if (bytes.length > MAX_STEP_BYTES || !bytes.subarray(0, 64).toString("latin1").includes("ISO-10303-21")) throw new DomainError("SURROGATE_INPUT", "geometry is not a STEP file within the size limit", 422);
      const usage = (storage: number) => ({ cpuSeconds: null, maxRssKb: null, wallSeconds: (Date.now() - t0) / 1000, storageBytes: storage });
      const resident = await residentPredict(ctx, bytes);
      if (resident && "prediction" in resident && resident.prediction) {
        const prediction = resident.prediction;
        return { state: "ok", outputs: { prediction }, status: prediction.inDomain ? "in-domain" : "out-of-domain", receipts: resident.receipts, usage: usage(Buffer.byteLength(JSON.stringify(prediction))) };
      }
      if (resident && "failed" in resident) return { state: "failed", outputs: {}, status: "error", error: resident.failed, receipts: resident.receipts, usage: usage(0) };
      // One-shot path (no resident worker available): the same modules as two single-use engine runs.
      const code = await materialise(ctx);
      await writePrivate(stepFile, bytes);
      const f = await step(ctx, "cad", ctx.config.cadquery!, ["-I", "-W", "ignore", join(code, "surrogate_featurize.py"), "--step", stepFile, "--output", feats], 120_000);
      if (f.r.exitCode !== 0) return { state: "failed", outputs: {}, status: "error", error: "featurize failed (the STEP did not tessellate)", receipts: [f.receipt], usage: usage(0) };
      const p = await step(ctx, "physics", ctx.config.physicsPython!, ["-I", join(code, "surrogate_train.py"), "predict", "--weights", join(code, "weights.pt"), "--features", feats,
        "--domain", join(code, "domain.json")], 120_000);
      if (p.r.exitCode !== 0) return { state: "failed", outputs: {}, status: "error", error: "prediction failed", receipts: [f.receipt, p.receipt], usage: usage(0) };
      const prediction = SurrogatePrediction.parse(lastJson(p.r.stdout));
      return { state: "ok", outputs: { prediction }, status: prediction.inDomain ? "in-domain" : "out-of-domain", receipts: [f.receipt, p.receipt],
        usage: usage(Buffer.byteLength(JSON.stringify(prediction))) };
    },

    /** Acceptance: the shipped weights on the shipped held-out rows reproduce the training report and pass the gate. */
    async validate(ctx) {
      const code = await materialise(ctx);
      const e = await step(ctx, "physics", ctx.config.physicsPython!, ["-I", join(code, "surrogate_train.py"), "evaluate", "--weights", join(code, "weights.pt"), "--features", join(code, "heldout.npz")], 600_000);
      if (e.r.exitCode !== 0) throw new DomainError("BENCHMARK", "held-out evaluation failed", 500);
      const ev = Evaluation.parse(lastJson(e.r.stdout));
      const bench = JSON.parse(ctx.files["training-benchmark.json"].toString());
      const failed = surrogateGate(ev);
      const reproduces = JSON.stringify(ev.metrics) === JSON.stringify(bench.surrogate) && ev.weightsSha256 === bench.weightsSha256;
      if (!reproduces) failed.push("the shipped weights do not reproduce the training report on the held-out rows");
      return { passed: failed.length === 0, evidence: { schema: "pai-surrogate-acceptance-1", family, dataset, heldOut: ev.heldOut, gate: SURROGATE_GATE, failed,
        metrics: ev.metrics, conformal90Coverage: ev.conformal90Coverage, reproducesTrainingReport: reproduces,
        gpBaselineOnParameters: bench.gpBaseline, selection: bench.selection, inferenceMs: bench.inferenceMs, receipt: e.receipt,
        scope: "Held-out designs of the same synthetic family and load case; CalculiX labels. Not physical validation, not a solver." } };
    },
  };
}
export const bracketSurrogateAdapter = structuralSurrogate("nema17-bracket");
export const pillowSurrogateAdapter = structuralSurrogate("pillow-block");
