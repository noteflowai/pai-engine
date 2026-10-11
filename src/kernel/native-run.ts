/**
 * Native-run kernel (ADR 0003 step 2): the lifecycle every native review shares, implemented once.
 *
 *   claim by requestId (one request identity, one record; a repeat returns the recorded run, other inputs conflict)
 *   → announce the record on the live bus → bind a recheck to its feedback → lane work
 *   → completed with a verdict, or failed with a domain code (unexpected errors never leak details)
 *   → finishedAt, persisted, "done" on the live bus.
 *
 * Lanes keep only what is theirs: build inputs, call their solver, interpret checks. Nothing here retries or replays:
 * a run that was interrupted stays interrupted until a person reconciles it.
 */
import { canonical, DomainError, sha256 } from "../domain.js";
import type { Feedback, Project } from "../contracts.js";
import type { LiveBus } from "../live.js";
import type { RecordKind } from "../ontology/kinds.js";
import type { Store } from "../store.js";

export interface NativeRecord {
  id: string; projectId: string; state: "running" | "completed" | "failed" | "interrupted"; createdAt: string;
  finishedAt?: string; error?: string; verdict?: string; feedbackId?: string;
}

export interface RunSpec<R extends NativeRecord, Q extends { requestId: string; projectRevision: number; feedbackId?: string }> {
  store: Store; live?: LiveBus; project: Project;
  /** Store kind of the record, and the evidence kind that names it in request identities and feedback. */
  kind: RecordKind; evidenceKind: string;
  request: Q; record: R;
  /** Code for unexpected failures, e.g. "CFD_FAILED"; the message stays generic. */
  failure: string;
  /** For rechecks: the original run must have had these same requirements (lane-specific comparison). */
  recheck?: { message: string; sameRequirements: (original: R) => boolean };
  /** The lane's work: fill the record, return the verdict. Throw DomainError for expected refusals. */
  work: (record: R, publish: LiveBus["publish"]) => Promise<NonNullable<R["verdict"]>>;
}

export async function nativeRun<R extends NativeRecord, Q extends { requestId: string; projectRevision: number; feedbackId?: string }>(s: RunSpec<R, Q>): Promise<R> {
  const { store, request, record, kind } = s;
  const publish: LiveBus["publish"] = (key, event) => s.live?.publish(key, event);
  const claimed = store.claim(request.requestId, sha256(canonical({ kind: s.evidenceKind, projectId: s.project.id, request })), record, kind);
  if (claimed !== record.id) return store.get<R>(kind, claimed)!;
  publish(request.requestId, { kind: "record", recordKind: kind, recordId: record.id });
  try {
    if (s.project.revision !== request.projectRevision) throw new DomainError("REVISION_CONFLICT", "Freeze the current requirement revision");
    if (request.feedbackId) bindRecheck(store, s, request.feedbackId);
    record.verdict = await s.work(record, publish);
    record.state = "completed";
  } catch (e) {
    record.state = "failed";
    record.error = e instanceof DomainError ? `${e.code}: ${e.message}` : `${s.failure}: check native configuration and retained local receipts`;
  }
  record.finishedAt = new Date().toISOString();
  store.put(kind, record);
  publish(request.requestId, { kind: "done", state: record.state, recordId: record.id, verdict: record.verdict, detail: record.error });
  return record;
}

/** A recheck binds open feedback on a run of the same kind and task, with unchanged requirements. */
function bindRecheck<R extends NativeRecord>(store: Store, s: RunSpec<R, { requestId: string; projectRevision: number }>, feedbackId: string) {
  const f = store.get<Feedback>("feedback", feedbackId);
  const original = f ? store.get<R>(s.kind, f.runId) : undefined;
  if (!f || f.evidenceKind !== s.evidenceKind || f.projectId !== s.project.id || !["fix-proposed", "no-change-with-reason"].includes(f.status)
      || !original || !s.recheck?.sameRequirements(original)) {
    throw new DomainError("INVALID_RECHECK", s.recheck?.message ?? "Recheck must bind the same feedback and unchanged requirements");
  }
}
