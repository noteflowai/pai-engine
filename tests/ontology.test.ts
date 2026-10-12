import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configuration } from "../src/config.js";
import { createApp } from "../src/server.js";
import { rewriteAgentUrl } from "../src/agent-api.js";
import { ACTION_TYPES, LINK_TYPES, OBJECT_TYPES, describeOntology, ontologyTurtle } from "../src/ontology/model.js";

const REQ = { minSuccessRate: 0.5, preserveBaselineSuccess: true, requireSignificantImprovement: false, alpha: 0.05 };
async function sources(dir = "src"): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await sources(p)); else if (p.endsWith(".ts")) out.push(await readFile(p, "utf8"));
  }
  return out;
}

test("every stored record kind is exactly one object type, and every stored object type is stored somewhere", async () => {
  const text = (await sources()).join("\n");
  const kinds = new Set([...text.matchAll(/\b(?:store|from|r)\.(?:insert|put|list|get)(?:<[^>]*>)?\(\s*"([a-z][a-z-]+)"/g)].map(m => m[1]));
  for (const m of text.matchAll(/const FILE_KIND = "([a-z-]+)"/g)) kinds.add(m[1]);
  for (const m of text.matchAll(/store\.claim\([^;]*?"([a-z][a-z-]+)"\s*\)/g)) kinds.add(m[1]);
  const modelled: string[] = OBJECT_TYPES.filter(t => t.kind).map(t => t.kind!);
  assert.equal(new Set(modelled).size, modelled.length, "two object types share a kind");
  assert.deepEqual([...kinds].filter(k => !modelled.includes(k)).sort(), [], "stored kinds without an object type");
  assert.deepEqual(modelled.filter(k => !kinds.has(k)).sort(), [], "object types whose kind is never stored");
});

test("every write route is exactly one action type, and every action type is a real route", async () => {
  const state = await mkdtemp(join(tmpdir(), "pai-onto-"));
  const { app, routes } = await createApp({ ...configuration(), state });
  try {
    const writes = routes.filter(r => ["POST", "PATCH", "PUT", "DELETE"].includes(r.method)).map(r => `${r.method} ${r.url}`);
    const actions = ACTION_TYPES.map(a => `${a.method} ${a.route}`);
    assert.equal(new Set(actions).size, actions.length, "duplicate action routes");
    assert.equal(new Set(ACTION_TYPES.map(a => a.id)).size, ACTION_TYPES.length, "duplicate action ids");
    assert.deepEqual(writes.filter(w => !actions.includes(w)).sort(), [], "write routes without an action type");
    assert.deepEqual(actions.filter(a => !writes.includes(a)).sort(), [], "action types without a route");
  } finally { await app.close(); await rm(state, { recursive: true, force: true }); }
});

test("links and actions reference real object types; parameters export as JSON Schema; Turtle declares what it uses", () => {
  const ids = new Set(OBJECT_TYPES.map(t => t.id));
  for (const l of LINK_TYPES) {
    assert.ok(ids.has(l.from), l.id);
    for (const to of typeof l.to === "string" ? [l.to] : Object.values(l.to.map)) assert.ok(ids.has(to), `${l.id} -> ${to}`);
    // Links are reference fields (required ones are also listed as properties; optional ones such as feedbackId are not).
    assert.match(l.via, /^[a-z][A-Za-z]*Id$/, `${l.id} via ${l.via}`);
    if (typeof l.to !== "string") assert.ok(objectProps(l.from).includes(l.to.field), `${l.id} discriminator ${l.to.field}`);
  }
  for (const a of ACTION_TYPES) for (const w of a.writes) assert.ok(ids.has(w), `${a.id} writes ${w}`);
  const d = describeOntology();
  for (const a of d.actionTypes) if ("parameters" in a) assert.equal(typeof a.parameters, "object", a.id);
  // Only body-less actions (path id only) and the adapter-specific sample request go without a declared schema.
  const BODYLESS = ["revokeAutonomy", "validateArtifact", "resumeWorkflowRun", "sampleArtifactInput", "resendTenantInvitation"];
  assert.deepEqual(d.actionTypes.filter(a => !("parameters" in a)).map(a => a.id).sort(), [...BODYLESS].sort());
  const ttl = ontologyTurtle();
  const declared = new Set([...ttl.matchAll(/^pai:(\w+) a owl:Class/gm)].map(m => m[1]));
  for (const m of ttl.matchAll(/sh:class pai:(\w+)/g)) assert.ok(declared.has(m[1]), m[1]);
  assert.equal(declared.size, OBJECT_TYPES.length);
});
const objectProps = (id: string) => OBJECT_TYPES.find(t => t.id === id)!.properties;

test("ontology read API: model, Turtle, engines, objects with links in both directions; agent read scope only", async () => {
  const state = await mkdtemp(join(tmpdir(), "pai-onto-api-"));
  const config = configuration();
  const { app } = await createApp({ ...config, state });
  const host = { host: `127.0.0.1:${config.port}` };
  try {
    const model = await app.inject({ url: "/api/v1/ontology", headers: host });
    assert.equal(model.statusCode, 200);
    assert.match(model.json().digest, /^[a-f0-9]{64}$/);
    assert.equal(model.headers.etag, `"${model.json().digest}"`);
    assert.equal((await app.inject({ url: "/api/v1/ontology", headers: host })).json().digest, model.json().digest, "stable digest");
    const ttl = await app.inject({ url: "/api/v1/ontology.ttl", headers: host });
    assert.match(String(ttl.headers["content-type"]), /text\/turtle/);
    const engines = (await app.inject({ url: "/api/v1/engines", headers: host })).json().engines as { id: string; authority: string }[];
    assert.equal(engines.find(e => e.id === "strands-decider")?.authority, "suggestion");
    assert.equal(engines.find(e => e.id === "strands-robots")?.authority, "conformance");
    const p = (await app.inject({ method: "POST", url: "/api/projects", headers: { ...host, "content-type": "application/json" },
      payload: { title: "Ontology link check", intendedDecision: "Read API links", requirements: REQ } })).json();
    const list = (await app.inject({ url: "/api/v1/objects/DesignTask?limit=1", headers: host })).json();
    assert.equal(list.total, 1); assert.equal(list.items[0].title, "Ontology link check"); assert.equal(list.next, null);
    const task = (await app.inject({ url: `/api/v1/objects/DesignTask/${p.id}`, headers: host })).json();
    const version = task.links.incoming.find((l: { link: string }) => l.link === "RequirementVersion.task");
    assert.ok(version, "the frozen version links to its task");
    const v = (await app.inject({ url: `/api/v1/objects/RequirementVersion/${version.id}`, headers: host })).json();
    assert.deepEqual(v.links.outgoing, [{ link: "RequirementVersion.task", type: "DesignTask", id: p.id }]);
    assert.equal((await app.inject({ url: "/api/v1/objects/Engine", headers: host })).statusCode, 400);
    assert.equal((await app.inject({ url: "/api/v1/objects/NoSuchType", headers: host })).statusCode, 404);
    assert.equal((await app.inject({ url: "/api/v1/objects/DesignTask?after=missing", headers: host })).statusCode, 400);
    // Agents may read the ontology, never write through it.
    const raw = (url: string, method = "GET") => rewriteAgentUrl({ url, method });
    assert.equal(raw("/api/agent/v1/ontology"), "/api/v1/ontology");
    assert.equal(raw("/api/agent/v1/engines"), "/api/v1/engines");
    assert.equal(raw(`/api/agent/v1/objects/DesignTask/${p.id}`), `/api/v1/objects/DesignTask/${p.id}`);
    assert.equal(raw("/api/agent/v1/objects", "POST"), "/api/agent-not-found");
  } finally { await app.close(); await rm(state, { recursive: true, force: true }); }
});

test("agents read only the kinds /api/agent/state already exposes; artifact file bytes are never objects", async () => {
  const { AGENT_STATE_KINDS, agentReadable, objectReadable } = await import("../src/ontology/model.js");
  // The snapshot is generated from WORKSPACE_FIELDS: every field is present in a real response, nothing else is a record list.
  const { WORKSPACE_FIELDS } = await import("../src/ontology/model.js");
  const state = await mkdtemp(join(tmpdir(), "pai-onto-proj-"));
  const config = configuration();
  const { app } = await createApp({ ...config, state });
  try {
    const body = (await app.inject({ url: "/api/state", headers: { host: `127.0.0.1:${config.port}` } })).json();
    for (const field of Object.values(WORKSPACE_FIELDS)) assert.ok(Array.isArray(body[field]), field);
    assert.deepEqual([...AGENT_STATE_KINDS].sort(), Object.keys(WORKSPACE_FIELDS).sort());
  } finally { await app.close(); await rm(state, { recursive: true, force: true }); }
  for (const t of OBJECT_TYPES) if (agentReadable(t)) assert.ok(objectReadable(t));
  for (const id of ["TrialEvent", "Artifact", "ArtifactFile", "Workflow", "WorkflowRun"]) assert.equal(agentReadable(OBJECT_TYPES.find(t => t.id === id)!), false, id);
  assert.equal(objectReadable(OBJECT_TYPES.find(t => t.id === "ArtifactFile")!), false);
});

test("action parameters are the very schemas the routes parse", async () => {
  const src = (await sources()).join("\n");
  const modules = ["contracts", "scenes", "cad", "sweep", "optimize", "inspection", "aero", "factory", "assistant", "ai", "autonomy", "autopilot", "proposals",
    "release", "signing", "bundle", "artifacts/registry", "artifacts/workflows", "tenants", "members", "project-archive"];
  const exported: [string, unknown][] = [];
  for (const m of modules) exported.push(...Object.entries(await import(`../src/${m}.js`) as Record<string, unknown>));
  for (const a of ACTION_TYPES.filter(x => x.parameters)) {
    const name = exported.find(([, v]) => v === a.parameters)?.[0];
    assert.ok(name, `${a.id}: parameters must be an exported schema`);
    // The schema must be parsed somewhere (the route or the function it calls); no copy of it exists elsewhere.
    assert.match(src, new RegExp(`\\b${name}\\.(parse|safeParse)\\(`), `${a.id}: ${name} is not what the route parses`);
  }
});

test("real records carry every declared property; links resolve on them", async () => {
  const state = await mkdtemp(join(tmpdir(), "pai-onto-rec-"));
  const config = configuration();
  const { app, store } = await createApp({ ...config, state });
  const host = { host: `127.0.0.1:${config.port}`, "content-type": "application/json" };
  try {
    const p = (await app.inject({ method: "POST", url: "/api/projects", headers: host, payload: { title: "Props", intendedDecision: "Declared properties", requirements: REQ } })).json();
    await app.inject({ method: "PATCH", url: `/api/projects/${p.id}`, headers: host, payload: { title: "Props 2", intendedDecision: "Declared properties", requirements: REQ, expectedRevision: 1 } });
    await app.inject({ method: "POST", url: "/api/assistant/plans", headers: host, payload: { requestId: crypto.randomUUID(), projectId: p.id, message: "工厂能源评审，EV 充电不低于 80%" } });
    let checked = 0;
    for (const t of OBJECT_TYPES.filter(x => x.kind)) for (const r of store.list<Record<string, unknown>>(t.kind!)) {
      for (const prop of t.properties) assert.ok(prop in r, `${t.id}.${prop} missing on a real record`);
      for (const l of LINK_TYPES.filter(x => x.from === t.id && r[x.via])) {
        const to = typeof l.to === "string" ? l.to : l.to.map[String(r[l.to.field])];
        const target = OBJECT_TYPES.find(x => x.id === to)!;
        assert.ok(store.get(target.kind!, String(r[l.via])), `${l.id} does not resolve`);
      }
      checked++;
    }
    // DesignTask, two RequirementVersions and a Plan; native records are covered by test:native / test:robot.
    assert.ok(checked >= 4, `checked ${checked} records`);
  } finally { await app.close(); await rm(state, { recursive: true, force: true }); }
});

test("over HTTP an agent cannot read hidden types and never sees links from them; a maintainer can", async () => {
  const state = await mkdtemp(join(tmpdir(), "pai-onto-agent-"));
  const config = configuration();
  const { app, store } = await createApp({ ...config, state });
  const host = { host: `127.0.0.1:${config.port}` };
  try {
    const p = (await app.inject({ method: "POST", url: "/api/projects", headers: { ...host, "content-type": "application/json" },
      payload: { title: "Agent boundary", intendedDecision: "Agent reads only", requirements: REQ } })).json();
    // A hidden-kind record that points at the task (as a TrialEvent-like record would).
    store.insert("event", <{ id: string }>{ id: crypto.randomUUID(), kind: "started", actorKind: "fixture", at: new Date().toISOString(), projectId: p.id, participantId: "fixture-1" });
    const agent = (url: string) => app.inject({ url: `/api/agent${url}`, headers: host });
    assert.equal((await agent("/v1/objects/TrialEvent")).statusCode, 404);
    assert.equal((await agent("/v1/objects/Artifact")).statusCode, 404);
    const types = (await agent("/v1/objects")).json().types.map((t: { id: string }) => t.id);
    assert.ok(types.includes("DesignTask") && !types.includes("TrialEvent") && !types.includes("ArtifactFile"));
    const task = await agent(`/v1/objects/DesignTask/${p.id}`);
    assert.equal(task.statusCode, 200);
    assert.ok(task.json().links.incoming.every((l: { type: string }) => l.type !== "TrialEvent"));
    assert.equal((await app.inject({ url: "/api/v1/objects/TrialEvent", headers: host })).statusCode, 200, "the maintainer still reads it");
    assert.equal((await app.inject({ url: "/api/v1/objects/ArtifactFile", headers: host })).statusCode, 404, "file bytes are never objects");
  } finally { await app.close(); await rm(state, { recursive: true, force: true }); }
});

test("record kinds are defined once: the type, the object types and the store agree (ADR 0003 step 1)", async () => {
  const { RECORD_KINDS } = await import("../src/ontology/kinds.js");
  const modelled = OBJECT_TYPES.filter(t => t.kind).map(t => t.kind!).sort();
  assert.deepEqual([...RECORD_KINDS].sort(), modelled, "every record kind is one object type and vice versa");
  assert.equal(new Set(RECORD_KINDS).size, RECORD_KINDS.length);
  // Store methods accept only RecordKind: a misspelt kind no longer type-checks.
  const store = await readFile("src/store.ts", "utf8");
  for (const m of ["get<T>(kind: RecordKind", "list<T>(kind: RecordKind)", "count(kind: RecordKind)", "insert(kind: RecordKind", "put(kind: RecordKind", "kind: RecordKind = "]) assert.ok(store.includes(m), m);
});
