import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { yardAdapter, YardProblem } from "../src/artifacts/yard.js";

const py = (args: string[]) => execFileSync("python3", ["-I", ...args], { encoding: "utf8" });

test("the yard verifier accepts the baseline schedule and rejects every kind of tampering", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-yard-"));
  try {
    const problem = join(dir, "p.json"), plan = join(dir, "fcfs.json"), out = join(dir, "v.json");
    py(["native/yard_generate.py", "--scenario", "peak", "--seed", "7", "--output", problem]);
    assert.deepEqual(YardProblem.safeParse(JSON.parse(await readFile(problem, "utf8"))).success, true);
    py(["native/yard_solve.py", "--problem", problem, "--output", plan, "--baseline"]);
    const verify = async (p: unknown) => { await writeFile(join(dir, "t.json"), JSON.stringify(p));
      py(["native/yard_verify.py", "--problem", problem, "--plan", join(dir, "t.json"), "--output", out]); return JSON.parse(await readFile(out, "utf8")); };
    const base = JSON.parse(await readFile(plan, "utf8"));
    const ok = await verify(base);
    assert.equal(ok.verdict, "valid-schedule");
    assert.ok(ok.peakUse.yardSlots <= ok.capacity.yardSlots);
    const admitted = base.plan.findIndex((r: { admitted: boolean }) => r.admitted);
    const cases: [string, (p: typeof base) => void][] = [
      ["handling-time", p => { p.plan[admitted].handleEnd -= 5; p.plan[admitted].departure -= 5; }],
      ["arrival-window", p => { p.plan[admitted].entry = 0; p.plan[admitted].handleStart = 6; p.plan[admitted].handleEnd = 6 + (p.plan[admitted].handleEnd - base.plan[admitted].handleStart); }],
      ["each-truck-once", p => { p.plan.pop(); }],
      ["totals", p => { p.totals.admitted += 1; }],
      ["dock-compatible", p => { p.plan[admitted].dock = "D99"; }],
    ];
    for (const [check, edit] of cases) {
      const p = JSON.parse(JSON.stringify(base)); edit(p);
      const v = await verify(p);
      assert.equal(v.verdict, "rejected", check);
      assert.ok(v.checks.some((c: { id: string; passed: boolean }) => c.id === check && !c.passed), `${check} not flagged: ${JSON.stringify(v.checks.filter((c: { passed: boolean }) => !c.passed).map((c: { id: string }) => c.id))}`);
    }
    // Squeezing every admitted truck into the same minute breaks the gate and yard capacity.
    const crowd = JSON.parse(JSON.stringify(base));
    for (const r of crowd.plan.filter((x: { admitted: boolean }) => x.admitted)) { const d = r.handleEnd - r.handleStart; r.entry = 60; r.handleStart = 66; r.handleEnd = 66 + d; r.departure = r.handleEnd + 10; }
    const v = await verify(crowd);
    assert.ok(["gate-capacity", "yard-capacity"].every(id => v.checks.find((c: { id: string }) => c.id === id).passed === false));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("yard problems are validated before any run: unique ids, windows, horizon", () => {
  const ok = { schema: "pai-yard-problem-1", synthetic: true, units: { time: "min", length: "m" }, horizonMin: 100,
    site: { name: "s", yardSlots: 2, crews: 1, exitMin: 5 }, gate: { lanes: 1, processMin: 5 }, docks: [{ id: "D1", cargo: ["standard"], maxLengthM: 18 }],
    trucks: [{ id: "T1", carrier: "c", cargo: "standard", lengthM: 12, slots: 1, crew: 1, arrival: [0, 10], handleMin: 20, latestDeparture: 90, priority: 1 }] };
  assert.deepEqual(yardAdapter.validateData("pai-yard-problem-1", ok), []);
  assert.ok(yardAdapter.validateData("pai-yard-problem-1", { ...ok, trucks: [ok.trucks[0], ok.trucks[0]] }).some(m => /unique/.test(m)));
  assert.ok(yardAdapter.validateData("pai-yard-problem-1", { ...ok, trucks: [{ ...ok.trucks[0], arrival: [10, 0] }] }).some(m => /window/.test(m)));
  assert.ok(yardAdapter.validateData("pai-yard-problem-1", { ...ok, trucks: [{ ...ok.trucks[0], latestDeparture: 200 }] }).length > 0);
  assert.deepEqual(yardAdapter.validateData("nope", {}), ["unknown schema nope"]);
});
