/**
 * Surrogate screening of model-written parts (autopilot): several code variants are built and measured geometrically
 * in the sandbox, the family's released structural surrogate predicts each one, and only the best-ranked variant goes
 * to the full native review (CalculiX decides). Ranking is conservative, with the surrogate's 90 % upper bounds:
 *   1. geometry failures are dropped (they would be rejected by the B-Rep checks anyway);
 *   2. "likely to pass": upper deflection <= limit and upper stress <= allowable, in domain; the lightest first;
 *   3. then unknown (out of domain or no prediction), by measured B-Rep mass;
 *   4. then "likely to fail", by how close the upper deflection is to the limit.
 * Every screened variant is recorded with its prediction; nothing here is a verdict (authority none).
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { Store } from "./store.js";
import { screenGeneratedPart, FAMILY_STRUCTURAL, type CadFamily, type CadRequirements, type StructuralRequirements } from "./cad.js";
import { predictBeforeSolve, releasedSurrogate } from "./surrogate-lane.js";

export const YIELD_MPA = 276; // 6061-T6, as in native/fea_core.py
export interface ScreenedVariant {
  stepId: string; codeSha256: string; rank: number; chosen: boolean;
  geometry: { ok: boolean; massG?: number; failed?: string[]; reason?: string };
  prediction?: { deflectionMm: number; stressMPa: number; mass: number; upper: { deflectionMm: number; stressMPa: number }; inDomain: boolean } | null;
  class: "geometry-fail" | "likely-pass" | "unknown" | "likely-fail";
}
export interface Screening { surrogate: string; variants: ScreenedVariant[]; authority: "none"; note: string }

export function rankVariants(vs: Omit<ScreenedVariant, "rank" | "chosen" | "class">[], s: StructuralRequirements): ScreenedVariant[] {
  const allowable = YIELD_MPA / s.safetyFactor;
  const classed = vs.map(v => {
    const p = v.prediction;
    const cls: ScreenedVariant["class"] = !v.geometry.ok || (v.geometry.failed?.length ?? 0) > 0 ? "geometry-fail"
      : !p || !p.inDomain ? "unknown" : p.upper.deflectionMm <= s.maxDeflectionMm && p.upper.stressMPa <= allowable ? "likely-pass" : "likely-fail";
    return { ...v, class: cls };
  });
  const order = { "likely-pass": 0, unknown: 1, "likely-fail": 2, "geometry-fail": 3 } as const;
  const key = (v: typeof classed[number]) => v.class === "likely-pass" ? v.prediction!.mass : v.class === "unknown" ? v.geometry.massG ?? 1e9
    : v.class === "likely-fail" ? v.prediction!.upper.deflectionMm / s.maxDeflectionMm : 1e9;
  const sorted = [...classed].sort((a, b) => order[a.class] - order[b.class] || key(a) - key(b));
  return sorted.map((v, i) => ({ ...v, rank: i + 1, chosen: i === 0 && v.class !== "geometry-fail" }));
}

export async function screenVariants(store: Store, config: Config, family: CadFamily, requirements: CadRequirements,
  variants: { stepId: string; code: string }[], directory: string): Promise<Screening | undefined> {
  const surrogate = releasedSurrogate(store, family);
  const s = requirements.structural;
  if (!surrogate || !s) return undefined;
  const out: Omit<ScreenedVariant, "rank" | "chosen" | "class">[] = [];
  for (const [i, v] of variants.entries()) {
    const dir = join(directory, `variant-${i + 1}`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const g = await screenGeneratedPart(config, family, v.code, requirements, dir);
    if (!g.ok) { out.push({ stepId: v.stepId, codeSha256: g.codeSha256, geometry: { ok: false, reason: g.reason }, prediction: null }); continue; }
    const c = await predictBeforeSolve(store, config, family, s, FAMILY_STRUCTURAL[family], g.step, join(dir, "surrogate"));
    const p = c?.prediction;
    out.push({ stepId: v.stepId, codeSha256: g.codeSha256, geometry: { ok: true, massG: g.mass, failed: g.failed },
      prediction: p ? { deflectionMm: p.deflectionMm, stressMPa: p.stressMPa, mass: p.mass, inDomain: p.inDomain && c!.state === "predicted",
        upper: { deflectionMm: p.interval90.deflectionMm[1], stressMPa: p.interval90.stressMPa[1] } } : null });
  }
  return { surrogate: surrogate.id, variants: rankVariants(out, s), authority: "none",
    note: "Only the chosen variant is reviewed natively; the ranking used the surrogate's 90 % upper bounds and the B-Rep checks." };
}
