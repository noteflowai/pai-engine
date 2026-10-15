import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { Store } from "../src/store.js";
import { createArtifact, getArtifact, runOperation, validateArtifact } from "../src/artifacts/registry.js";
import { resetSurrogateWorkers, surrogateGate, SURROGATE_GATE } from "../src/artifacts/surrogate.js";
import { closeAllWorkers } from "../src/kernel/engine-runtime.js";

const PY = process.env.PAI_PHYSICS_PYTHON, CQ = process.env.PAI_CADQUERY_PYTHON;

test("the acceptance gate: every target needs rank correlation, low median error and covering intervals", () => {
  const good = { metrics: { deflectionMm: { spearman: 0.99, medianRelError: 0.02 }, stressMPa: { spearman: 0.99, medianRelError: 0.03 }, mass: { spearman: 0.999, medianRelError: 0.003 } },
    conformal90Coverage: { deflectionMm: 0.9, stressMPa: 0.9, mass: 0.95 } };
  assert.deepEqual(surrogateGate(good), []);
  assert.equal(surrogateGate({ ...good, metrics: { ...good.metrics, stressMPa: { spearman: 0.85, medianRelError: 0.03 } } }).length, 1);
  assert.equal(surrogateGate({ ...good, conformal90Coverage: { ...good.conformal90Coverage, deflectionMm: 0.4 } })[0], "deflectionMm: 90 % interval coverage 0.4 < 0.8");
  assert.equal(SURROGATE_GATE.mass.minSpearman, 0.95);
});

test("surrogate artifact: build checks the data -> weights chain, acceptance re-runs held-out, predict is a suggestion", { skip: PY && CQ && process.env.PAI_CCX ? false : "needs the physics and CadQuery toolchains" }, async () => {
  const state = await mkdtemp(join(tmpdir(), "pai-surrogate-art-"));
  const config = { ...configuration(), state };
  const store = new Store(join(state, "w.sqlite"));
  const data = join(state, "surrogate", "datasets", "fea-bracket-v1"), model = join(state, "surrogate", "models", "fea-bracket-v2");
  const run = (py: string, args: string[]) => execFileSync(py, ["-I", "-W", "ignore", ...args], { encoding: "utf8", timeout: 900_000 });
  try {
    await assert.rejects(createArtifact(store, config, { adapter: "structural-surrogate-bracket", version: "0.1.0" }, "t"), /SURROGATE_NOT_TRAINED|missing/);
    run(PY!, ["native/surrogate_dataset.py", "--spec", "native/surrogate-datasets/fea-bracket-v1.json", "--output", data, "--backend", "local", "--limit", "14", "--concurrency", "3"]);
    await mkdir(model, { recursive: true });
    run(CQ!, ["native/surrogate_featurize.py", "--dataset", data, "--output", join(model, "features.npz")]);
    run(PY!, ["native/surrogate_train.py", "train", "--features", join(model, "features.npz"), "--output", model, "--members", "1", "--epochs", "3", "--cv-epochs", "2"]);
    const a = await createArtifact(store, config, { adapter: "structural-surrogate-bracket", version: "0.1.0" }, "tester");
    assert.equal(a.manifest.kind, "model"); assert.equal(a.state, "draft");
    // Three epochs on 14 rows cannot pass the gate: the failed acceptance is kept, the draft is never validated.
    const v = await validateArtifact(store, config, a.id, "tester");
    assert.equal(v.state, "draft"); assert.equal(v.validation!.passed, false);
    assert.equal((v.validation!.evidence as { reproducesTrainingReport: boolean }).reproducesTrainingReport, true);
    assert.ok(((v.validation!.evidence as { failed: string[] }).failed).length > 0);
    // Prediction on a real part: a suggestion with an interval and a domain verdict, executed by the artifact's own bytes.
    const step = await readFile(join(data, "points", "0000", "part.step"));
    const dir = join(state, "op"); await mkdir(dir);
    const r = await runOperation(store, config, getArtifact(store, a.id), "predict", { geometry: { schema: "pai-part-geometry-1", family: "nema17-bracket", stepBase64: step.toString("base64") } }, {}, dir);
    assert.equal(r.state, "ok", r.error ?? ""); const p = r.outputs.prediction as { authority: string; inDomain: boolean; interval90: { deflectionMm: number[] } };
    assert.equal(p.authority, "suggestion"); assert.equal(p.inDomain, true); assert.equal(p.interval90.deflectionMm.length, 2);
    // Resident workers: the first call starts them, later calls reuse them; every answer equals the one-shot command's.
    assert.ok(r.receipts.every(x => x.command[0] === "worker"), "served by the resident workers");
    const again = await runOperation(store, config, getArtifact(store, a.id), "predict", { geometry: { schema: "pai-part-geometry-1", family: "nema17-bracket", stepBase64: step.toString("base64") } }, {}, dir);
    assert.deepEqual({ ...again.outputs.prediction as object, ms: 0 }, { ...p, ms: 0 }, "same prediction from the warm workers");
    assert.ok(again.receipts[0].seconds < 2, `warm featurize ${again.receipts[0].seconds} s`);
    // A restart finds the previous serving directory and starts fresh workers (it once failed with EEXIST, silently).
    resetSurrogateWorkers(); await new Promise(r => setTimeout(r, 300));
    const restarted = await runOperation(store, config, getArtifact(store, a.id), "predict", { geometry: { schema: "pai-part-geometry-1", family: "nema17-bracket", stepBase64: step.toString("base64") } }, {}, dir);
    assert.ok(restarted.receipts.every(x => x.command[0] === "worker"), "workers again after a restart");
    const code = join(state, "oneshot"); await mkdir(code);
    const files = getArtifact(store, a.id).files; const { artifactFiles } = await import("../src/artifacts/registry.js");
    for (const [n, b] of Object.entries(artifactFiles(store, getArtifact(store, a.id)))) await writeFile(join(code, n), b);
    run(CQ!, [join(code, "surrogate_featurize.py"), "--step", join(data, "points", "0000", "part.step"), "--output", join(code, "one.npz")]);
    const oneShot = JSON.parse(run(PY!, [join(code, "surrogate_train.py"), "predict", "--weights", join(code, "weights.pt"), "--features", join(code, "one.npz"), "--domain", join(code, "domain.json")]));
    assert.deepEqual({ ...oneShot, ms: 0 }, { ...p, ms: 0 }, "resident = one-shot, byte for byte"); void files;
    await assert.rejects(runOperation(store, config, getArtifact(store, a.id), "predict", { geometry: { schema: "pai-part-geometry-1", family: "pillow-block", stepBase64: step.toString("base64") } }, {}, dir), /This surrogate is for nema17-bracket/);
    // Screening real model-written code: the template, a thinner plate (lighter) and broken code; only the sandbox,
    // the B-Rep checks and the surrogate run, nothing is reviewed. Needs the OS sandbox (bubblewrap).
    if (!process.env.PAI_SKIP_SANDBOX) {
      const { screenVariants } = await import("../src/surrogate-screen.js");
      const { DEFAULT_CAD_REQUIREMENTS, DEFAULT_STRUCTURAL } = await import("../src/cad.js");
      const cur = getArtifact(store, a.id); store.put("artifact", { ...cur, revision: cur.revision + 1, state: "released" } as never, cur.revision);
      const template = await readFile("native/cad_template.py", "utf8");
      const sc = await screenVariants(store, config, "nema17-bracket", { ...DEFAULT_CAD_REQUIREMENTS, structural: DEFAULT_STRUCTURAL }, [
        { stepId: "template", code: template }, { stepId: "thin", code: template.replace("T = 4.0  ", "T = 3.5  ") },
        { stepId: "broken", code: "import cadquery as cq\nresult = cq.Workplane('XY').box(1, 1, 1).undefined_call()\n" }], join(state, "screen"));
      assert.ok(sc, "a released surrogate screens");
      const by = Object.fromEntries(sc!.variants.map(v => [v.stepId, v]));
      assert.equal(by.broken.class, "geometry-fail"); assert.equal(by.broken.geometry.ok, false);
      assert.ok(by.template.geometry.ok && by.template.geometry.massG! > 40 && by.template.prediction, JSON.stringify(by.template));
      assert.ok(by.thin.geometry.massG! < by.template.geometry.massG!, "thinner is lighter by B-Rep");
      assert.equal(sc!.variants.filter(v => v.chosen).length, 1); assert.equal(sc!.authority, "none");
    }
    // Tampered weights break the chain: no new version can be built from them.
    const w = await readFile(join(model, "weights.pt")); w[w.length - 10] ^= 0xff; await writeFile(join(model, "weights.pt"), w);
    await assert.rejects(createArtifact(store, config, { adapter: "structural-surrogate-bracket", version: "0.1.1" }, "t"), /weights differ from the training report/);
  } finally { closeAllWorkers(); store.close(); await rm(state, { recursive: true, force: true }); }
});

test("in the CAD lane the surrogate is compared with the measurement and never decides", async () => {
  const { compare } = await import("../src/surrogate-lane.js");
  const c = compare({ artifact: "structural-surrogate-bracket@1.0.0", digest: "d", state: "predicted", authority: "none",
    prediction: { deflectionMm: 0.05, stressMPa: 50, mass: 48, interval90: { deflectionMm: [0.04, 0.06], stressMPa: [45, 55], mass: [47, 49] }, inDomain: true, ms: 9 } },
    { deflectionMm: 0.0478, stressMPa: 60, mass: 48.368 });
  assert.deepEqual(c.inInterval, { deflectionMm: true, stressMPa: false, mass: true });
  assert.equal(c.relError!.deflectionMm, 0.046); assert.equal(c.authority, "none");
  const na = compare({ artifact: "a", digest: "d", state: "not-applicable", reason: "load case", authority: "none" }, { deflectionMm: 1, stressMPa: 1, mass: 1 });
  assert.equal(na.relError, undefined);
});

test("screening ranks model-written variants conservatively: geometry failures last, likely-pass by mass, then unknown", async () => {
  const { rankVariants } = await import("../src/surrogate-screen.js");
  const { DEFAULT_STRUCTURAL } = await import("../src/cad.js");
  const P = (d: number, s: number, m: number, inDomain = true) => ({ deflectionMm: d, stressMPa: s, mass: m, inDomain, upper: { deflectionMm: d * 1.25, stressMPa: s * 1.2 } });
  const r = rankVariants([
    { stepId: "heavy-pass", codeSha256: "a", geometry: { ok: true, massG: 60, failed: [] }, prediction: P(0.03, 40, 60) },
    { stepId: "light-pass", codeSha256: "b", geometry: { ok: true, massG: 45, failed: [] }, prediction: P(0.04, 50, 45) },
    { stepId: "fail", codeSha256: "c", geometry: { ok: true, massG: 38, failed: [] }, prediction: P(0.058, 70, 38) },
    { stepId: "odd", codeSha256: "d", geometry: { ok: true, massG: 41, failed: [] }, prediction: P(0.03, 30, 41, false) },
    { stepId: "wall", codeSha256: "e", geometry: { ok: true, massG: 30, failed: ["min-wall"] }, prediction: P(0.02, 20, 30) },
    { stepId: "broken", codeSha256: "f", geometry: { ok: false, reason: "CAD_CODE_ERROR" }, prediction: null }], DEFAULT_STRUCTURAL);
  assert.deepEqual(r.map(v => [v.stepId, v.class]), [["light-pass", "likely-pass"], ["heavy-pass", "likely-pass"], ["odd", "unknown"], ["fail", "likely-fail"], ["wall", "geometry-fail"], ["broken", "geometry-fail"]]);
  assert.deepEqual(r.filter(v => v.chosen).map(v => v.stepId), ["light-pass"]);
  assert.equal(rankVariants([{ stepId: "x", codeSha256: "x", geometry: { ok: false }, prediction: null }], DEFAULT_STRUCTURAL)[0].chosen, false, "nothing is chosen when all fail geometry");
});

test("off-recipe data: measured from sandboxed code, trained together, benchmarked and gated per dataset", { skip: PY && CQ && process.env.PAI_CCX ? false : "needs the physics and CadQuery toolchains" }, async () => {
  const state = await mkdtemp(join(tmpdir(), "pai-offrecipe-"));
  const config = { ...configuration(), state };
  const store = new Store(join(state, "w.sqlite"));
  const ds = join(state, "surrogate", "datasets"), model = join(state, "surrogate", "models", "fea-bracket-v2");
  const run = (py: string, args: string[]) => execFileSync(py, ["-I", "-W", "ignore", ...args], { encoding: "utf8", timeout: 900_000 });
  try {
    run(PY!, ["native/surrogate_dataset.py", "--spec", "native/surrogate-datasets/fea-bracket-v1.json", "--output", join(ds, "fea-bracket-v1"), "--backend", "local", "--limit", "14", "--concurrency", "3"]);
    execFileSync(process.execPath, ["--env-file-if-exists=.state/demo.env", "--import", "tsx", "scripts/surrogate-offrecipe-dataset.ts", "native/surrogate-datasets/fea-bracket-offrecipe-v1.json",
      join(ds, "fea-bracket-offrecipe-v1"), "--limit", "10", "--concurrency", "3"], { encoding: "utf8", timeout: 900_000, env: { ...process.env, PAI_STATE: state } });
    const man = JSON.parse(await readFile(join(ds, "fea-bracket-offrecipe-v1", "manifest.json"), "utf8"));
    assert.equal(man.source, "code"); assert.equal(man.attempted, 10); assert.ok(man.measured >= 6, JSON.stringify(man));
    run(PY!, ["native/surrogate_build_model.py", "--spec", "native/surrogate-models/fea-bracket-v2.json", "--datasets", ds, "--output", model, "--cadquery", CQ!]);
    const bench = JSON.parse(await readFile(join(model, "benchmark.json"), "utf8"));
    assert.deepEqual(bench.datasets, ["fea-bracket-v1", "fea-bracket-offrecipe-v1"]); assert.deepEqual(bench.extraRowsSha256, [man.rowsSha256]);
    const a = await createArtifact(store, config, { adapter: "structural-surrogate-bracket", version: "1.1.0" }, "tester");
    assert.ok(a.files["extra-fea-bracket-offrecipe-v1-rows.jsonl"], "off-recipe rows ship with the version");
    const v = await validateArtifact(store, config, a.id, "tester");
    const ev = v.validation!.evidence as { datasets: string[]; failed: string[]; reproducesTrainingReport: boolean };
    assert.deepEqual(ev.datasets, bench.datasets); assert.equal(ev.reproducesTrainingReport, true);
    assert.ok(ev.failed.some(f => f.startsWith("fea-bracket-offrecipe-v1")), JSON.stringify(v.validation!.evidence).slice(0, 1500));
    assert.equal(v.state, "draft");
  } finally { closeAllWorkers(); store.close(); await rm(state, { recursive: true, force: true }); }
});

test("acceptance gate with several datasets: each needs its own held-out benchmark; no fallback to the overall numbers", async () => {
  const { acceptanceGate } = await import("../src/artifacts/surrogate.js");
  const good = { metrics: { deflectionMm: { spearman: 0.99, medianRelError: 0.02 }, stressMPa: { spearman: 0.99, medianRelError: 0.03 }, mass: { spearman: 0.999, medianRelError: 0.003 } },
    conformal90Coverage: { deflectionMm: 0.9, stressMPa: 0.9, mass: 0.95 } };
  assert.deepEqual(acceptanceGate(good, ["a"]), []);
  assert.ok(acceptanceGate(good, ["a", "b"]).length >= 2, "no subsets: both datasets fail");
  assert.deepEqual(acceptanceGate({ ...good, subsets: { a: { heldOut: 40, ...good }, b: { heldOut: 25, ...good } } }, ["a", "b"]), []);
  assert.deepEqual(acceptanceGate({ ...good, subsets: { a: { heldOut: 40, ...good }, b: { heldOut: 12, ...good } } }, ["a", "b"]), ["b: 12 held-out rows < 20"]);
  const offOk = { ...good, metrics: { ...good.metrics, deflectionMm: { spearman: 0.85, medianRelError: 0.08 } } };
  assert.deepEqual(acceptanceGate({ ...good, subsets: { a: { heldOut: 40, ...good }, b: { heldOut: 30, ...offOk } } }, ["a", "b"]), [], "the off-recipe gate is the looser one");
  assert.equal(acceptanceGate({ ...good, subsets: { a: { heldOut: 40, ...offOk }, b: { heldOut: 30, ...good } } }, ["a", "b"]).length, 1, "the recipe gate stays strict");
});

test("off-recipe plans are reproducible: the released bracket plan byte for byte, and every rule applies", () => {
  const plan = (spec: string) => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "scripts/surrogate-offrecipe-dataset.ts", spec, "/nonexistent", "--plan"], { encoding: "utf8" }).trim().split("\n").at(-1)!);
  // Pinned from the hosted fea-bracket-offrecipe-v1 manifest (structural-surrogate-bracket@1.1.0 was trained on it).
  assert.equal(plan("native/surrogate-datasets/fea-bracket-offrecipe-v1.json").planSha256, "e1d31ee950f909c3d7ecff924e23286f17f9d237970da4246c87cdc5d891457a");
  assert.match(plan("native/surrogate-datasets/fea-pillow-offrecipe-v1.json").codeSha256, /^[0-9a-f]{64}$/);
});
