/** Progress events native scripts print as `PAI_EVENT {json}` (every lane): build stages, rays, render samples. */
import { z } from "zod";

export interface SceneStage { index: number; id: string; label: string; file: string; sha256: string; objects: string[] }
export const NativeEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), index: z.number().int().min(1).max(16), id: z.string().regex(/^[a-z-]{1,24}$/),
    label: z.string().max(80), file: z.string().regex(/^stages\/\d{2}-[a-z-]{1,24}\.glb$/), objects: z.array(z.string().max(80)).max(32) }).strict(),
  z.object({ type: z.literal("ray"), origin: z.array(z.number()).length(3), target: z.array(z.number()).length(3),
    hit: z.array(z.number()).length(3).nullable(), firstHit: z.string().max(80).nullable(), visible: z.boolean() }).strict(),
  z.object({ type: z.literal("render"), sample: z.number().int().min(0), samples: z.number().int().positive() }).strict(),
]);
