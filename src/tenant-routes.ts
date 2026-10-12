/**
 * HTTP surface for tenants (src/tenants.ts).
 *
 * Maintainer (browser session): list tenants, offer / revoke workflows, see tenant runs through the normal run routes.
 * Tenant (machine client, `pai-agent/tenant` scope, reached as /api/agent/v1/tenant/...): catalogue, start and read its own
 * runs, decide its own approval nodes, usage. The tenant is resolved by the server hook from the verified client id; a
 * browser request to a tenant route has no tenant and is refused.
 */
import type { RecordKind } from "./ontology/kinds.js";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Config } from "./config.js";
import { DomainError } from "./domain.js";
import type { Store } from "./store.js";
import type { Define } from "./kernel/actions.js";
import { decideRun, runData, startRun, type WorkflowRun } from "./artifacts/workflows.js";
import { allTenants, inviteMember, memberView, resendInvitation, revokeMember, TenantSample, type Directory, type TenantMember } from "./members.js";
import { sampleInput } from "./artifacts/registry.js";
import { catalog, checkQuota, offeredWorkflow, offerWorkflow, revokeOffering, TenantRunRequest, tenantRun, tenantUsage, type Offering, type Tenant } from "./tenants.js";

type Execute = <T extends { id: string; state: string }>(reply: FastifyReply, input: unknown, kind: RecordKind, route: string, execute: () => Promise<T>) => Promise<T>;
const RunId = z.object({ id: z.string().uuid() });
const DataQuery = z.object({ node: z.string().regex(/^[a-z][a-z0-9-]{0,30}$/).optional(), name: z.string().regex(/^[a-z][A-Za-z0-9]{0,30}$/) }).strict();
const UsageQuery = z.object({ since: z.string().regex(/^\d{4}-\d\d-\d\d(T[0-9:.]{2,12}Z)?$/).optional() }).strict();
/** What a tenant sees of its run: no actor identities of the operator, no local paths. */
/** Error codes only: run errors can carry operator identities (rejections) or host details (unexpected failures). */
const publicError = (e?: string) => !e ? null : /^[A-Z][A-Z_]{2,40}(?=:)/.exec(e)?.[0] ?? (/ rejected by /.test(e) ? "REJECTED_BY_OPERATOR" : "RUN_FAILED");
const view = (r: WorkflowRun) => ({ id: r.id, workflowId: r.workflowId, state: r.state, createdAt: r.createdAt, finishedAt: r.finishedAt ?? null, error: publicError(r.error),
  artifacts: r.artifacts, outputs: r.outputs ? Object.keys(r.outputs) : [],
  nodes: Object.fromEntries(Object.entries(r.nodes).map(([id, n]) => [id, { state: n.state, status: n.status ?? null, outputs: n.outputs ? Object.keys(n.outputs) : [], usage: n.usage ?? null }])) });

export function tenantRoutes(app: FastifyInstance, d: { store: Store; config: Config; actor: (h: Record<string, unknown>) => string; executeNative: Execute;
  tenant: (raw: unknown) => Tenant | undefined; track: (job: Promise<unknown>) => void; action: Define; directory?: Directory }) {
  const { store, config, action } = d;
  const tenants = () => allTenants(store, config);
  const me = (raw: unknown) => { const t = d.tenant(raw); if (!t) throw new DomainError("TENANT_REQUIRED", "Tenant credentials required", 403); return t; };

  // Maintainer side.
  app.get("/api/v1/tenants", async () => ({ tenants: tenants().map(t => ({ id: t.id, maxConcurrentRuns: t.maxConcurrentRuns, maxRunsPerDay: t.maxRunsPerDay, usage: tenantUsage(store, t) })) }));
  app.get("/api/v1/offerings", async () => store.list<Offering>("offering").reverse());
  action("offerWorkflow", async ({ request }) => offerWorkflow(store, tenants(), request.body, d.actor(request.headers)));
  action("revokeOffering", async ({ request }) => revokeOffering(store, RunId.parse(request.params).id, request.body, d.actor(request.headers)));

  // Members: people invited by e-mail to a tenant (src/members.ts). Personal data: maintainer routes only.
  app.get("/api/v1/tenant-members", async () => ({ members: store.list<TenantMember>("tenant-member").reverse().map(memberView) }));
  action("inviteTenantMember", async ({ request }) => inviteMember(store, config, d.directory, request.body, d.actor(request.headers)));
  action("resendTenantInvitation", async ({ request }) => resendInvitation(store, d.directory, RunId.parse(request.params).id));
  action("revokeTenantMember", async ({ request }) => revokeMember(store, d.directory, RunId.parse(request.params).id, request.body, d.actor(request.headers)));

  // Tenant side (internal paths; reachable from outside only as /api/agent/v1/tenant/...).
  // A labelled synthetic input for an offered workflow, from its first artifact's own generator.
  action("sampleTenantInput", async ({ request }) => {
    const t = me(request.raw), req = TenantSample.parse(request.body);
    const wf = offeredWorkflow(store, t, req.workflow);
    const ref = (wf.definition.nodes.find(n => n.type === "artifact") as { artifact: string } | undefined)?.artifact;
    if (!ref) throw new DomainError("NO_SAMPLES", "This workflow has no artifact to generate an input", 404);
    return sampleInput(store, config, ref, req.params);
  });
  app.get("/api/v1/tenant/catalog", async request => catalog(store, me(request.raw)));
  app.get("/api/v1/tenant/usage", async request => tenantUsage(store, me(request.raw), UsageQuery.parse(request.query).since));
  app.get("/api/v1/tenant/runs", async request => {
    const t = me(request.raw);
    return { runs: store.list<WorkflowRun>("workflow-run").filter(r => r.tenant === t.id).reverse().slice(0, 50).map(view) };
  });
  action("startTenantRun", async ({ request, reply }) => {
    const t = me(request.raw), req = TenantRunRequest.parse(request.body);
    offeredWorkflow(store, t, req.workflow);
    // A repeated request returns its run without counting against the quota again.
    if (!store.requestRun(req.requestId)) checkQuota(store, t);
    const run = await d.executeNative(reply, req, "workflow-run", "agent/v1/tenant/runs", () => startRun({ store, config }, req, `tenant:${t.id}`, t.id));
    return view(tenantRun(store, t, run.id));
  });
  app.get("/api/v1/tenant/runs/:id", async request => view(tenantRun(store, me(request.raw), RunId.parse(request.params).id)));
  app.get("/api/v1/tenant/runs/:id/data", async request =>
    runData(config, tenantRun(store, me(request.raw), RunId.parse(request.params).id), DataQuery.parse(request.query)));
  action("decideTenantRunStep", async ({ request, reply }) => {
    const t = me(request.raw), run = tenantRun(store, t, RunId.parse(request.params).id);
    // Continuing runs native nodes: only while the workflow is still offered and its artifacts released.
    offeredWorkflow(store, t, run.workflowId);
    const job = decideRun({ store, config }, run.id, request.body, `tenant:${t.id}`);
    d.track(job);
    const done = config.publicOrigin ? await Promise.race([job, new Promise<undefined>(r => setTimeout(r, 2000))]) : await job;
    if (!done) reply.code(202).header("Location", `/api/agent/v1/tenant/runs/${run.id}`).header("Retry-After", "2");
    return view(tenantRun(store, t, run.id));
  });
}
