/**
 * Part families: the shared contract between the CAD lane (which builds and checks parts) and lanes that use a checked
 * part (a robot cell mounts one on its gripper). Leaf module: no lane imports another lane at runtime (ADR 0003 step 4).
 */
export const CAD_FAMILIES = ["nema17-bracket", "pillow-block"] as const;
export type CadFamily = (typeof CAD_FAMILIES)[number];
export const PILLOW_PRESETS = ["pillow-block", "pillow-block-light", "pillow-block-compact", "pillow-block-tight"] as const;
export const familyOf = (r: { variant: string; family?: CadFamily }): CadFamily =>
  (PILLOW_PRESETS as readonly string[]).includes(r.variant) ? "pillow-block" : r.family ?? "nema17-bracket";
