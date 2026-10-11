/**
 * First artifact family: off-site (road) logistics planning — pickup-and-delivery vehicle routing with capacities,
 * time windows, vehicle shifts and a road cost matrix (PDPTW). Not in-plant AGV motion planning, not vehicle control,
 * and it never dispatches real transport.
 *
 * Solver: Google OR-Tools routing, pinned by digest (native/logistics-requirements.txt; ADR 0001 records why).
 * Verifier: native/logistics_verify.py, standard library only, sharing no code with the solver; a plan is usable only
 * when it passes. Benchmarks are synthetic and labelled; they show behaviour and correctness, not production value.
 */
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { command, writePrivate } from "../adapters.js";
import type { Config } from "../config.js";
import { DomainError, sha256 } from "../domain.js";
import type { ArtifactAdapter, ArtifactManifest, OperationResult, RunContext } from "./contract.js";
import { lockVersions, materialise, sourceCommit } from "./native-artifact.js";

const FILES = ["logistics_solve.py", "logistics_verify.py", "logistics_generate.py", "logistics-requirements.txt"] as const;
const LIMITS = { maxOrders: 500, maxVehicles: 100, maxTimeLimitSeconds: 120 };
/** Licences of the locked wheels (from their PyPI metadata); the lock itself pins versions and hashes. */
const LICENSES: Record<string, string> = { ortools: "Apache-2.0", protobuf: "BSD-3-Clause", numpy: "BSD-3-Clause", "absl-py": "Apache-2.0",
  pandas: "BSD-3-Clause", immutabledict: "MIT", "python-dateutil": "Apache-2.0 OR BSD-3-Clause", six: "MIT", "typing-extensions": "PSF-2.0" };

const Window = z.tuple([z.number().int().min(0), z.number().int().min(0)]).refine(w => w[0] <= w[1], "window start after end");
export const Problem = z.object({
  schema: z.literal("pai-logistics-problem-1"), synthetic: z.boolean(), label: z.string().max(300).optional(),
  units: z.object({ distance: z.literal("km"), time: z.literal("min"), load: z.literal("kg") }).strict(),
  matrix: z.object({ source: z.string().max(300), distanceKm: z.array(z.array(z.number().min(0))), timeMin: z.array(z.array(z.number().int().min(0))) }).strict(),
  depot: z.literal(0), horizonMin: z.number().int().positive().max(10_080),
  vehicles: z.array(z.object({ id: z.string().max(40), capacityKg: z.number().positive(), shift: Window, costPerKm: z.number().min(0), fixedCost: z.number().min(0) }).strict())
    .min(1).max(LIMITS.maxVehicles),
  orders: z.array(z.object({ id: z.string().max(40), pickup: z.number().int().positive(), delivery: z.number().int().positive(), weightKg: z.number().positive(),
    serviceMin: z.number().int().min(0).max(600), pickupWindow: Window, deliveryWindow: Window }).strict()).min(1).max(LIMITS.maxOrders),
}).strict().superRefine((p, ctx) => {
  const n = p.matrix.distanceKm.length;
  if (p.matrix.timeMin.length !== n || [...p.matrix.distanceKm, ...p.matrix.timeMin].some(r => r.length !== n)) ctx.addIssue({ code: "custom", path: ["matrix"], message: "matrices must be square and the same size" });
  const nodes = p.orders.flatMap(o => [o.pickup, o.delivery]);
  if (new Set(nodes).size !== nodes.length || nodes.some(i => i >= n)) ctx.addIssue({ code: "custom", path: ["orders"], message: "each order needs its own pickup and delivery location inside the matrix" });
  if (new Set(p.orders.map(o => o.id)).size !== p.orders.length) ctx.addIssue({ code: "custom", path: ["orders"], message: "order ids must be unique" });
});
const Plan = z.object({ schema: z.literal("pai-logistics-plan-1"), status: z.enum(["feasible", "partial", "infeasible", "timeout", "unknown", "error"]),
  routes: z.array(z.unknown()), unassigned: z.array(z.string()) }).passthrough();
const Verification = z.object({ schema: z.literal("pai-logistics-verification-1"), verdict: z.enum(["feasible-plan", "partial-plan", "no-plan", "rejected"]),
  checks: z.array(z.object({ id: z.string(), passed: z.boolean() }).passthrough()) }).passthrough();
const SCHEMAS: Record<string, z.ZodType> = { "pai-logistics-problem-1": Problem, "pai-logistics-plan-1": Plan, "pai-logistics-verification-1": Verification };

const issues = (r: { success: boolean; error?: z.ZodError }) => r.success ? [] : r.error!.issues.slice(0, 8).map(i => `${i.path.join(".") || "(root)"}: ${i.message}`);



async function python(config: Config, args: string[], cwd: string, timeoutMs: number) {
  const r = await command(config.logisticsPython!, ["-I", ...args], cwd, undefined, timeoutMs);
  return r;
}

export const logisticsAdapter: ArtifactAdapter = {
  id: "logistics-pdptw",
  params: {
    solve: z.object({ strategy: z.enum(["deterministic", "guided"]).default("deterministic"), timeLimitSeconds: z.number().gt(0).max(LIMITS.maxTimeLimitSeconds).default(10),
      allowUnassigned: z.boolean().default(false) }).strict(),
    baseline: z.object({}).strict(),
    verify: z.object({}).strict(),
  },
  schemas: Object.keys(SCHEMAS),
  validateData: (schemaId, value) => SCHEMAS[schemaId] ? issues(SCHEMAS[schemaId].safeParse(value)) : [`unknown schema ${schemaId}`],

  async build(config, version, actor) {
    const files: Record<string, Buffer> = {};
    for (const f of FILES) files[f] = await readFile(join(config.repository, "native", f));
    const pins = lockVersions(files["logistics-requirements.txt"].toString());
    const manifest: ArtifactManifest = {
      schema: "pai-artifact-1", name: "logistics-pdptw", version, kind: "algorithm", adapter: "logistics-pdptw",
      title: "场外物流规划：取送货车辆路径（容量、时间窗、班次）",
      description: "Road-transport planning for off-site logistics: assigns pickup-and-delivery orders to vehicles and orders their stops under "
        + "vehicle capacity, pickup-before-delivery on the same vehicle, pickup/delivery time windows with service and waiting, vehicle shifts and a "
        + "road distance/time matrix, minimising distance cost plus a fixed cost per used vehicle. Every plan is checked by an independent verifier.",
      operations: [
        { id: "solve", description: "OR-Tools routing; deterministic (replayable) or guided local search within a time limit", inputs: { problem: "pai-logistics-problem-1" },
          outputs: { plan: "pai-logistics-plan-1" }, effects: "none" },
        { id: "baseline", description: "Sequential heuristic (one order at a time, first vehicle that fits) for comparison only", inputs: { problem: "pai-logistics-problem-1" },
          outputs: { plan: "pai-logistics-plan-1" }, effects: "none" },
        { id: "verify", description: "Independent recomputation: continuity, each order once, pickup before delivery, capacity, time windows, reported figures, status",
          inputs: { problem: "pai-logistics-problem-1", plan: "pai-logistics-plan-1" }, outputs: { verification: "pai-logistics-verification-1" }, effects: "none" },
      ],
      capabilities: ["pickup-and-delivery pairs on the same vehicle", "vehicle capacity (kg)", "pickup and delivery time windows with waiting", "service time per stop",
        "vehicle shifts", "per-vehicle cost rate and fixed cost", "optional unassigned orders (partial plans)", "explicit infeasible / timeout / unknown statuses"],
      limits: LIMITS,
      runtime: { python: "3.12", lock: "logistics-requirements.txt", entrypoints: { solve: "logistics_solve.py", verify: "logistics_verify.py", generate: "logistics_generate.py" } },
      dependencies: Object.entries(pins).map(([name, v]) => ({ name, version: v, license: LICENSES[name] ?? "unknown", source: `https://pypi.org/project/${name}/${v}/`,
        role: name === "ortools" ? "solver" as const : "library" as const })),
      license: "MIT (artifact code); dependencies under their own licences",
      provenance: { repository: "noteflowai/pai-design-workbench", sourceCommit: sourceCommit(config.repository), builtAt: new Date().toISOString(), builtBy: actor },
      files: Object.fromEntries(Object.entries(files).map(([k, b]) => [k, sha256(b)])),
      scope: "Planning on the supplied instance and matrix. Validated on synthetic, labelled instances only: no real road network, demand or production benefit is claimed; optimality is not proven.",
      physicalValidation: false,
    };
    return { manifest, files };
  },

  sample: {
    params: z.object({ scenario: z.enum(["normal", "tight", "overload"]).default("normal"), seed: z.number().int().min(0).max(1_000_000).default(11),
      orders: z.number().int().min(1).max(LIMITS.maxOrders).default(40), vehicles: z.number().int().min(1).max(LIMITS.maxVehicles).default(8) }).strict(),
    async generate(ctx, params) {
      const code = await materialise(ctx), f = join(ctx.directory, "sample.json");
      const r = await command("python3", ["-I", join(code, "logistics_generate.py"), "--seed", String(params.seed), "--orders", String(params.orders),
        "--vehicles", String(params.vehicles), "--scenario", String(params.scenario), "--output", f], ctx.directory, undefined, 60_000);
      if (r.exitCode !== 0) throw new DomainError("SAMPLE_FAILED", "generator failed", 500);
      return JSON.parse(await readFile(f, "utf8"));
    },
  },

  async runtimeReady(config, manifest) {
    if (!config.logisticsPython) return { ready: false, reason: "PAI_LOGISTICS_PYTHON is not set (python3 tools/setup_logistics.py)" };
    const want = manifest.dependencies.find(d => d.name === "ortools")?.version;
    const r = await command(config.logisticsPython, ["-I", "-c", "import ortools; print(ortools.__version__)"], config.state, undefined, 30_000).catch(() => undefined);
    const have = r?.exitCode === 0 ? r.stdout.trim() : undefined;
    return have === want ? { ready: true } : { ready: false, reason: `runtime OR-Tools ${have ?? "unavailable"} differs from the artifact's pin ${want}` };
  },

  async run(ctx, operation, inputs, params): Promise<OperationResult> {
    const code = await materialise(ctx);
    const t0 = Date.now();
    const problemFile = join(ctx.directory, "problem.json");
    await writePrivate(problemFile, JSON.stringify(inputs.problem));
    if (operation === "solve" || operation === "baseline") {
      const p = operation === "solve" ? this.params.solve.parse(params) as { strategy: string; timeLimitSeconds: number; allowUnassigned: boolean } : undefined;
      const out = join(ctx.directory, "plan.json");
      const args = [join(code, "logistics_solve.py"), "--problem", problemFile, "--output", out,
        ...(p ? ["--strategy", p.strategy, "--time-limit", String(p.timeLimitSeconds), ...(p.allowUnassigned ? ["--allow-unassigned"] : [])] : ["--baseline"])];
      const r = await python(ctx.config, args, ctx.directory, ((p?.timeLimitSeconds ?? 10) + 60) * 1000);
      const receipts = [{ command: ["python", "logistics_solve.py", ...args.slice(1).filter(a => !a.startsWith("/"))], exitCode: r.exitCode, stdoutSha256: sha256(r.stdout + r.stderr), seconds: (Date.now() - t0) / 1000 }];
      if (r.exitCode !== 0) return { state: "failed", outputs: {}, status: "error", error: `solver exited ${r.exitCode}`, receipts,
        usage: { cpuSeconds: null, maxRssKb: null, wallSeconds: (Date.now() - t0) / 1000, storageBytes: 0 } };
      const text = await readFile(out, "utf8"), plan = JSON.parse(text);
      return { state: "ok", outputs: { plan }, status: plan.status, receipts,
        usage: { cpuSeconds: plan.usage?.cpuSeconds ?? null, maxRssKb: plan.usage?.maxRssKb ?? null, wallSeconds: (Date.now() - t0) / 1000, storageBytes: Buffer.byteLength(text) } };
    }
    if (operation === "verify") {
      const planFile = join(ctx.directory, "plan-in.json"), out = join(ctx.directory, "verification.json");
      await writePrivate(planFile, JSON.stringify(inputs.plan));
      // The verifier is standard-library only and runs with the system interpreter, not the solver's environment.
      const r = await command("python3", ["-I", join(code, "logistics_verify.py"), "--problem", problemFile, "--plan", planFile, "--output", out], ctx.directory, undefined, 120_000);
      const receipts = [{ command: ["python3", "logistics_verify.py"], exitCode: r.exitCode, stdoutSha256: sha256(r.stdout + r.stderr), seconds: (Date.now() - t0) / 1000 }];
      if (r.exitCode !== 0) return { state: "failed", outputs: {}, status: "error", error: `verifier exited ${r.exitCode}`, receipts,
        usage: { cpuSeconds: null, maxRssKb: null, wallSeconds: (Date.now() - t0) / 1000, storageBytes: 0 } };
      const text = await readFile(out, "utf8"), verification = JSON.parse(text);
      return { state: "ok", outputs: { verification }, status: verification.verdict, receipts,
        usage: { cpuSeconds: verification.usage?.cpuSeconds ?? null, maxRssKb: verification.usage?.maxRssKb ?? null, wallSeconds: (Date.now() - t0) / 1000, storageBytes: Buffer.byteLength(text) } };
    }
    throw new DomainError("UNKNOWN_OPERATION", `Operation ${operation} is not part of this artifact`, 422);
  },

  /**
   * Acceptance benchmark (seeded, synthetic): a normal instance must be planned and verified; the deterministic plan
   * must replay identically; narrowed windows give a verified partial plan; an overweight order is infeasible; an edited
   * plan is rejected by the verifier. The baseline is measured on the same instance for comparison.
   */
  async validate(ctx) {
    const code = await materialise(ctx);
    const gen = async (scenario: string, seed = 7) => {
      const f = join(ctx.directory, `bench-${scenario}-${seed}.json`);
      const r = await command("python3", ["-I", join(code, "logistics_generate.py"), "--seed", String(seed), "--orders", "24", "--vehicles", "5", "--scenario", scenario, "--output", f], ctx.directory, undefined, 60_000);
      if (r.exitCode !== 0) throw new DomainError("BENCHMARK", `generator failed for ${scenario}`, 500);
      return JSON.parse(await readFile(f, "utf8"));
    };
    const sub = (name: string) => ({ ...ctx, directory: join(ctx.directory, name) });
    const step = async (name: string, op: string, inputs: Record<string, unknown>, params: Record<string, unknown> = {}) => {
      await mkdir(join(ctx.directory, name), { recursive: true, mode: 0o700 });
      return this.run(sub(name), op, inputs, params);
    };
    const normal = await gen("normal"), tight = await gen("tight"), overload = await gen("overload");
    const solved = await step("normal", "solve", { problem: normal }, { strategy: "deterministic", timeLimitSeconds: 20 });
    const replay = await step("normal-replay", "solve", { problem: normal }, { strategy: "deterministic", timeLimitSeconds: 20 });
    const verified = await step("normal-verify", "verify", { problem: normal, plan: solved.outputs.plan });
    const base = await step("baseline", "baseline", { problem: normal });
    const baseVerified = await step("baseline-verify", "verify", { problem: normal, plan: base.outputs.plan });
    const partial = await step("tight", "solve", { problem: tight }, { allowUnassigned: true, timeLimitSeconds: 20 });
    const partialVerified = await step("tight-verify", "verify", { problem: tight, plan: partial.outputs.plan });
    const infeasible = await step("overload", "solve", { problem: overload }, { timeLimitSeconds: 20 });
    const edited = JSON.parse(JSON.stringify(solved.outputs.plan)) as { routes: { distanceKm: number }[] };
    if (edited.routes?.[0]) edited.routes[0].distanceKm -= 5;
    const tamper = await step("tamper-verify", "verify", { problem: normal, plan: edited });
    const plan = solved.outputs.plan as { routes: unknown[]; totalDistanceKm: number; totalCost: number; vehiclesUsed: number; solver: unknown };
    const bp = base.outputs.plan as { totalDistanceKm: number; totalCost: number; vehiclesUsed: number; unassigned: string[] };
    const expectations = {
      normalFeasibleAndVerified: solved.status === "feasible" && verified.status === "feasible-plan",
      // Both runs ended at the search's local optimum (not the time limit) and produced the same routes.
      deterministicReplay: (plan.solver as { replayable?: boolean })?.replayable === true && (replay.outputs.plan as { solver?: { replayable?: boolean } }).solver?.replayable === true
        && JSON.stringify(plan.routes) === JSON.stringify((replay.outputs.plan as { routes: unknown[] }).routes),
      baselineVerified: baseVerified.status === "feasible-plan" || baseVerified.status === "partial-plan",
      tightPartialVerified: partial.status === "partial" && partialVerified.status === "partial-plan",
      overloadInfeasible: infeasible.status === "infeasible",
      tamperedPlanRejected: tamper.status === "rejected",
    };
    return { passed: Object.values(expectations).every(Boolean), evidence: {
      schema: "pai-logistics-benchmark-1", instances: { seed: 7, orders: 24, vehicles: 5, generator: "logistics_generate.py", matrix: normal.matrix.source, synthetic: true },
      expectations,
      comparison: { ortools: { status: solved.status, distanceKm: plan.totalDistanceKm, cost: plan.totalCost, vehicles: plan.vehiclesUsed, seconds: solved.usage.wallSeconds, solver: plan.solver },
        baseline: { status: base.status, distanceKm: bp.totalDistanceKm, cost: bp.totalCost, vehicles: bp.vehiclesUsed, unassigned: bp.unassigned.length } },
      planSha256: sha256(JSON.stringify(plan.routes)),
      scope: "Synthetic instances; a comparison with a simple heuristic, not a claim of optimality or of production benefit." } };
  },
};
