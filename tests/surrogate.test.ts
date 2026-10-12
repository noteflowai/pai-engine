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
