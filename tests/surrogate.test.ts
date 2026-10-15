import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { SPECS } from "../scripts/surrogate-dataset-specs.js";

// The design uses the physics toolchain's pinned SciPy (Sobol); the core lane has no physics toolchain, the physics lane runs it.
const PY = process.env.PAI_PHYSICS_PYTHON;
const plan = (id: string) => JSON.parse(execFileSync(PY!, ["-I", "native/surrogate_dataset.py", "--spec", `native/surrogate-datasets/${id}.json`, "--output", "/tmp/unused", "--plan-only"], { encoding: "utf8" }));

test("dataset specs equal the product's requirements and load cases (no drifted copy)", async () => {
  for (const s of SPECS) assert.deepEqual(JSON.parse(await readFile(`native/surrogate-datasets/${s.id}.json`, "utf8")), s, s.id);
});

test("dataset designs are reproducible, start at the reference design and stay inside the design space", { skip: PY ? false : "needs PAI_PHYSICS_PYTHON (physics lane)" }, async () => {
  const space = JSON.parse(execFileSync("python3", ["-I", "-c", "import sys,json;sys.path.insert(0,'native');import design_space as d;print(json.dumps(d.FAMILIES))"], { encoding: "utf8" }));
  for (const s of SPECS) {
    const a = plan(s.id), b = plan(s.id);
    assert.equal(a.planSha256, b.planSha256, `${s.id} plan is deterministic`);
    assert.equal(a.points, s.design.n + 1);
    const fam = space[s.family];
    assert.deepEqual(a.first[0], { ...fam.reference, ...fam.fixed }, "reference design first");
    for (const p of a.first) for (const [k, [lo, hi]] of Object.entries(fam.bounds as Record<string, [number, number]>)) assert.ok(p[k] >= lo && p[k] <= hi, `${k}=${p[k]}`);
  }
});

test("measure (local job) → featurize → train → predict: reproducible end to end, predictions carry no authority", { skip: PY && process.env.PAI_CADQUERY_PYTHON && process.env.PAI_CCX ? false : "needs the physics and CadQuery toolchains" }, async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "pai-surrogate-"));
  const run = (py: string, args: string[]) => execFileSync(py, ["-I", "-W", "ignore", ...args], { encoding: "utf8", timeout: 900_000 });
  try {
    run(PY!, ["native/surrogate_dataset.py", "--spec", "native/surrogate-datasets/fea-bracket-v1.json", "--output", join(dir, "d"), "--backend", "local", "--limit", "12", "--concurrency", "3"]);
    const manifest = JSON.parse(await readFile(join(dir, "d", "manifest.json"), "utf8"));
    assert.equal(manifest.attempted, 12); assert.ok(manifest.measured >= 10, JSON.stringify(manifest));
    const row0 = JSON.parse((await readFile(join(dir, "d", "rows.jsonl"), "utf8")).split("\n")[0]);
    assert.deepEqual([row0.mass, row0.deflectionMm, row0.stressMPa], [48.368, 0.0478, 49], "reference bracket measured as in the FEA lane");
    for (const out of ["f1.npz", "f2.npz"]) run(process.env.PAI_CADQUERY_PYTHON!, ["native/surrogate_featurize.py", "--dataset", join(dir, "d"), "--output", join(dir, out)]);
    const train = (o: string) => JSON.parse(run(PY!, ["native/surrogate_train.py", "train", "--features", join(dir, "f1.npz"), "--output", join(dir, o), "--members", "1", "--epochs", "3", "--cv-epochs", "2"]).trim().split("\n").at(-1)!);
    const a = train("m1"), b = train("m2");
    assert.equal(a.weightsSha256, b.weightsSha256, "training is bit-reproducible");
    run(process.env.PAI_CADQUERY_PYTHON!, ["native/surrogate_featurize.py", "--step", join(dir, "d", "points", "0000", "part.step"), "--output", join(dir, "one.npz")]);
    const p = JSON.parse(run(PY!, ["native/surrogate_train.py", "predict", "--weights", join(dir, "m1", "weights.pt"), "--features", join(dir, "one.npz")]));
    assert.equal(p.authority, "suggestion"); assert.ok(p.deflectionMm > 0 && p.stressMPa > 0 && p.mass > 0);
    assert.equal(p.interval90.deflectionMm.length, 2);
    // The shipped held-out re-check reproduces the training-time benchmark exactly.
    const bench = JSON.parse(await readFile(join(dir, "m1", "benchmark.json"), "utf8"));
    const ev = JSON.parse(run(PY!, ["native/surrogate_train.py", "evaluate", "--weights", join(dir, "m1", "weights.pt"), "--features", join(dir, "m1", "heldout.npz")]));
    assert.deepEqual(ev.metrics, bench.surrogate); assert.equal(ev.weightsSha256, bench.weightsSha256);
    const f1 = await readFile(join(dir, "f1.npz")), f2 = await readFile(join(dir, "f2.npz"));
    assert.ok(f1.equals(f2), "features are deterministic");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Found on the hosted pillow dataset (2026-10-13): constant recipe values with a float std of ~1e-15 made the GP baseline
// divide by zero and the whole training run fail after an hour.
test("pillow family trains end to end (constant recipe values in the GP baseline)", { skip: PY && process.env.PAI_CADQUERY_PYTHON && process.env.PAI_CCX ? false : "needs the physics and CadQuery toolchains" }, async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "pai-surrogate-pillow-"));
  const run = (py: string, args: string[]) => execFileSync(py, ["-I", "-W", "ignore", ...args], { encoding: "utf8", timeout: 900_000 });
  try {
    run(PY!, ["native/surrogate_dataset.py", "--spec", "native/surrogate-datasets/fea-pillow-v1.json", "--output", join(dir, "d"), "--backend", "local", "--limit", "24", "--concurrency", "3"]);
    run(process.env.PAI_CADQUERY_PYTHON!, ["native/surrogate_featurize.py", "--dataset", join(dir, "d"), "--output", join(dir, "f.npz")]);
    const b = JSON.parse(run(PY!, ["native/surrogate_train.py", "train", "--features", join(dir, "f.npz"), "--output", join(dir, "m"), "--members", "1", "--epochs", "2", "--cv-epochs", "1"]).trim().split("\n").at(-1)!);
    assert.ok(b.weightsSha256 && b.gp, JSON.stringify(b));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("trainer: a shape descriptor that is constant in training is centred, not scaled by its ~0 spread", { skip: PY ? false : "needs the physics toolchain" }, () => {
  const out = execFileSync(PY!, ["-I", "-c", `import sys; sys.path.insert(0, "native"); import torch, surrogate_train as s
g = torch.tensor([[1.0, 0.36], [2.0, 0.36], [3.0, 0.36]]); mu, sd = s.global_scale(g)
print(round(float(sd[0]), 4), float(sd[1]), round(float((0.26 - mu[1]) / sd[1]), 4))`], { encoding: "utf8" }).trim();
  assert.equal(out, "1.0 1.0 -0.1", "varying descriptor scaled by its (sample) spread; constant one only centred");
});
