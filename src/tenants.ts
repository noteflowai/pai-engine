/**
 * Tenants: invite-only external use of the platform (ADR 0002 §5).
 *
 * - A tenant is a Cognito app client (OAuth client credentials) with the single scope `pai-agent/tenant`, created per
 *   tenant by the stack; `PAI_TENANTS` maps client id -> tenant id and quotas. Without a tenant entry a token is refused.
 * - A tenant may only run workflows a maintainer has *offered* to it, and only while every artifact version they pin is
 *   `released` (not merely validated). Offering and revoking are maintainer actions with a reason.
 * - Isolation: a tenant run carries the tenant id; every tenant read filters by it (another tenant's run is 404), and the
 *   request identity includes the tenant. Maintainer-agent scopes (read / propose / run) never reach tenant routes and
 *   the tenant scope never reaches workspace routes.
 * - Quotas: concurrent runs (running or waiting for a decision) and runs started per rolling 24 h, checked before a run
 *   starts (429). Usage is pai-usage-1 per node, summed per tenant; `priceVersion` stays null: nothing is billed.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.js";
import { DomainError } from "./domain.js";
import type { Store } from "./store.js";
import type { ArtifactVersion } from "./artifacts/registry.js";
import type { Workflow, WorkflowRun } from "./artifacts/workflows.js";
import type { Usage } from "./artifacts/contract.js";

export { TENANT_ID, TenantConfig, parseTenants, type Tenant } from "./tenant-config.js";
import { TENANT_ID, type Tenant } from "./tenant-config.js";

export interface Offering {
  id: string; revision: number; workflowId: string; workflowDigest: string; tenants: string[]; state: "active" | "revoked";
  reason: string; createdAt: string; createdBy: string; revokedAt?: string; revokedBy?: string; revokeReason?: string;
}
export const OfferWorkflow = z.object({ workflow: z.string().min(1).max(120), tenants: z.array(z.string().regex(TENANT_ID)).min(1).max(100),
  reason: z.string().trim().min(5).max(500) }).strict();
export const RevokeOffering = z.object({ reason: z.string().trim().min(5).max(500) }).strict();
export const TenantRunRequest = z.object({ requestId: z.string().uuid(), workflow: z.string().min(1).max(120), inputs: z.record(z.string(), z.unknown()) }).strict();

const releasedOnly = (store: Store, w: Workflow) => {
  for (const node of w.definition.nodes) if (node.type === "artifact") {
    const a = store.get<ArtifactVersion>("artifact", node.artifact);
    if (a?.state !== "released") throw new DomainError("NOT_RELEASED", `${node.artifact} is ${a?.state ?? "missing"}; tenants run released versions only`, 409);
  }
};

export function offerWorkflow(store: Store, tenants: Tenant[], input: unknown, actor: string): Offering {
  const req = OfferWorkflow.parse(input);
  const w = store.get<Workflow>("workflow", req.workflow);
  if (!w) throw new DomainError("NOT_FOUND", `Workflow ${req.workflow} not found`, 404);
  const unknown = req.tenants.filter(t => !tenants.some(x => x.id === t));
  if (unknown.length) throw new DomainError("UNKNOWN_TENANT", `Not configured: ${unknown.join(", ")}`, 422);
  releasedOnly(store, w);
  const o: Offering = { id: randomUUID(), revision: 1, workflowId: w.id, workflowDigest: w.digest, tenants: [...new Set(req.tenants)].sort(), state: "active",
    reason: req.reason, createdAt: new Date().toISOString(), createdBy: actor };
  store.insert("offering", o);
  return o;
}

export function revokeOffering(store: Store, id: string, input: unknown, actor: string): Offering {
  const req = RevokeOffering.parse(input);
  const o = store.get<Offering>("offering", id);
  if (!o) throw new DomainError("NOT_FOUND", "Offering not found", 404);
  if (o.state !== "active") throw new DomainError("INVALID_TRANSITION", "Offering is already revoked", 409);
  const next: Offering = { ...o, revision: o.revision + 1, state: "revoked", revokedAt: new Date().toISOString(), revokedBy: actor, revokeReason: req.reason };
  store.put("offering", next, o.revision);
  return next;
}

/** The workflow a tenant may run: actively offered to it, at the offered digest, with released artifacts only. */
export function offeredWorkflow(store: Store, tenant: Tenant, workflowId: string): Workflow {
  const w = store.get<Workflow>("workflow", workflowId);
  const offered = store.list<Offering>("offering").some(o => o.state === "active" && o.workflowId === workflowId && o.tenants.includes(tenant.id) && o.workflowDigest === w?.digest);
  if (!w || !offered) throw new DomainError("NOT_FOUND", `Workflow ${workflowId} is not offered to this tenant`, 404);
  releasedOnly(store, w);
  return w;
}

export function catalog(store: Store, tenant: Tenant) {
  const ids = [...new Set(store.list<Offering>("offering").filter(o => o.state === "active" && o.tenants.includes(tenant.id)).map(o => o.workflowId))];
  return { tenant: tenant.id, quotas: { maxConcurrentRuns: tenant.maxConcurrentRuns, maxRunsPerDay: tenant.maxRunsPerDay },
    workflows: ids.flatMap(id => { try { const w = offeredWorkflow(store, tenant, id);
      return [{ id: w.id, title: w.definition.title, inputs: w.definition.inputs, outputs: Object.keys(w.definition.outputs ?? {}),
        artifacts: w.definition.nodes.filter(n => n.type === "artifact").map(n => (n as { artifact: string }).artifact) }]; } catch { return []; } }) };
}

const ACTIVE: WorkflowRun["state"][] = ["running", "waiting-approval"];
/** Checked before a run starts; a rejected request leaves no record. */
export function checkQuota(store: Store, tenant: Tenant, now = Date.now()) {
  const mine = store.list<WorkflowRun>("workflow-run").filter(r => r.tenant === tenant.id);
  const active = mine.filter(r => ACTIVE.includes(r.state)).length;
  if (active >= tenant.maxConcurrentRuns) throw new DomainError("QUOTA_CONCURRENT", `${active} runs are still active (limit ${tenant.maxConcurrentRuns})`, 429);
  const day = mine.filter(r => now - Date.parse(r.createdAt) < 86_400_000).length;
  if (day >= tenant.maxRunsPerDay) throw new DomainError("QUOTA_DAILY", `${day} runs in the last 24 h (limit ${tenant.maxRunsPerDay})`, 429);
}

export function tenantRun(store: Store, tenant: Tenant, id: string): WorkflowRun {
  const r = store.get<WorkflowRun>("workflow-run", id);
  if (!r || r.tenant !== tenant.id) throw new DomainError("NOT_FOUND", "Run not found", 404);
  return r;
}

/** Summed pai-usage-1 of the tenant's runs. Unknown amounts stay unknown (null), and nothing is priced. */
export function tenantUsage(store: Store, tenant: Tenant, sinceIso?: string) {
  const runs = store.list<WorkflowRun>("workflow-run").filter(r => r.tenant === tenant.id && (!sinceIso || r.createdAt >= sinceIso));
  const usages = runs.flatMap(r => Object.values(r.nodes).map(n => n.usage).filter((u): u is Usage => Boolean(u)));
  const sum = (f: (u: Usage) => number | null) => usages.some(u => f(u) === null) ? null : Math.round(usages.reduce((s, u) => s + (f(u) ?? 0), 0) * 1000) / 1000;
  return { schema: "pai-tenant-usage-1", tenant: tenant.id, since: sinceIso ?? null, runs: runs.length, nodes: usages.length,
    states: Object.fromEntries([...new Set(runs.map(r => r.state))].map(s => [s, runs.filter(r => r.state === s).length])),
    native: { wallSeconds: sum(u => u.native.wallSeconds), cpuSeconds: sum(u => u.native.cpuSeconds), storageBytes: sum(u => u.native.storageBytes) },
    model: { inputTokens: sum(u => u.model.status === "none" ? 0 : u.model.inputTokens), outputTokens: sum(u => u.model.status === "none" ? 0 : u.model.outputTokens) },
    priceVersion: null, billed: false };
}

export const tenantOfClient = (config: Config, clientId: string) => clientId ? config.tenants?.find(t => t.clientId === clientId) : undefined;
