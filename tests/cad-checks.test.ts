import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CAD_REQUIREMENTS } from "../src/cad.js";

const PY = process.env.PAI_CADQUERY_PYTHON;
// Found by the surrogate dataset (2026-10-13): low plate heights inside the optimiser's own bounds produced holes on
// trimmed cylindrical surfaces, and the checks crashed instead of measuring. Every one of the 15 failed points now builds.
test("bracket checks measure holes on trimmed cylinders (plateHeight near the lower bound)", { skip: PY ? false : "needs CadQuery" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "pai-checks-"));
  try {
    for (const p of [{ thickness: 7.78, width: 77.2, plateHeight: 40.37 }, { thickness: 5.46, width: 48.83, plateHeight: 40.68 }]) {
      await writeFile(join(dir, "in.json"), JSON.stringify({ family: "nema17-bracket", parameters: { ...p, pilotBore: 22.5 }, requirements: DEFAULT_CAD_REQUIREMENTS }));
      execFileSync(PY!, ["-I", "-W", "ignore", "native/cad_point.py", "--input", join(dir, "in.json"), "--output", dir], { encoding: "utf8" });
      const point = JSON.parse(await readFile(join(dir, "point.json"), "utf8"));
      assert.ok(point.mass > 0 && point.checks.some((c: { id: string }) => c.id === "hole-edge-distance"), JSON.stringify(p));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
