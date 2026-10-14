import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { evaluationThroughput } from "../src/throughput.js";

test("throughput counts evaluations from records by kind and day; surrogate errors only where a solve followed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-tp-"));
  const store = new Store(join(dir, "w.sqlite"));
  try {
    const comp = (k: "deflectionMm" | "stressMPa" | "mass", inside = true) => ({ state: "predicted", relError: { deflectionMm: 0.02, stressMPa: 0.05, mass: 0.004 }, inInterval: { deflectionMm: inside, stressMPa: true, mass: true }, k });
    store.insert("cad-review", { id: "a", state: "completed", createdAt: "2026-10-13T01:00:00Z", baseline: {}, candidate: {}, fea: {}, surrogate: { baseline: comp("deflectionMm"), candidate: comp("deflectionMm", false) } } as never);
    store.insert("cad-review", { id: "b", state: "completed", createdAt: "2026-10-13T02:00:00Z", baseline: {}, candidate: {} } as never);
    store.insert("cad-review", { id: "c", state: "failed", createdAt: "2026-10-13T03:00:00Z", baseline: {} } as never);
    store.insert("cad-optimize", { id: "o", createdAt: "2026-10-12T05:00:00Z", result: { points: [{ fidelity: "fea" }, { fidelity: "fea" }, { fidelity: "geometry" }, { fidelity: "failed" }] } } as never);
    const t = evaluationThroughput(store, 14, new Date("2026-10-13T12:00:00Z"));
    assert.deepEqual(t.series, [{ day: "2026-10-12", solver: 2, geometry: 1, surrogate: 0 }, { day: "2026-10-13", solver: 2, geometry: 2, surrogate: 2 }]);
    assert.deepEqual(t.total, { solver: 4, geometry: 3, surrogate: 2 });
    assert.equal(t.surrogate.compared, 2); assert.equal(t.surrogate.allInsideInterval, 1); assert.equal(t.surrogate.medianRelError.deflectionMm, 0.02);
    assert.deepEqual(evaluationThroughput(store, 1, new Date("2026-10-13T12:00:00Z")).series.map(d => d.day), ["2026-10-13"]);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
