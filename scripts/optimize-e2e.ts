/**
 * Native physics-aware optimisation loop: reference + AI seed + Sobol points measured by CadQuery and CalculiX,
 * a GP surrogate ranks candidates (ranking only), the lightest measured feasible point becomes a formal review.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { DEFAULT_CAD_REQUIREMENTS, DEFAULT_STRUCTURAL, type CadReview } from "../src/cad.js";
import type { CadOptimization } from "../src/optimize.js";
import type { Project } from "../src/contracts.js";

const config = configuration();
assert.ok(config.cadquery && config.physicsPython && config.ccx, "Run npm run setup:cad and npm run setup:physics");
const state = join(config.state, "optimize-e2e", randomUUID());
const { app } = await createApp({ ...config, state });
const host = `127.0.0.1:${config.port}`;
const call = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: JSON.stringify(payload), headers: { host, "content-type": "application/json" } });
const post = async <T>(url: string, payload: unknown) => { const r = await call(url, payload); assert.equal(r.statusCode, 200, r.body); return r.json() as T; };
const requirements = { ...DEFAULT_CAD_REQUIREMENTS, structural: DEFAULT_STRUCTURAL };
// PAI_OPTIMIZE_STRATEGY=botorch-qlognehvi exercises the BoTorch strategy (npm run setup:physics -- --with-botorch).
const strategy = (process.env.PAI_OPTIMIZE_STRATEGY ?? "gp-nsga2") as "gp-nsga2" | "botorch-qlognehvi";
// PAI_OPTIMIZE_SOLVER=batch solves every point as an AWS Batch job (needs PAI_SOLVER_QUEUE / _JOB_DEFINITION / _BUCKET).
const solver = process.env.PAI_OPTIMIZE_SOLVER === "batch" ? "batch" as const : undefined;
try {
  const project = await post<Project>("/api/projects", { title: "Optimise a stiff NEMA 17 bracket", intendedDecision: "Lightest bracket meeting stiffness and DFM rules",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
  assert.equal((await call(`/api/projects/${project.id}/cad-optimizations`, { requestId: randomUUID(), projectRevision: 1, requirements: DEFAULT_CAD_REQUIREMENTS })).statusCode, 400,
    "optimisation without frozen structural requirements is rejected");
  const t0 = Date.now();
  const run = await post<CadOptimization>(`/api/projects/${project.id}/cad-optimizations`, { requestId: randomUUID(), projectRevision: 1, requirements,
    budget: { initial: 4, rounds: 1, perRound: 3 }, strategy, ...(solver ? { solver } : {}),
    seeds: [{ parameters: { thickness: 3.8, width: 57, plateHeight: 45 }, expectedDeflectionMm: 0.055, expectedMassG: 44,
      rationale: "Ribs closer to the bores; W/2 − 20 ≥ 8.25 and H − 39.5 ≥ 5.1 keep the edge rules" }] });
  assert.equal(run.state, "completed", run.error ?? "optimisation failed");
  const r = run.result!;
  // A missing tool is a configuration fault, never a measured outcome (it once failed every geometry screen silently).
  const toolFaults = r.points.filter(p => /FileNotFoundError|No such file or directory/.test((p as { error?: string }).error ?? ""));
  assert.deepEqual(toolFaults.map(p => p.index), [], "no point may fail because a tool is missing");
  assert.equal(r.points[0].origin, "reference"); assert.equal(r.points[0].feasible, true, "reference bracket is feasible");
  assert.ok(r.points.some(p => p.origin === "ai-seed" && p.fidelity === "fea"));
  assert.equal(r.aiSeeds.length, 1); assert.ok(r.aiSeeds[0].relativeError !== null);
  assert.equal(r.rounds.length, 1); assert.ok(r.rounds[0].trainedOn >= 4);
  assert.equal(r.strategy, strategy);
  if (strategy === "botorch-qlognehvi") assert.ok(r.points.some(p => p.origin === "bo" && p.prediction), "BoTorch proposed and the solver measured at least one point");
  assert.ok(r.points.every(p => p.fidelity !== "fea" || (typeof p.deflectionMm === "number" && typeof p.mass === "number")));
  assert.ok(r.lightestFeasible, "a measured feasible point exists");
  const best = r.points.find(p => p.index === r.lightestFeasible)!;
  // Provenance is checked: a point that was not solved, or changed parameters, cannot claim the optimisation.
  const forged = await call(`/api/projects/${project.id}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "parametric", requirements,
    parameters: { ...best.parameters, thickness: 7 }, fromOptimize: { optimizeId: run.id, point: best.index } });
  assert.equal(forged.statusCode, 422); assert.equal(forged.json().error, "INVALID_OPTIMIZE_POINT");
  const formal = await post<CadReview>(`/api/projects/${project.id}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "parametric", requirements,
    parameters: best.parameters, fromOptimize: { optimizeId: run.id, point: best.index } });
  assert.equal(formal.state, "completed", formal.error ?? "formal review failed");
  const formalDeflection = formal.candidate!.checks.find(c => c.id === "max-deflection") as unknown as { observed: number; passed: boolean };
  const report = { schema: "pai-optimize-e2e-1", checkedAt: new Date().toISOString(), result: "passed", strategy, search: r.search, seconds: Math.round((Date.now() - t0) / 1000),
    points: r.points.length, solved: r.points.filter(p => p.fidelity === "fea").length, screened: r.points.filter(p => p.fidelity === "geometry").length,
    feasible: r.feasibleCount, reference: { mass: r.points[0].mass, deflectionMm: r.points[0].deflectionMm },
    recommended: { index: best.index, origin: best.origin, parameters: best.parameters, mass: best.mass, deflectionMm: best.deflectionMm },
    formal: { verdict: formal.verdict, deflectionMm: formalDeflection.observed, convergence: formal.fea?.candidate?.convergence },
    surrogate: { loo: r.rounds[0].looMeanAbsError.logDeflection, calibration: r.calibration }, aiSeed: r.aiSeeds[0] };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence", "optimize-e2e.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally { await app.close(); }
