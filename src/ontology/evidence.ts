/**
 * Evidence kinds: the run types a feedback item, a campaign or a release can point at, and the record kind that stores
 * each. One table (ADR 0003 step 4); feedback, campaigns, releases, lifecycle, admission and the ontology all read it.
 */
import { z } from "zod";
import type { RecordKind } from "./kinds.js";

export const EVIDENCE_RECORD_KIND = {
  "robot-review": "review", "blender-scene": "scene-review", "factory-twin": "factory-review", "cad-part": "cad-review", "aero-body": "aero-review",
} as const satisfies Record<string, RecordKind>;
export type EvidenceKind = keyof typeof EVIDENCE_RECORD_KIND;
export const EVIDENCE_KINDS = Object.keys(EVIDENCE_RECORD_KIND) as [EvidenceKind, ...EvidenceKind[]];
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
