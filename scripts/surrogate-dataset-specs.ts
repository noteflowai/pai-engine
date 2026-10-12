/**
 * Writes the surrogate dataset specs (native/surrogate-datasets/*.json) from the workbench's own defaults, so the data
 * is measured against exactly the requirements and load cases the product uses. tests/surrogate.test.ts checks equality.
 *   npx tsx scripts/surrogate-dataset-specs.ts
 */
import { writeFile } from "node:fs/promises";
import { FAMILY_DEFAULTS, FAMILY_STRUCTURAL } from "../src/cad.js";

export const SPECS = (["nema17-bracket", "pillow-block"] as const).map(family => ({
  schema: "pai-surrogate-dataset-spec-1", id: `fea-${family === "pillow-block" ? "pillow" : "bracket"}-v1`, family,
  purpose: "Training and held-out benchmark data for a geometry-to-structure surrogate (ranks only; the native solver decides).",
  design: { method: "sobol-scrambled+reference", seed: 20261012, n: 256 },
  requirements: FAMILY_DEFAULTS[family], structural: FAMILY_STRUCTURAL[family], synthetic: true,
}));
if (import.meta.url === `file://${process.argv[1]}`) {
  for (const s of SPECS) await writeFile(`native/surrogate-datasets/${s.id}.json`, JSON.stringify(s, null, 1) + "\n");
  console.log(SPECS.map(s => s.id).join(" "));
}
