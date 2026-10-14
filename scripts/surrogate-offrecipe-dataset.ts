/**
 * Off-recipe surrogate dataset: model-written-style CadQuery variants of the bracket template, each built in the
 * sandbox, checked by the shared B-Rep checks and solved by CalculiX on the fine mesh (measureGeneratedPart), with
 * the product's default requirements and load case. Output has the layout native/surrogate_featurize.py reads
 * (points/<index>/{row.json, part.step, fea.json, checks.json}, rows.jsonl, manifest.json with the rows digest).
 * Seeded and resumable: a verified point is never measured again; a failed point stays failed unless --remeasure-failed.
 *
 *   node --import tsx scripts/surrogate-offrecipe-dataset.ts <spec.json> <out-dir> [--limit N] [--concurrency 2] [--remeasure-failed]
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { FAMILY_DEFAULTS, FAMILY_STRUCTURAL, measureGeneratedPart } from "../src/cad.js";

const [specPath, out] = process.argv.slice(2).filter(a => !a.startsWith("--"));
const flag = (name: string) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const limit = Number(flag("--limit") ?? Infinity), concurrency = Math.max(1, Math.min(4, Number(flag("--concurrency") ?? 2)));
const remeasure = process.argv.includes("--remeasure-failed");
const config = configuration();
const specBytes = await readFile(specPath);
const spec = JSON.parse(specBytes.toString()) as { id: string; family: string; source: string; design: { seed: number; n: number; ranges: Record<string, [number, number]> } };
assert.equal(spec.family, "nema17-bracket"); assert.equal(spec.source, "code");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const requirements = { ...FAMILY_DEFAULTS["nema17-bracket"], structural: FAMILY_STRUCTURAL["nema17-bracket"] };
const template = await readFile(join(config.repository, "native/cad_template.py"), "utf8");

// mulberry32: the plan depends on the seed only.
let st = spec.design.seed; const rnd = () => { st |= 0; st = st + 0x6D2B79F5 | 0; let t = Math.imul(st ^ st >>> 15, 1 | st); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const R = spec.design.ranges, u = (k: string) => Math.round((R[k][0] + (R[k][1] - R[k][0]) * rnd()) * 100) / 100;
const plan = Array.from({ length: spec.design.n }, () => { const p = { T: u("T"), W: u("W"), D: u("D"), X: u("X"), RIB: u("RIB"), LEG: u("LEG") };
  const code = template.replace("T = 4.0  ", `T = ${p.T}  `).replace("W = 60.0 ", `W = ${p.W} `).replace("D = 30.0 ", `D = ${p.D} `)
    .replace("H = T + 46.0 ", `H = T + ${p.X} `).replace("RIB, RIB_LEG = 4.0, 20.0", `RIB, RIB_LEG = ${p.RIB}, ${p.LEG}`);
  assert.notEqual(code, template); return { parameters: p, code }; });
const planSha256 = sha(JSON.stringify(plan.map(p => p.parameters)));
await mkdir(join(out, "points"), { recursive: true, mode: 0o700 });
await writeFile(join(out, "spec.json"), specBytes);

type Row = Record<string, unknown> & { index: number; status: "measured" | "failed"; files?: Record<string, string> };
async function verified(dir: string): Promise<Row | undefined> {
  try { const r = JSON.parse(await readFile(join(dir, "row.json"), "utf8")) as Row;
    for (const [n, d] of Object.entries(r.files ?? {})) if (sha(await readFile(join(dir, n))) !== d) return undefined;
    return r; } catch { return undefined; }
}
const remeasured: number[] = [];
async function one(index: number): Promise<Row> {
  const dir = join(out, "points", String(index).padStart(4, "0"));
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const have = await verified(dir);
  if (have && !(have.status === "failed" && remeasure)) return have;
  if (have) { await rename(join(dir, "row.json"), join(dir, `row.failed-${Date.now()}.json`)); remeasured.push(index); }
  const { parameters, code } = plan[index], t0 = Date.now();
  const work = join(dir, "work");
  await rm(work, { recursive: true, force: true }); // a fresh build directory for every attempt
  let row: Row;
  try {
    const m = await measureGeneratedPart(config, code, requirements, work);
    if (!m.ok || !("fea" in m)) row = { index, parameters, status: "failed", codeSha256: m.codeSha256, error: (m as { reason?: string }).reason ?? "not measured" };
    else {
      for (const [from, to] of [[m.step, "part.step"], [m.fea, "fea.json"], [m.checksFile, "checks.json"]] as const) await copyFile(from, join(dir, to));
      const files = Object.fromEntries(await Promise.all(["part.step", "fea.json", "checks.json"].map(async n => [n, sha(await readFile(join(dir, n)))])));
      row = { index, parameters, status: "measured", codeSha256: m.codeSha256, mass: m.mass, deflectionMm: m.deflectionMm, stressMPa: m.stressMPa,
        failed: m.failed, motorAxisZ: m.motorAxisZ, runtime: m.runtime, files };
    }
  } catch (e) { row = { index, parameters, status: "failed", error: e instanceof Error ? e.message.slice(0, 240) : String(e) }; }
  row.seconds = (Date.now() - t0) / 1000;
  await writeFile(join(dir, "row.json"), JSON.stringify(row, null, 1) + "\n");
  console.log(JSON.stringify({ index, status: row.status, seconds: row.seconds, ...(row.error ? { error: row.error } : {}) }));
  return row;
}
const indices = plan.map((_, i) => i).slice(0, Number.isFinite(limit) ? limit : undefined);
const rows: Row[] = new Array(indices.length);
let next = 0;
await Promise.all(Array.from({ length: concurrency }, async () => { while (next < indices.length) { const i = next++; rows[i] = await one(indices[i]); } }));
const lines = rows.map(r => JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b))))).join("\n") + "\n";
await writeFile(join(out, "rows.jsonl"), lines);
const measured = rows.filter(r => r.status === "measured");
const here = join(config.repository, "native");
const manifest = { schema: "pai-surrogate-dataset-1", id: spec.id, family: spec.family, source: "code", specSha256: sha(specBytes), planSha256, planned: plan.length,
  attempted: rows.length, measured: measured.length, failed: rows.length - measured.length, rowsSha256: sha(lines), remeasured: remeasured.sort((a, b) => a - b),
  scripts: { "fea_bracket.py": sha(await readFile(join(here, "fea_bracket.py"))), "cad_sandbox.py": sha(await readFile(join(here, "cad_sandbox.py"))),
    "cad_generated.py": sha(await readFile(join(here, "cad_generated.py"))), "cad_template.py": sha(template) },
  load: requirements.structural, synthetic: true, physicalValidation: false };
await writeFile(join(out, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
console.log(JSON.stringify({ id: spec.id, planned: manifest.planned, attempted: manifest.attempted, measured: manifest.measured, failed: manifest.failed, rowsSha256: manifest.rowsSha256 }));
process.exit(0); // resident handles (none expected) must not keep a batch job alive
