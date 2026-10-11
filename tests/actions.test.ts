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
