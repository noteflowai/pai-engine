import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { Store } from "../src/store.js";
import { createArtifact, getArtifact, runOperation, validateArtifact } from "../src/artifacts/registry.js";
import { surrogateGate, SURROGATE_GATE } from "../src/artifacts/surrogate.js";
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
  const data = join(state, "surrogate", "datasets", "fea-bracket-v1"), model = join(state, "surrogate", "models", "fea-bracket-v1");
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
    const code = join(state, "oneshot"); await mkdir(code);
    const files = getArtifact(store, a.id).files; const { artifactFiles } = await import("../src/artifacts/registry.js");
    for (const [n, b] of Object.entries(artifactFiles(store, getArtifact(store, a.id)))) await writeFile(join(code, n), b);
    run(CQ!, [join(code, "surrogate_featurize.py"), "--step", join(data, "points", "0000", "part.step"), "--output", join(code, "one.npz")]);
    const oneShot = JSON.parse(run(PY!, [join(code, "surrogate_train.py"), "predict", "--weights", join(code, "weights.pt"), "--features", join(code, "one.npz"), "--domain", join(code, "domain.json")]));
    assert.deepEqual({ ...oneShot, ms: 0 }, { ...p, ms: 0 }, "resident = one-shot, byte for byte"); void files;
    await assert.rejects(runOperation(store, config, getArtifact(store, a.id), "predict", { geometry: { schema: "pai-part-geometry-1", family: "pillow-block", stepBase64: step.toString("base64") } }, {}, dir), /This surrogate is for nema17-bracket/);
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
