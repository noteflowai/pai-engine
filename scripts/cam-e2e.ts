/**
 * Native CAM loop: frozen DFM + CAM requirements → FreeCAD CAM (ocp-freecad-cam) + OpenCAMLib programs per setup →
 * independent dexel simulation of the G-code → checks in the ordinary CAD review (EvalArc, verdict, files with digests).
 * The reference bracket is programmed and verified; G-code and reports are served by digest.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { camConfigured, DEFAULT_CAD_REQUIREMENTS, type CadReview } from "../src/cad.js";
import type { Project } from "../src/contracts.js";

const config = configuration();
assert.ok(camConfigured(config), "Run npm run setup:cad and npm run setup:cam, or configure the PAISolver CAM job");
const state = join(config.state, "cam-e2e", randomUUID());
const { app } = await createApp({ ...config, state });
const host = `127.0.0.1:${config.port}`;
const post = async <T>(url: string, payload: unknown) => {
  const r = await app.inject({ method: "POST", url, payload: JSON.stringify(payload), headers: { host, "content-type": "application/json" } });
  assert.equal(r.statusCode, 200, r.body); return r.json() as T;
};
const check = (c: CadReview, w: "baseline" | "candidate", id: string) => c[w]!.checks.find(x => x.id === id) as unknown as { passed: boolean; observed: unknown };
try {
  const project = await post<Project>("/api/projects", { title: "Machinable NEMA 17 bracket", intendedDecision: "Release a verified 3-axis program with the part",
    requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } });
  const t0 = Date.now();
  const run = await post<CadReview>(`/api/projects/${project.id}/cad`, { requestId: randomUUID(), projectRevision: 1, variant: "reference",
    requirements: { ...DEFAULT_CAD_REQUIREMENTS, dfm: { maxSetups: 2, maxUnitCostEur: 25, cam: { maxCycleMinutes: 120 } } } });
  assert.equal(run.state, "completed", run.error ?? "CAM review failed");
  for (const w of ["baseline", "candidate"] as const) {
    assert.equal(check(run, w, "cam-toolpath").passed, true, JSON.stringify(check(run, w, "cam-toolpath")));
    assert.equal(check(run, w, "cycle-time").passed, true);
  }
  assert.equal(run.verdict, "accepted-cad-part");
  const programs = Object.keys(run.files).filter(f => f.startsWith("candidate/setup") && f.endsWith(".nc")).sort();
  assert.deepEqual(programs, ["candidate/setup+Y.nc", "candidate/setup+Z.nc"], "one program per DFM setup");
  const nc = await app.inject({ url: `/api/cad/${run.id}/files/${programs[1]}`, headers: { host } });
  assert.equal(nc.statusCode, 200); assert.match(nc.body, /G21/); assert.match(nc.body, /M2/);
  const sim = await app.inject({ url: `/api/cad/${run.id}/files/candidate/cam-sim.png`, headers: { host } });
  assert.equal(sim.statusCode, 200); assert.equal(sim.rawPayload.subarray(1, 4).toString(), "PNG");
  const verify = (await app.inject({ url: `/api/cad/${run.id}/files/candidate/cam-verify.json`, headers: { host } })).json();
  // Local FreeCAD or the PAISolver CAM job (adapter suffix -batch); both must have succeeded.
  assert.ok(run.receipts.some(r => r.adapter.startsWith("freecad-cam") && r.exitCode === 0) && run.receipts.some(r => r.adapter.startsWith("cam-dexel-verify") && r.exitCode === 0));
  const report = { schema: "pai-cam-e2e-1", checkedAt: new Date().toISOString(), result: "passed", seconds: Math.round((Date.now() - t0) / 1000),
    runner: run.receipts.find(r => r.adapter.startsWith("freecad-cam"))?.adapter, programs: programs.map(p => p.split("/")[1]), cycleMinutes: verify.cycleMinutes, checks: verify.checks.map((c: { id: string; passed: boolean; observed: unknown }) => ({ id: c.id, passed: c.passed, observed: c.observed })),
    setups: verify.setups.map((s: Record<string, unknown>) => ({ setup: s.setup, minutes: s.minutes, cuttingMm: s.cuttingMm, toolLimited: s.toolLimited })),
    physicalValidation: false };
  await mkdir(join(config.state, "evidence"), { recursive: true });
  await writeFile(join(config.state, "evidence", "cam-e2e.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally { await app.close(); }
