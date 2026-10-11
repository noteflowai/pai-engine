import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
/**
 * Architecture contract (ADR 0003): the runtime import graph of src/ has no cycles; lanes (CAD, scenes / robot cells,
 * aero, factory, artifact adapters) do not import one another at runtime; the kernel and the ontology depend on no lane.
 * Type-only imports are compile-time and do not count.
 */
const LANES = ["src/cad.ts", "src/scenes.ts", "src/aero.ts", "src/factory.ts", "src/artifacts/logistics.ts", "src/artifacts/yard.ts"];
/** Product modules that reach lanes only through the lane registry (src/lanes.ts); the list grows as modules migrate. */
const VIA_REGISTRY = ["src/autonomy.ts", "src/release.ts"];
const CORE = (f: string) => f.startsWith("src/kernel/") || f.startsWith("src/ontology/kinds") || f.startsWith("src/ontology/evidence") || f === "src/part-family.ts";

/** Runtime (value) import edges between src files. `import type`, `export type` and all-`type` specifier lists are skipped. */
const STATEMENT = /^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/gm;
async function graph() {
  const files = (await readdir("src", { recursive: true })).map(f => `src/${f}`).filter(f => f.endsWith(".ts"));
  const edges = new Map<string, Set<string>>();
  for (const f of files) {
    const out = new Set<string>();
    for (const m of (await readFile(f, "utf8")).matchAll(STATEMENT)) {
      const [, , typeOnly, clause, spec] = m;
      if (!spec.startsWith(".") || typeOnly) continue;
      const braces = /^\{([\s\S]*)\}$/.exec(clause.trim());
      if (braces && braces[1].split(",").map(x => x.trim()).filter(Boolean).every(x => x.startsWith("type "))) continue;
      out.add(normalize(join(dirname(f), spec.replace(/\.js$/, ".ts"))));
    }
    edges.set(f, out);
  }
  return edges;
}

test("the runtime import graph of src has no cycles", async () => {
  const g = await graph(), state = new Map<string, number>(), stack: string[] = [], cycles: string[] = [];
  const visit = (n: string) => {
    state.set(n, 1); stack.push(n);
    for (const m of g.get(n) ?? []) {
      if (state.get(m) === 1) cycles.push([...stack.slice(stack.indexOf(m)), m].join(" > "));
      else if (!state.get(m)) visit(m);
    }
    stack.pop(); state.set(n, 2);
  };
  for (const n of g.keys()) if (!state.get(n)) visit(n);
  assert.deepEqual(cycles, []);
});

test("lanes never import each other at runtime; the kernel and shared contracts import no lane", async () => {
  const g = await graph(), problems: string[] = [];
  for (const lane of LANES) for (const dep of g.get(lane) ?? []) if (LANES.includes(dep)) problems.push(`${lane} -> ${dep}`);
  for (const [f, deps] of g) if (CORE(f) || VIA_REGISTRY.includes(f)) for (const dep of deps) if (LANES.includes(dep) || (dep === "src/optimize.ts" && f !== "src/lanes.ts")) problems.push(`${f} -> ${dep}`);
  assert.deepEqual(problems, []);
});
