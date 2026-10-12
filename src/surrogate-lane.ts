/**
 * Structural surrogate in the CAD lane (step 4): before CalculiX solves a part, the released surrogate of its family
 * predicts deflection, stress and mass from the geometry alone; after the solve the prediction is compared with the
 * measurement. Record only: it never changes a check, a verdict or the solve itself, and a surrogate failure is
 * recorded, never raised. It applies only to the family's default load case (its training scope) and inside its domain.
 */
import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { Store } from "./store.js";
import { canonical } from "./domain.js";
import { getArtifact, runOperation, type ArtifactVersion } from "./artifacts/registry.js";
import type { CadFamily } from "./part-family.js";

export interface SurrogateComparison {
  artifact: string; digest: string; state: "predicted" | "not-applicable" | "failed"; reason?: string;
  prediction?: { deflectionMm: number; stressMPa: number; mass: number; interval90: Record<string, [number, number]>; inDomain: boolean; ms: number };
  measured?: { deflectionMm: number; stressMPa: number; mass: number };
  relError?: { deflectionMm: number; stressMPa: number; mass: number }; inInterval?: { deflectionMm: boolean; stressMPa: boolean; mass: boolean };
  authority: "none";
}
const semver = (v: string) => v.split(".").map(Number);
const newer = (a: ArtifactVersion, b: ArtifactVersion) => { const x = semver(a.manifest.version), y = semver(b.manifest.version); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; };

export function releasedSurrogate(store: Store, family: CadFamily): ArtifactVersion | undefined {
  const adapter = `structural-surrogate-${family === "pillow-block" ? "pillow" : "bracket"}`;
  return store.list<ArtifactVersion>("artifact").filter(a => a.manifest.adapter === adapter && a.state === "released").sort(newer).at(-1);
}

/** Prediction before the solve; undefined when no released surrogate exists for the family. */
export async function predictBeforeSolve(store: Store, config: Config, family: CadFamily, structural: Record<string, unknown>, defaults: Record<string, unknown>,
  step: string, directory: string): Promise<SurrogateComparison | undefined> {
  const a = releasedSurrogate(store, family);
  if (!a) return undefined;
  const base = { artifact: a.id, digest: a.digest, authority: "none" as const };
  const loadOf = (s: Record<string, unknown>) => ({ forceN: s.forceN, leverMm: s.leverMm, direction: s.direction ?? null });
  if (canonical(loadOf(structural)) !== canonical(loadOf(defaults))) return { ...base, state: "not-applicable", reason: "load case differs from the surrogate's training scope" };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const r = await runOperation(store, config, getArtifact(store, a.id), "predict",
      { geometry: { schema: "pai-part-geometry-1", family, stepBase64: (await readFile(step)).toString("base64") } }, {}, directory);
    if (r.state !== "ok") return { ...base, state: "failed", reason: r.error ?? "prediction failed" };
    const p = r.outputs.prediction as NonNullable<SurrogateComparison["prediction"]>;
    if (!p.inDomain) return { ...base, state: "not-applicable", reason: "geometry outside the surrogate's training domain", prediction: p };
    return { ...base, state: "predicted", prediction: p };
  } catch (e) {
    return { ...base, state: "failed", reason: e instanceof Error ? e.message.slice(0, 200) : "prediction failed" };
  }
}

/** Adds the measurement and the errors to a prediction. */
export function compare(c: SurrogateComparison, measured: { deflectionMm: number; stressMPa: number; mass: number }): SurrogateComparison {
  if (c.state !== "predicted" || !c.prediction) return { ...c, measured };
  const p = c.prediction, keys = ["deflectionMm", "stressMPa", "mass"] as const;
  const rel = Object.fromEntries(keys.map(k => [k, Math.round(Math.abs(p[k] - measured[k]) / Math.abs(measured[k]) * 10000) / 10000])) as SurrogateComparison["relError"];
  const inside = Object.fromEntries(keys.map(k => [k, measured[k] >= p.interval90[k][0] && measured[k] <= p.interval90[k][1]])) as SurrogateComparison["inInterval"];
  return { ...c, measured, relError: rel, inInterval: inside };
}
