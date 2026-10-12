import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TWIN } from "../web/twin-evidence.js";

test("the twin figures shown in the UI are the recorded evidence, not copies that can drift", async () => {
  const ev = JSON.parse(await readFile("docs/evidence/yard-twin.json", "utf8"));
  assert.deepEqual(TWIN.fcfs, ev.policies.fcfs.kpi);
  assert.deepEqual(TWIN.cpSat, ev.policies["cp-sat"].kpi);
  assert.equal(TWIN.replans, ev.policies["cp-sat"].replans.length);
  assert.equal(TWIN.recordedAt, ev.recordedAt);
});
