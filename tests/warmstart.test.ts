import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { sha256 } from "../src/domain.js";
import { DEFAULT_STRUCTURAL, PILLOW_STRUCTURAL } from "../src/cad.js";
import { surrogateDatasetPrior } from "../src/optimize.js";

/** A released surrogate with two dataset files, stored the way the registry stores artifact files. */
function release(store: Store, adapter: string, spec: unknown, rows: unknown[], state = "released") {
  const id = `${adapter}@1.0.0`;
  const files: Record<string, Buffer> = { "dataset-spec.json": Buffer.from(JSON.stringify(spec)), "dataset-rows.jsonl": Buffer.from(rows.map(r => JSON.stringify(r)).join("\n") + "\n") };
  for (const [n, b] of Object.entries(files)) store.insert("artifact-file", { id: `${id}/${n}`, sha256: sha256(b), contentBase64: b.toString("base64") } as never);
  store.insert("artifact", { id, revision: 1, state, digest: "d", manifest: { adapter, version: "1.0.0" }, files: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, sha256(b)])) } as never);
}

test("warm start from a released surrogate's dataset: same load case only, measured rows only, searched axes only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-warm-"));
  const store = new Store(join(dir, "w.sqlite"));
  try {
    assert.deepEqual(surrogateDatasetPrior(store, "nema17-bracket", DEFAULT_STRUCTURAL), [], "no released surrogate: nothing");
    release(store, "structural-surrogate-bracket", { structural: DEFAULT_STRUCTURAL }, [
      { status: "measured", parameters: { thickness: 4, width: 60, plateHeight: 46, pilotBore: 22.5 }, deflectionMm: 0.0478, stressMPa: 49, mass: 48.368 },
      { status: "failed", parameters: { thickness: 7.78, width: 77.2, plateHeight: 40.37, pilotBore: 22.5 } }]);
    const rows = surrogateDatasetPrior(store, "nema17-bracket", DEFAULT_STRUCTURAL);
    assert.deepEqual(rows, [{ parameters: { thickness: 4, width: 60, plateHeight: 46 }, deflectionMm: 0.0478, stressMPa: 49, mass: 48.368, source: "structural-surrogate-bracket@1.0.0" }]);
    assert.deepEqual(surrogateDatasetPrior(store, "nema17-bracket", { ...DEFAULT_STRUCTURAL, forceN: 80 }), [], "another load case: nothing");
    release(store, "structural-surrogate-pillow", { structural: PILLOW_STRUCTURAL }, [
      { status: "measured", parameters: { width: 108, depth: 20, baseThickness: 10, boltPitch: 76, baseDepth: 36 }, deflectionMm: 0.0052, stressMPa: 14.8, mass: 189.6, boreDistortionMm: 0.002 }], "validated");
    assert.deepEqual(surrogateDatasetPrior(store, "pillow-block", PILLOW_STRUCTURAL), [], "a validated but unreleased surrogate is not used");
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
