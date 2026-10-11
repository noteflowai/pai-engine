/**
 * Second artifact family: site admission and yard scheduling — the decision of which trucks enter a site with limited
 * space, when, at which dock and with which crew. Constraints: arrival windows, gate lanes, staging (yard) slots by
 * truck size, dock compatibility (cargo, length), crews, handling times, exit time and latest departure. Objective,
 * lexicographic: the most priority-weighted admissions, then the least weighted waiting plus time on site.
 *
 * Solver: Google OR-Tools CP-SAT (constraint programming, the standard method for this resource-constrained
 * scheduling class), the same digest-pinned lock as the logistics artifact. Baseline: first-come-first-served, as many
 * sites dispatch today. Verifier: native/yard_verify.py, standard library only, recomputes every minute of capacity.
 * Synthetic, labelled instances; no real site, and no claim of production benefit.
 */
import { runEngine } from "../kernel/engine-runtime.js";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writePrivate } from "../adapters.js";
import { DomainError, sha256 } from "../domain.js";
import type { ArtifactAdapter, ArtifactManifest, OperationResult } from "./contract.js";
import { lockVersions, materialise, nativeStep, sourceCommit } from "./native-artifact.js";

const FILES = ["yard_solve.py", "yard_verify.py", "yard_generate.py", "logistics-requirements.txt"] as const;
const LIMITS = { maxTrucks: 120, maxDocks: 30, maxHorizonMin: 1440, maxBudget: 60 };
const LICENSES: Record<string, string> = { ortools: "Apache-2.0", protobuf: "BSD-3-Clause", numpy: "BSD-3-Clause", "absl-py": "Apache-2.0",
  pandas: "BSD-3-Clause", immutabledict: "MIT", "python-dateutil": "Apache-2.0 OR BSD-3-Clause", six: "MIT", "typing-extensions": "PSF-2.0" };

const Minutes = z.number().int().min(0).max(LIMITS.maxHorizonMin);
export const YardProblem = z.object({
  schema: z.literal("pai-yard-problem-1"), synthetic: z.boolean(), label: z.string().max(300).optional(),
  units: z.object({ time: z.literal("min"), length: z.literal("m") }).strict(), horizonMin: Minutes.refine(v => v > 0),
  site: z.object({ name: z.string().max(120), yardSlots: z.number().int().min(1).max(500), crews: z.number().int().min(1).max(100), exitMin: z.number().int().min(0).max(120) }).strict(),
  gate: z.object({ lanes: z.number().int().min(1).max(20), processMin: z.number().int().min(1).max(120) }).strict(),
  docks: z.array(z.object({ id: z.string().max(20), cargo: z.array(z.string().max(30)).min(1).max(10), maxLengthM: z.number().positive().max(30) }).strict()).min(1).max(LIMITS.maxDocks),
  trucks: z.array(z.object({ id: z.string().max(20), carrier: z.string().max(60), cargo: z.string().max(30), lengthM: z.number().positive().max(30),
    slots: z.number().int().min(1).max(10), crew: z.number().int().min(1).max(20), arrival: z.tuple([Minutes, Minutes]), handleMin: z.number().int().min(1).max(600),
    latestDeparture: Minutes, priority: z.number().int().min(1).max(10) }).strict()).min(1).max(LIMITS.maxTrucks),
}).strict().superRefine((p, ctx) => {
  if (new Set(p.trucks.map(t => t.id)).size !== p.trucks.length) ctx.addIssue({ code: "custom", path: ["trucks"], message: "truck ids must be unique" });
  if (new Set(p.docks.map(d => d.id)).size !== p.docks.length) ctx.addIssue({ code: "custom", path: ["docks"], message: "dock ids must be unique" });
  p.trucks.forEach((t, i) => {
    if (t.arrival[0] > t.arrival[1]) ctx.addIssue({ code: "custom", path: ["trucks", i, "arrival"], message: "arrival window start after end" });
    if (t.latestDeparture > p.horizonMin) ctx.addIssue({ code: "custom", path: ["trucks", i, "latestDeparture"], message: "beyond the horizon" });
  });
});
const YardPlan = z.object({ schema: z.literal("pai-yard-plan-1"), status: z.enum(["optimal", "feasible", "partial-optimal", "partial", "infeasible", "timeout", "unknown", "error"]),
  plan: z.array(z.unknown()) }).passthrough();
const YardVerification = z.object({ schema: z.literal("pai-yard-verification-1"), verdict: z.enum(["valid-schedule", "rejected"]),
  checks: z.array(z.object({ id: z.string(), passed: z.boolean() }).passthrough()) }).passthrough();
const SCHEMAS: Record<string, z.ZodType> = { "pai-yard-problem-1": YardProblem, "pai-yard-plan-1": YardPlan, "pai-yard-verification-1": YardVerification };
const issues = (r: { success: boolean; error?: z.ZodError }) => r.success ? [] : r.error!.issues.slice(0, 8).map(i => `${i.path.join(".") || "(root)"}: ${i.message}`);

export const yardAdapter: ArtifactAdapter = {
  id: "yard-admission",
  params: {
    schedule: z.object({ budget: z.number().gt(0).max(LIMITS.maxBudget).default(20) }).strict(),
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
      schema: "pai-artifact-1", name: "yard-admission", version, kind: "algorithm", adapter: "yard-admission",
      title: "场地准入与排队调度：有限场地内车辆何时入场、停哪、上哪个月台",
      description: "Decision algorithm for a site with limited space: which trucks are admitted, when each enters (within its arrival window), "
        + "which compatible dock and crew handle it and when it leaves, under gate lanes, yard (staging) slots by truck size, dock cargo/length "
        + "compatibility, crews and latest departures. Lexicographic objective: most priority-weighted admissions, then least weighted waiting plus "
        + "time on site. CP-SAT with a deterministic budget; every schedule is checked minute by minute by an independent verifier.",
      operations: [
        { id: "schedule", description: "OR-Tools CP-SAT; one worker, fixed seed, deterministic-time budget (replayable); proven optimality is reported, never assumed",
          inputs: { problem: "pai-yard-problem-1" }, outputs: { plan: "pai-yard-plan-1" }, effects: "none" },
        { id: "baseline", description: "First-come-first-served: earliest arrival first, earliest free start; for comparison only",
          inputs: { problem: "pai-yard-problem-1" }, outputs: { plan: "pai-yard-plan-1" }, effects: "none" },
        { id: "verify", description: "Independent minute-by-minute recomputation: windows, compatibility, handling, gate order, departure, no dock overlap, gate/yard/crew capacity, totals",
          inputs: { problem: "pai-yard-problem-1", plan: "pai-yard-plan-1" }, outputs: { verification: "pai-yard-verification-1" }, effects: "none" },
      ],
      capabilities: ["arrival windows and latest departure", "gate lanes and processing time", "yard slots by truck size (limited space)", "dock cargo and length compatibility",
        "crews per handling", "priorities", "explicit turned-away trucks", "proven-optimal flag"],
      limits: LIMITS,
      runtime: { python: "3.12", lock: "logistics-requirements.txt", entrypoints: { schedule: "yard_solve.py", verify: "yard_verify.py", generate: "yard_generate.py" } },
      dependencies: Object.entries(pins).map(([name, v]) => ({ name, version: v, license: LICENSES[name] ?? "unknown", source: `https://pypi.org/project/${name}/${v}/`,
        role: name === "ortools" ? "solver" as const : "library" as const })),
      license: "MIT (artifact code); dependencies under their own licences",
      provenance: { repository: "noteflowai/pai-engine", sourceCommit: sourceCommit(config.repository), builtAt: new Date().toISOString(), builtBy: actor },
      files: Object.fromEntries(Object.entries(files).map(([k, b]) => [k, sha256(b)])),
      scope: "Scheduling on the supplied site and arrivals. Validated on synthetic, labelled instances only: no real site, traffic or production benefit is claimed.",
      physicalValidation: false,
    };
    return { manifest, files };
  },

  sample: {
    params: z.object({ scenario: z.enum(["normal", "peak", "overload"]).default("normal"), seed: z.number().int().min(0).max(1_000_000).default(7) }).strict(),
    async generate(ctx, params) {
      const code = await materialise(ctx), f = join(ctx.directory, "sample.json");
      const r = await runEngine(ctx.config, { engine: "logistics", program: "python3", args: ["-I", join(code, "yard_generate.py"), "--seed", String(params.seed), "--scenario", String(params.scenario), "--output", f], cwd: ctx.directory, mounts: { write: [ctx.directory] }, timeoutMs: 60_000 });
      if (r.exitCode !== 0) throw new DomainError("SAMPLE_FAILED", "generator failed", 500);
      return JSON.parse(await readFile(f, "utf8"));
    },
  },

  async runtimeReady(config, manifest) {
    if (!config.logisticsPython) return { ready: false, reason: "PAI_LOGISTICS_PYTHON is not set (python3 tools/setup_logistics.py)" };
    const want = manifest.dependencies.find(d => d.name === "ortools")?.version;
    const r = await runEngine(config, { engine: "logistics", program: config.logisticsPython, args: ["-I", "-c", "import ortools; print(ortools.__version__)"], cwd: config.state, mounts: { write: [] }, timeoutMs: 30_000 }).catch(() => undefined);
    const have = r?.exitCode === 0 ? r.stdout.trim() : undefined;
    return have === want ? { ready: true } : { ready: false, reason: `runtime OR-Tools ${have ?? "unavailable"} differs from the artifact's pin ${want}` };
  },

  async run(ctx, operation, inputs, params): Promise<OperationResult> {
    const code = await materialise(ctx);
    const problemFile = join(ctx.directory, "problem.json");
    await writePrivate(problemFile, JSON.stringify(inputs.problem));
    if (operation === "schedule" || operation === "baseline") {
      const p = operation === "schedule" ? this.params.schedule.parse(params) as { budget: number } : undefined;
      const out = join(ctx.directory, "plan.json");
      const args = ["--problem", problemFile, "--output", out, ...(p ? ["--time-limit", String(p.budget)] : ["--baseline"])];
      // The baseline is standard-library Python; only CP-SAT needs the pinned solver environment.
      return nativeStep(ctx, p ? ctx.config.logisticsPython! : "python3", join(code, "yard_solve.py"), args, out, "plan", v => String(v.status), ((p?.budget ?? 10) * 5 + 60) * 1000);
    }
    if (operation === "verify") {
      const planFile = join(ctx.directory, "plan-in.json"), out = join(ctx.directory, "verification.json");
      await writePrivate(planFile, JSON.stringify(inputs.plan));
      return nativeStep(ctx, "python3", join(code, "yard_verify.py"), ["--problem", problemFile, "--plan", planFile, "--output", out], out, "verification", v => String(v.verdict), 120_000);
    }
    throw new DomainError("UNKNOWN_OPERATION", `Operation ${operation} is not part of this artifact`, 422);
  },

  /**
   * Acceptance benchmark (seeded, synthetic): CP-SAT admits at least as many priority points as first-come-first-served
   * on a normal shift and on a peak; every schedule (both methods) passes the independent verifier; the schedule replays
   * identically; a truck no dock can take is turned away (never forced in); a tampered schedule is rejected.
   */
  async validate(ctx) {
    const code = await materialise(ctx);
    const gen = async (scenario: string) => {
      const f = join(ctx.directory, `bench-${scenario}.json`);
      const r = await runEngine(ctx.config, { engine: "logistics", program: "python3", args: ["-I", join(code, "yard_generate.py"), "--seed", "7", "--scenario", scenario, "--output", f], cwd: ctx.directory, mounts: { write: [ctx.directory] }, timeoutMs: 60_000 });
      if (r.exitCode !== 0) throw new DomainError("BENCHMARK", `generator failed for ${scenario}`, 500);
      return JSON.parse(await readFile(f, "utf8"));
    };
    const step = async (name: string, op: string, inputs: Record<string, unknown>, params: Record<string, unknown> = {}) => {
      await mkdir(join(ctx.directory, name), { recursive: true, mode: 0o700 });
      return this.run({ ...ctx, directory: join(ctx.directory, name) }, op, inputs, params);
    };
    type Plan = { status: string; plan: { truck: string; admitted: boolean }[]; totals: { admitted: number; priorityAdmitted: number; waitingMin: number; onSiteMin: number; turnedAway: string[] };
      solver: { replayable?: boolean; proven?: boolean } };
    const result: Record<string, unknown> = {}, expectations: Record<string, boolean> = {};
    for (const scenario of ["normal", "peak"]) {
      const problem = await gen(scenario);
      const cp = await step(`${scenario}-cp`, "schedule", { problem }, { budget: 15 }), fcfs = await step(`${scenario}-fcfs`, "baseline", { problem });
      const vc = await step(`${scenario}-cp-verify`, "verify", { problem, plan: cp.outputs.plan }), vf = await step(`${scenario}-fcfs-verify`, "verify", { problem, plan: fcfs.outputs.plan });
      const a = cp.outputs.plan as Plan, b = fcfs.outputs.plan as Plan;
      expectations[`${scenario}BothVerified`] = vc.status === "valid-schedule" && vf.status === "valid-schedule";
      expectations[`${scenario}AtLeastBaseline`] = Boolean(a?.totals && b?.totals) && a.totals.priorityAdmitted >= b.totals.priorityAdmitted;
      result[scenario] = { trucks: problem.trucks.length, cpSat: { status: a?.status, ...a?.totals, proven: a?.solver?.proven, seconds: cp.usage.wallSeconds },
        firstComeFirstServed: { status: b?.status, ...b?.totals } };
      if (scenario === "normal") {
        const again = await step("normal-replay", "schedule", { problem }, { budget: 15 });
        expectations.replay = a?.solver?.replayable === true && JSON.stringify(a.plan) === JSON.stringify((again.outputs.plan as Plan)?.plan);
        const tampered = JSON.parse(JSON.stringify(a)) as { plan: { admitted: boolean; handleEnd: number }[] };
        const row = tampered.plan.find(r => r.admitted); if (row) row.handleEnd -= 5;
        expectations.tamperedRejected = (await step("tamper-verify", "verify", { problem, plan: tampered })).status === "rejected";
      }
    }
    const overload = await gen("overload");
    const o = (await step("overload-cp", "schedule", { problem: overload }, { budget: 10 })).outputs.plan as Plan;
    expectations.incompatibleTurnedAway = Boolean(o?.totals?.turnedAway.includes(overload.trucks[3].id));
    return { passed: Object.values(expectations).every(Boolean), evidence: { schema: "pai-yard-benchmark-1", seed: 7, synthetic: true, expectations, comparison: result,
      scope: "Synthetic instances; a comparison with first-come-first-served, not a claim of optimality or production benefit." } };
  },
};
