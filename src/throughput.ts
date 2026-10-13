/**
 * Design-evaluation throughput, derived from the stored records only (nothing is counted separately, so the numbers
 * cannot drift from the evidence). One evaluation = one design assessed by an engine:
 * - solver: a CalculiX solve (CAD review with structural requirements, optimisation point, OpenFOAM case per body);
 * - geometry: a B-Rep check without a solve (CAD review without structure, sweep point, optimisation screen);
 * - surrogate: a structural-surrogate prediction recorded in a CAD review (predicted before the solve).
 * Per UTC day, plus the surrogate's recorded error against the solve it preceded.
 */
import type { Store } from "./store.js";
import type { CadReview } from "./cad.js";
import type { CadOptimization } from "./optimize.js";
import type { CadSweep } from "./sweep.js";
import type { AeroReview } from "./aero.js";

type Day = { day: string; solver: number; geometry: number; surrogate: number };
const dayOf = (iso: string) => iso.slice(0, 10);

export function evaluationThroughput(store: Store, days = 14, now = new Date()) {
  const by = new Map<string, Day>();
  const add = (iso: string | undefined, k: "solver" | "geometry" | "surrogate", n = 1) => {
    if (!iso || n <= 0) return;
    const d = dayOf(iso), row = by.get(d) ?? { day: d, solver: 0, geometry: 0, surrogate: 0 };
    row[k] += n; by.set(d, row);
  };
  const errors: { deflectionMm: number; stressMPa: number; mass: number; inInterval: boolean }[] = [];
  for (const c of store.list<CadReview>("cad-review").filter(c => c.state === "completed")) {
    const parts = (["baseline", "candidate"] as const).filter(w => c[w]);
    add(c.createdAt, c.fea ? "solver" : "geometry", parts.length);
    for (const w of parts) {
      const s = c.surrogate?.[w];
      if (s?.state === "predicted") {
        add(c.createdAt, "surrogate");
        if (s.relError && s.inInterval) errors.push({ ...s.relError, inInterval: Object.values(s.inInterval).every(Boolean) });
      }
    }
  }
  for (const o of store.list<CadOptimization>("cad-optimize").filter(o => o.result)) {
    add(o.createdAt, "solver", o.result!.points.filter(p => p.fidelity === "fea").length);
    add(o.createdAt, "geometry", o.result!.points.filter(p => p.fidelity === "geometry").length);
  }
  for (const s of store.list<CadSweep>("cad-sweep").filter(s => s.result)) add(s.createdAt, "geometry", s.result!.points.length);
  for (const a of store.list<AeroReview>("aero-review").filter(a => a.state === "completed")) add(a.createdAt, "solver", (["baseline", "candidate"] as const).filter(w => a[w]).length);
  const since = new Date(now.getTime() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const series = [...by.values()].filter(d => d.day >= since).sort((a, b) => a.day.localeCompare(b.day));
  const total = series.reduce((t, d) => ({ solver: t.solver + d.solver, geometry: t.geometry + d.geometry, surrogate: t.surrogate + d.surrogate }), { solver: 0, geometry: 0, surrogate: 0 });
  const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor((s.length - 1) / 2)]; };
  return { schema: "pai-evaluation-throughput-1", days, since, series, total,
    surrogate: { compared: errors.length, medianRelError: { deflectionMm: median(errors.map(e => e.deflectionMm)), stressMPa: median(errors.map(e => e.stressMPa)), mass: median(errors.map(e => e.mass)) },
      allInsideInterval: errors.filter(e => e.inInterval).length },
    note: "Counted from stored records. A surrogate prediction never replaces a solve: every compared prediction was followed by CalculiX." };
}
