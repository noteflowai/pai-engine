import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.js";
import { DomainError } from "../src/domain.js";
import { nativeRun, type NativeRecord } from "../src/kernel/native-run.js";
import type { Project } from "../src/contracts.js";

type Rec = NativeRecord & { request: { requirements: { limit: number } }; verdict?: "accepted" | "rejected" };
const project: Project = { id: randomUUID(), title: "t", intendedDecision: "kernel test", revision: 2, createdAt: "",
  requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } };

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "pai-kernel-"));
  const store = new Store(join(dir, "w.sqlite"));
  const events: { kind: string; state?: string }[] = [];
  const live = { publish: (_k: string, e: { kind: string; state?: string }) => { events.push(e); } } as never;
  const run = (request: { requestId: string; projectRevision: number; feedbackId?: string; requirements: { limit: number } },
    work: (r: Rec) => Promise<"accepted" | "rejected">) => {
    const record: Rec = { id: randomUUID(), projectId: project.id, state: "running", createdAt: new Date().toISOString(), request, feedbackId: request.feedbackId };
    return nativeRun({ store, live, project, kind: "aero-review", evidenceKind: "aero-body", request, record, failure: "TEST_FAILED",
      recheck: { message: "Test recheck must bind the same feedback and unchanged requirements", sameRequirements: o => o.request.requirements.limit === request.requirements.limit }, work: async r => work(r) });
  };
  return { store, events, run, cleanup: async () => { store.close(); await rm(dir, { recursive: true, force: true }); } };
}

test("one request identity, one record: a repeat returns it without running again; other inputs conflict", async () => {
  const h = await harness();
  try {
    let calls = 0;
    const req = { requestId: randomUUID(), projectRevision: 2, requirements: { limit: 1 } };
    const a = await h.run(req, async () => { calls++; return "accepted"; });
    assert.deepEqual([a.state, a.verdict, calls], ["completed", "accepted", 1]);
    assert.ok(a.finishedAt);
    assert.equal((await h.run(req, async () => { calls++; return "rejected"; })).id, a.id); assert.equal(calls, 1);
    await assert.rejects(h.run({ ...req, requirements: { limit: 2 } }, async () => "accepted"), /REQUEST_CONFLICT|cannot be reused/);
    assert.deepEqual(h.events.map(e => e.kind), ["record", "done"]);
  } finally { await h.cleanup(); }
});

test("a stale revision fails before any work; domain errors keep their code, unexpected ones never leak", async () => {
  const h = await harness();
  try {
    let ran = false;
    const stale = await h.run({ requestId: randomUUID(), projectRevision: 1, requirements: { limit: 1 } }, async () => { ran = true; return "accepted"; });
    assert.equal(stale.state, "failed"); assert.match(stale.error!, /^REVISION_CONFLICT/); assert.equal(ran, false);
    const refused = await h.run({ requestId: randomUUID(), projectRevision: 2, requirements: { limit: 1 } }, async () => { throw new DomainError("SOURCE_CHANGED", "verifier changed"); });
    assert.equal(refused.error, "SOURCE_CHANGED: verifier changed");
    const crashed = await h.run({ requestId: randomUUID(), projectRevision: 2, requirements: { limit: 1 } }, async () => { throw new Error("/home/secret/path ENOENT"); });
    assert.equal(crashed.error, "TEST_FAILED: check native configuration and retained local receipts");
    assert.equal(h.store.get<Rec>("aero-review", crashed.id)!.state, "failed", "the failure is persisted");
  } finally { await h.cleanup(); }
});

test("a recheck must bind open feedback on the same kind and task with unchanged requirements", async () => {
  const h = await harness();
  try {
    const original = await h.run({ requestId: randomUUID(), projectRevision: 2, requirements: { limit: 1 } }, async () => "rejected");
    const feedback = (over: Record<string, unknown>) => { const id = randomUUID();
      h.store.insert("feedback", { id, projectId: project.id, runId: original.id, evidenceKind: "aero-body", status: "fix-proposed", history: [], ...over } as { id: string }); return id; };
    const recheck = (feedbackId: string, limit = 1) => h.run({ requestId: randomUUID(), projectRevision: 2, feedbackId, requirements: { limit } }, async () => "accepted");
    assert.equal((await recheck(feedback({}))).state, "completed");
    for (const [why, id, limit] of [["changed requirements", feedback({}), 2], ["closed feedback", feedback({ status: "open" }), 1],
      ["other evidence kind", feedback({ evidenceKind: "cad-part" }), 1], ["other task", feedback({ projectId: randomUUID() }), 1], ["missing", randomUUID(), 1]] as const) {
      const r = await recheck(id, limit);
      assert.match(r.error ?? "", /^INVALID_RECHECK: Test recheck must bind/, why);
    }
  } finally { await h.cleanup(); }
});
