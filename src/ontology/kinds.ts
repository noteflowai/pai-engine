/**
 * Record kinds: the storage identity of every stored object type (ADR 0003 step 1). The ontology's object types use
 * exactly these, and the store accepts nothing else, so a misspelt kind is a compile error, not a runtime miss.
 */
export const RECORD_KINDS = [
  "project", "project-version", "review", "scene-review", "cad-review", "cad-sweep", "cad-optimize", "cad-inspection", "aero-review",
  "factory-criteria", "factory-review", "feedback", "campaign", "event", "assistant-plan", "proposal", "autonomy-grant", "autopilot",
  "release", "release-seal", "artifact", "artifact-file", "workflow", "workflow-run", "offering", "audit-event", "tenant", "tenant-member",
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];
export const isRecordKind = (k: string): k is RecordKind => (RECORD_KINDS as readonly string[]).includes(k);
