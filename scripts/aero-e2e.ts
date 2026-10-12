/**
 * Native aerodynamics loop (OpenFOAM v2512 in the pinned OpenCFD image): a steeper rear slant misses the drag target,
 * feedback binds the failed check, the corrected slant is re-solved on two meshes and the feedback closes.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { AERO_REFERENCE, DEFAULT_AERO_REQUIREMENTS, type AeroReview, aeroConfigured } from "../src/aero.js";
import type { Feedback, Project } from "../src/contracts.js";

const config = configuration();
assert.ok(aeroConfigured(config), "Set PAI_OPENFOAM_IMAGE (name@sha256) or the PAISolver CFD job, npm run setup:cad and setup:physics");
const state = join(config.state, "aero-e2e", randomUUID());
const { app } = await createApp({ ...config, state });
const host = `127.0.0.1:${config.port}`;
const req = async <T>(method: "POST" | "PATCH", url: string, payload: unknown) => {
  const r = await app.inject({ method, url, payload: JSON.stringify(payload), headers: { host, "content-type": "application/json" } });
  assert.equal(r.statusCode, 200, r.body); return r.json() as T;
};
const check = (r: AeroReview, id: string) => r.candidate!.checks.find(c => c.id === id)!;
const t0 = Date.now();
try {
  const project = await req<Project>("POST", "/api/projects", { title: "Lower-drag rear slant", intendedDecision: "Rear slant meeting Cd ≤ 0.24 on a mesh-converged RANS",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
  const steep = await req<AeroReview>("POST", `/api/projects/${project.id}/aero`, { requestId: randomUUID(), projectRevision: 1,
    parameters: { ...AERO_REFERENCE, slantAngleDeg: 35 }, requirements: DEFAULT_AERO_REQUIREMENTS });
  assert.equal(steep.state, "completed", steep.error ?? "aero review failed");
  const glb = await app.inject({ url: `/api/aero/${steep.id}/files/candidate/aero.glb`, headers: { host } });
  assert.equal(glb.rawPayload.subarray(0, 4).toString(), "glTF");
  let f: Feedback | undefined;
  if (steep.verdict === "rejected") {
    const failed = steep.candidate!.checks.find(c => !c.passed)!;
    f = await req<Feedback>("POST", "/api/feedback", { runId: steep.id, evidenceKind: "aero-body", kind: "design-check", checkId: failed.id, seed: null,
      expected: `${failed.id} ≤ ${failed.required}`, observed: `${failed.observed}`, actorKind: "maintainer" });
    for (const status of ["reproducible", "assigned", "fix-proposed"]) f = await req<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status, reason: "Shallower slant keeps the flow attached on the slant" });
  }
  const fixed = await req<AeroReview>("POST", `/api/projects/${project.id}/aero`, { requestId: randomUUID(), projectRevision: 1,
    parameters: { ...AERO_REFERENCE, slantAngleDeg: 12.5 }, requirements: DEFAULT_AERO_REQUIREMENTS, ...(f ? { feedbackId: f.id } : {}) });
  assert.equal(fixed.state, "completed", fixed.error ?? "aero recheck failed");
  assert.equal(fixed.verdict, "accepted-aero-body", JSON.stringify(fixed.candidate?.checks));
  if (f) {
    f = await req<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status: "rechecked", reason: "Two-mesh RANS meets the drag target", recheckRunId: fixed.id });
    f = await req<Feedback>("PATCH", `/api/feedback/${f.id}`, { expectedRevision: f.revision, status: "closed", reason: "RANS design comparison only" });
  }
  const summary = (r: AeroReview) => ({ verdict: r.verdict, cd: check(r, "drag-coefficient").observed, grid: check(r, "grid-convergence").observed,
    band: check(r, "iterative-convergence").observed, levels: r.cfd?.candidate?.levels.map(l => ({ level: l.level, cells: l.cells, cd: l.cd, seconds: l.seconds })) });
  const report = { schema: "pai-aero-e2e-1", checkedAt: new Date().toISOString(), result: "passed", seconds: Math.round((Date.now() - t0) / 1000), engine: fixed.candidate!.engine,
    image: config.openfoamImage ?? `batch:${config.solverBatch?.cfdJobDefinition}`, reference: { cd: fixed.baseline!.checks.find(c => c.id === "drag-coefficient")!.observed }, steep: summary(steep), fixed: summary(fixed),
    evalarcBlocking: { steep: steep.diff?.blocking_changes, fixed: fixed.diff?.blocking_changes }, feedback: f?.status ?? "none (steep slant passed)" };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence", "aero-e2e.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally { await app.close(); }
