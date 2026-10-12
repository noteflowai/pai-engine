import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";

test("archive hides a task and changes nothing else; unarchive restores; reason required; audited", async () => {
  const state = await mkdtemp(join(tmpdir(), "pai-archive-"));
  const config = { ...configuration(), state };
  const { app } = await createApp(config);
  const host = `127.0.0.1:${config.port}`;
  const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, headers: { host, ...(payload ? { "content-type": "application/json" } : {}) }, ...(payload ? { payload: payload as object } : {}) });
    return { status: r.statusCode, body: r.json() };
  };
  try {
    const p = (await call("POST", "/api/projects", { title: "部署核验", intendedDecision: "测试归档功能是否只隐藏任务", requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } })).body;
    const before = (await call("GET", "/api/state")).body;
    assert.equal((await call("POST", `/api/projects/${p.id}/archive`, { archived: true, reason: "短" })).status, 400);
    const a = await call("POST", `/api/projects/${p.id}/archive`, { archived: true, reason: "部署核验任务，非业务" });
    assert.equal(a.status, 200); assert.equal(a.body.archived, true);
    const after = (await call("GET", "/api/state")).body;
    assert.deepEqual(after.projects, before.projects, "the task itself is unchanged");
    assert.deepEqual(after.projectArchives.map((x: { projectId: string; archived: boolean }) => [x.projectId, x.archived]), [[p.id, true]]);
    const u = await call("POST", `/api/projects/${p.id}/archive`, { archived: false, reason: "需要继续使用这个任务" });
    assert.equal(u.body.archived, false); assert.equal(u.body.revision, 2);
    assert.equal((await call("POST", `/api/projects/00000000-0000-4000-8000-000000000000/archive`, { archived: true, reason: "不存在的任务" })).status, 404);
    assert.equal((await call("GET", "/api/v1/audit?action=archiveTask")).body.total, 4);
  } finally { await app.close(); await rm(state, { recursive: true, force: true }); }
});
