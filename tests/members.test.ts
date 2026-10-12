import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { DomainError } from "../src/domain.js";
import { tenantSessionAllows, type Directory } from "../src/members.js";
import { createArtifact, type ArtifactVersion } from "../src/artifacts/registry.js";
import { saveWorkflow } from "../src/artifacts/workflows.js";
import { planning } from "./fixtures/workflows.js";

const ADMIN = randomUUID();
/** Stand-in for Cognito: records calls; every invited address gets a fresh subject. */
function fakeDirectory() {
  const calls: string[] = [], users = new Map<string, string>();
  const directory: Directory = {
    async invite(email) {
      if (users.has(email)) throw new DomainError("USER_EXISTS", "exists", 409);
      const sub = randomUUID(); users.set(email, sub); calls.push(`invite:${email}`); return { username: email, sub };
    },
    async resend(username) { calls.push(`resend:${username}`); },
    async disable(username) { calls.push(`disable:${username}`); },
  };
  return { directory, calls, sub: (email: string) => users.get(email)! };
}

async function hosted() {
  const state = await mkdtemp(join(tmpdir(), "pai-members-"));
  const config = { ...configuration(), state, logisticsPython: undefined, tenants: [],
    albAuth: { albArn: "arn:aws:elasticloadbalancing:ap-northeast-1:111111111111:loadbalancer/app/x/y", issuer: "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_Test", clientId: "web" },
    maintainerSubs: [ADMIN] };
  const fake = fakeDirectory();
  // Hosted verification is the ALB's signed token; here every request is "verified" and the subject is the header.
  const { app, store } = await createApp(config, undefined, { directory: fake.directory, authenticated: async h => typeof h["x-amzn-oidc-identity"] === "string" });
  const host = `127.0.0.1:${config.port}`;
  const as = (sub: string) => (method: "GET" | "POST", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { host, "x-amzn-oidc-identity": sub, ...(payload ? { "content-type": "application/json" } : {}) }, ...(payload ? { payload: payload as object } : {}) });
  return { app, store, fake, as, admin: as(ADMIN), cleanup: async () => { await app.close(); await rm(state, { recursive: true, force: true }); } };
}

test("default deny: an authenticated stranger gets only /api/session; the maintainer by subject gets everything", async () => {
  const h = await hosted();
  try {
    const stranger = h.as(randomUUID());
    assert.equal((await stranger("GET", "/api/state")).statusCode, 403);
    assert.equal((await stranger("GET", "/api/state")).json().error, "ACCESS_NOT_GRANTED");
    assert.equal((await stranger("POST", "/api/projects", { title: "x" })).statusCode, 403);
    assert.equal((await stranger("GET", "/api/session")).json().role, "none");
    assert.equal((await h.admin("GET", "/api/session")).json().role, "maintainer");
    assert.equal((await h.admin("GET", "/api/state")).statusCode, 200);
  } finally { await h.cleanup(); }
});

test("invite → Cognito e-mail → first sign-in: the member reaches only its tenant's offered workflows; revoke ends access at once", async () => {
  const h = await hosted();
  try {
    // Invite a new tenant's first member; the e-mail goes through the directory (Cognito sends the login details).
    const bad = await h.admin("POST", "/api/v1/tenant-members", { email: "a@example.com", tenant: "nova", reason: "试用合同已签" });
    assert.equal(bad.statusCode, 422, "unknown tenant without quotas");
    const inv = await h.admin("POST", "/api/v1/tenant-members", { email: " Ops@Example.com ", tenant: "nova", newTenant: { maxConcurrentRuns: 1, maxRunsPerDay: 5 }, reason: "试用合同已签" });
    assert.equal(inv.statusCode, 200, inv.body);
    const m = inv.json();
    assert.equal(m.email, "ops@example.com"); assert.equal(m.state, "invited"); assert.equal(m.tenant, "nova");
    assert.equal("sub" in m, false, "the subject is not shown");
    assert.deepEqual(h.fake.calls, ["invite:ops@example.com"]);
    assert.equal((await h.admin("POST", "/api/v1/tenant-members", { email: "ops@example.com", tenant: "nova", reason: "再次邀请同一地址" })).statusCode, 409);
    assert.ok((await h.admin("GET", "/api/v1/tenants")).json().tenants.some((t: { id: string }) => t.id === "nova"));
    // A stranger can not invite (not a maintainer).
    assert.equal((await h.as(randomUUID())("POST", "/api/v1/tenant-members", { email: "x@example.com", tenant: "nova", reason: "未授权的邀请" })).statusCode, 403);

    // The member signs in (hosted UI changes the temporary password); its session is the tenant, nothing else.
    const member = h.as(h.fake.sub("ops@example.com"));
    const session = (await member("GET", "/api/session")).json();
    assert.deepEqual([session.role, session.tenant, session.email], ["tenant", "nova", "ops@example.com"]);
    for (const url of ["/api/state", "/api/v1/audit", "/api/v1/tenant-members", "/api/v1/workflow-runs", "/api/projects"]) assert.equal((await member("GET", url)).statusCode, 403, url);
    assert.equal((await member("POST", "/api/projects", { title: "x" })).statusCode, 403);
    assert.equal((await member("GET", "/api/v1/tenant/catalog")).statusCode, 200);
    assert.deepEqual((await member("GET", "/api/v1/tenant/catalog")).json().workflows ?? [], [], "nothing offered yet");
    assert.equal((await h.admin("GET", "/api/v1/tenant-members")).json().members[0].state, "active");

    // Offered workflow: the member runs it in the browser with a synthetic input, under the tenant's quota.
    const a = await createArtifact(h.store, configuration(), { adapter: "logistics-pdptw", version: "1.0.0" }, "tester");
    h.store.put("artifact", <{ id: string }>{ ...a, revision: 2, state: "released", validation: { at: "t", passed: true, evidence: { unit: true }, runId: randomUUID(), usage: {} as never } }, 1);
    const w = saveWorkflow(h.store, planning(), "tester");
    assert.equal((await h.admin("POST", "/api/v1/offerings", { workflow: w.id, tenants: ["nova"], reason: "提供给试用租户" })).statusCode, 200);
    assert.deepEqual((await member("GET", "/api/v1/tenant/catalog")).json().workflows.map((x: { id: string }) => x.id), [w.id]);
    const f = join(tmpdir(), `p-${randomUUID()}.json`);
    execFileSync("python3", ["-I", "native/logistics_generate.py", "--seed", "1", "--orders", "3", "--vehicles", "1", "--output", f]);
    const problem = JSON.parse(await readFile(f, "utf8")); await rm(f);
    const run = await member("POST", "/api/v1/tenant/runs", { requestId: randomUUID(), workflow: w.id, inputs: { problem } });
    assert.ok([200, 202].includes(run.statusCode), run.body);
    const audit = (await h.admin("GET", "/api/v1/audit?action=startTenantRun")).json().events[0];
    assert.match(audit.actor, /^tenant:nova\/member:/, "audit names the member, not only the tenant");

    // Revoke: the very next request is refused, then the directory disables the user.
    const rv = await h.admin("POST", `/api/v1/tenant-members/${m.id}/revoke`, { reason: "试用期已结束" });
    assert.equal(rv.statusCode, 200, rv.body);
    assert.equal(rv.json().state, "revoked");
    assert.equal((await member("GET", "/api/v1/tenant/catalog")).statusCode, 403);
    assert.equal((await member("GET", "/api/session")).json().role, "none");
    assert.deepEqual(h.fake.calls.slice(-1), ["disable:ops@example.com"]);
    // Runs of the tenant are kept.
    assert.ok((await h.admin("GET", "/api/v1/workflow-runs")).json().some((r: { tenant: string }) => r.tenant === "nova"));
  } finally { await h.cleanup(); }
});

test("resend only while pending; failures are recorded and grant nothing", async () => {
  const h = await hosted();
  try {
    await h.admin("POST", "/api/v1/tenant-members", { email: "b@example.com", tenant: "nova", newTenant: {}, reason: "第二个租户试用" });
    const id = (await h.admin("GET", "/api/v1/tenant-members")).json().members[0].id;
    assert.equal((await h.admin("POST", `/api/v1/tenant-members/${id}/invitation`)).json().invitations, 2);
    await h.as(h.fake.sub("b@example.com"))("GET", "/api/session");
    assert.equal((await h.admin("POST", `/api/v1/tenant-members/${id}/invitation`)).statusCode, 409, "already active");
    // The directory refuses (e.g. the address already exists in the pool): recorded as failed, no session.
    h.fake.directory.invite = async () => { throw new DomainError("USER_EXISTS", "exists", 409); };
    assert.equal((await h.admin("POST", "/api/v1/tenant-members", { email: "c@example.com", tenant: "nova", reason: "地址已存在的情况" })).statusCode, 409);
    const failed = (await h.admin("GET", "/api/v1/tenant-members")).json().members.find((x: { email: string }) => x.email === "c@example.com");
    assert.deepEqual([failed.state, failed.error], ["failed", "USER_EXISTS"]);
  } finally { await h.cleanup(); }
});

test("tenant session scope is an allow-list", () => {
  assert.ok(tenantSessionAllows("GET", "/")); assert.ok(tenantSessionAllows("GET", "/assets/x.js"));
  assert.ok(tenantSessionAllows("POST", "/api/v1/tenant/runs")); assert.ok(tenantSessionAllows("GET", "/api/session?x=1"));
  for (const [m, u] of [["GET", "/api/state"], ["POST", "/api/v1/offerings"], ["GET", "/api/v1/tenants"], ["GET", "/api/v1/tenant-members"], ["POST", "/x"], ["GET", "/api/agent/state"]] as const)
    assert.equal(tenantSessionAllows(m, u), false, `${m} ${u}`);
});

test("hosted start requires named maintainers (no implicit admin)", async () => {
  const env = { ...process.env };
  try {
    Object.assign(process.env, { PAI_AUTH_ALB_ARN: "arn:aws:elasticloadbalancing:ap-northeast-1:111111111111:loadbalancer/app/x/y", PAI_AUTH_ISSUER: "https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_Test",
      PAI_AUTH_CLIENT_ID: "web", PAI_MAINTAINER_SUBS: "" });
    assert.throws(() => configuration(), /PAI_MAINTAINER_SUBS/);
    process.env.PAI_MAINTAINER_SUBS = "not-a-uuid";
    assert.throws(() => configuration(), /UUIDs/);
  } finally { process.env = env; }
});
