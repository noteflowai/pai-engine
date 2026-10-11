import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { ZodError } from "zod";
import { DomainError } from "../src/domain.js";
import { actionRuntime, allowed, type Caller } from "../src/kernel/actions.js";
import { ACTION_TYPES } from "../src/ontology/model.js";
import { RevokeOffering } from "../src/tenants.js";
import { AGENT_ROUTES } from "../src/agent-api.js";

const byId = (id: string) => ACTION_TYPES.find(a => a.id === id)!;

test("the runtime authorizes callers by the action's submitters before the handler runs", async () => {
  let caller: Caller = { kind: "maintainer" };
  const app = Fastify();
  app.setErrorHandler((e, _r, reply) => e instanceof DomainError ? reply.code(e.status).send({ error: e.code }) : e instanceof ZodError ? reply.code(400).send({ error: "INVALID_INPUT" }) : reply.code(500).send({}));
  const action = actionRuntime(app, () => caller);
  let ran = 0;
  action("revokeOffering", async ({ input }) => { ran++; RevokeOffering.parse(input); return { ok: true }; });
  action("startTenantRun", async ({ input }) => { ran++; return input; });
  action("checkCadCode", async () => { ran++; return { ok: true }; });
  const post = (url: string, payload: unknown) => app.inject({ method: "POST", url, payload: payload as object });
  const id = "00000000-0000-4000-8000-000000000000";
  assert.equal((await post(`/api/v1/offerings/${id}/revoke`, { reason: "pilot ended" })).statusCode, 200);
  assert.equal((await post(`/api/v1/offerings/${id}/revoke`, { reason: "x" })).statusCode, 400, "the domain schema still rejects bad input");
  caller = { kind: "agent", scope: "read" };
  assert.equal((await post(`/api/v1/offerings/${id}/revoke`, { reason: "pilot ended" })).json().error, "ACTION_FORBIDDEN");
  assert.equal((await post("/api/cad/code-check", { code: "x" })).statusCode, 200, "agent:read may run the code check");
  caller = { kind: "tenant", tenant: "acme" };
  const run = { requestId: id, workflow: "w@1", inputs: {} };
  assert.deepEqual((await post("/api/v1/tenant/runs", run)).json(), run);
  assert.equal((await post(`/api/v1/offerings/${id}/revoke`, { reason: "pilot ended" })).statusCode, 403, "tenants cannot revoke");
  caller = { kind: "maintainer" };
  assert.equal((await post("/api/v1/tenant/runs", run)).statusCode, 403, "a maintainer session is not a tenant");
  assert.equal(ran, 4, "refused callers never reach the handler");
  assert.throws(() => action("noSuchAction", () => undefined), /No action type/);
  await app.close();
});

test("every agent write route is an action that lists that agent scope (or tenant) as a submitter", () => {
  for (const r of AGENT_ROUTES.filter(x => x.method === "POST")) {
    const path = `/api${r.pattern.source.replace(/^\^|\$$/g, "").replace(/\\\//g, "/").replace(/\[0-9a-f-\]\{36\}/g, ":id")}`;
    const a = ACTION_TYPES.find(x => x.method === "POST" && x.route === path);
    assert.ok(a, `agent route ${path} has no action type`);
    assert.ok(allowed(a, r.scope === "tenant" ? { kind: "tenant", tenant: "t" } : { kind: "agent", scope: r.scope }), `${a.id} does not list ${r.scope}`);
  }
  assert.equal(allowed(byId("decideRelease"), { kind: "agent", scope: "run" }), false, "no agent scope can release");
});

test("every write route in src is registered through the action runtime; none by hand", async () => {
  const { readdir } = await import("node:fs/promises");
  const files = (await readdir("src", { recursive: true })).filter(f => String(f).endsWith(".ts")).map(f => `src/${f}`);
  for (const f of files) assert.doesNotMatch(await readFile(f, "utf8"), /app\.(post|patch|put|delete)\(/, `${f} registers a write route by hand`);
});

test("every write attempt leaves one audit record (done, invalid, refused) without the request body; only maintainers read it", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { configuration } = await import("../src/config.js");
  const { createApp } = await import("../src/server.js");
  const { parseTenants } = await import("../src/tenants.js");
  const state = await mkdtemp(join(tmpdir(), "pai-audit-"));
  const config = { ...configuration(), state, tenants: parseTenants(JSON.stringify([{ id: "acme", clientId: "acmeclient" }])) };
  const { app } = await createApp(config);
  const host = `127.0.0.1:${config.port}`, json = { "content-type": "application/json" };
  try {
    const secret = "SECRET-INTENDED-DECISION-TEXT";
    await app.inject({ method: "POST", url: "/api/projects", headers: { host, ...json }, payload: { title: "Audit", intendedDecision: secret,
      requirements: { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 } } });
    await app.inject({ method: "POST", url: "/api/projects", headers: { host, ...json }, payload: { title: "" } });
    await app.inject({ method: "POST", url: "/api/agent/v1/tenant/runs", headers: { host, ...json, "x-pai-tenant": "acme" },
      payload: { requestId: "00000000-0000-4000-8000-000000000000", workflow: "none@1", inputs: {} } });
    const audit = (await app.inject({ url: "/api/v1/audit", headers: { host } })).json();
    const outcomes = audit.events.map((e: { action: string; outcome: string; caller: { kind: string } }) => `${e.action}:${e.outcome}:${e.caller.kind}`).sort();
    assert.deepEqual(outcomes, ["createTask:done:maintainer", "createTask:invalid:maintainer", "startTenantRun:invalid:tenant"]);
    assert.ok(!JSON.stringify(audit).includes(secret), "no request body in the audit log");
    assert.equal(audit.events.find((e: { action: string; outcome: string }) => e.outcome === "done").actor, "local-maintainer");
    assert.equal((await app.inject({ url: "/api/agent/v1/audit", headers: { host } })).statusCode, 404, "not reachable for agents");
    assert.equal((await app.inject({ url: "/api/agent/v1/objects/AuditEvent", headers: { host } })).statusCode, 404, "not an agent-readable object");
  } finally { await app.close(); await rm(state, { recursive: true, force: true }); }
});
