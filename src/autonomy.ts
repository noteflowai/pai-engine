/**
 * Bounded autonomy: a maintainer delegates *native runs* (never approval, release or feedback) to an AI loop.
 *
 * A grant is issued by a human for one project: which tools may run, how many runs, until when. Under a grant, a
 * typed plan step can be executed without a per-step click, by the workbench autopilot (model through the bounded
 * executor and its shared ledger) or by an external agent (AgentForge session through the governed MCP gateway).
 * Every rule the human confirmation enforced still holds, plus:
 *   - only the granted tools; no project creation or requirement change; no step that relaxes a requirement;
 *   - the quota is reserved before the run starts (atomic with the claim), and a revoked or expired grant runs nothing;
 *   - each execution is recorded on the plan as a confirmation `by: grant:<id>` and on the grant as a run.
 * Verdicts still come only from the native solvers; releases still need the release gate and a maintainer.
 */
import type { RecordKind } from "./ontology/kinds.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.js";
import { Id, type Project } from "./contracts.js";
import { DomainError } from "./domain.js";
import type { Store } from "./store.js";
import type { LiveBus } from "./live.js";
import { AUTONOMOUS_LANES } from "./lanes.js";
import { confirmPlan, preflightPlan, type AssistantPlan } from "./assistant.js";

/** Native lanes a grant may cover: exactly the autonomous lanes in the registry (src/lanes.ts). */
export const AUTONOMOUS_TOOLS = Object.keys(AUTONOMOUS_LANES) as [keyof typeof AUTONOMOUS_LANES, ...(keyof typeof AUTONOMOUS_LANES)[]];
export type AutonomousTool = (typeof AUTONOMOUS_TOOLS)[number];
const KIND = (tool: AutonomousTool): RecordKind => AUTONOMOUS_LANES[tool].recordKind;
export const CreateGrant = z.object({
  tools: z.array(z.enum(AUTONOMOUS_TOOLS)).min(1).max(AUTONOMOUS_TOOLS.length),
  maxRuns: z.number().int().min(1).max(20), hours: z.number().min(0.25).max(72).default(8),
  note: z.string().trim().max(500).optional(),
}).strict();
export interface GrantRun { planId: string; stepId: string; tool: AutonomousTool; recordKind: RecordKind; recordId: string; at: string; by: string }
export interface AutonomyGrant {
  id: string; projectId: string; revision: number; tools: AutonomousTool[]; maxRuns: number; runs: GrantRun[];
  createdAt: string; expiresAt: string; createdBy: string; note?: string; revokedAt?: string; revokedBy?: string;
}
export const grantActive = (g: AutonomyGrant, now = Date.now()) => !g.revokedAt && Date.parse(g.expiresAt) > now && g.runs.length < g.maxRuns;

export function createGrant(store: Store, project: Project, input: unknown, actor: string): AutonomyGrant {
  const r = CreateGrant.parse(input);
  const now = new Date();
  const grant: AutonomyGrant = { id: randomUUID(), projectId: project.id, revision: 1, tools: [...new Set(r.tools)], maxRuns: r.maxRuns, runs: [],
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + r.hours * 3_600_000).toISOString(), createdBy: actor, ...(r.note ? { note: r.note } : {}) };
  store.insert("autonomy-grant", grant);
  return grant;
}
export function revokeGrant(store: Store, id: string, actor: string): AutonomyGrant {
  const g = store.get<AutonomyGrant>("autonomy-grant", id);
  if (!g) throw new DomainError("NOT_FOUND", "Grant not found", 404);
  if (g.revokedAt) return g;
  const next = { ...g, revision: g.revision + 1, revokedAt: new Date().toISOString(), revokedBy: actor };
  store.put("autonomy-grant", next, g.revision);
  return next;
}

export const RunUnderGrant = z.object({ grantId: Id, step: z.string().regex(/^p[0-9]{1,2}$/) }).strict();
type Deps = { store: Store; config: Config; live?: LiveBus; project: (id: string) => Project };

/**
 * Execute one plan step under a grant. Returns once the native record exists (the run continues in the background,
 * exactly like a hosted 202), so callers poll the record. Throws, with nothing started, on any rule violation.
 */
export async function runUnderGrant(deps: Deps, planId: string, input: unknown, by: string): Promise<{ recordKind: RecordKind; recordId: string; state: string; grant: { id: string; runsLeft: number } }> {
  const { store } = deps;
  const req = RunUnderGrant.parse(input);
  const grant = store.get<AutonomyGrant>("autonomy-grant", req.grantId);
  const plan = store.get<AssistantPlan>("assistant-plan", planId);
  if (!grant || !plan) throw new DomainError("NOT_FOUND", "Grant or plan not found", 404);
  if (!grantActive(grant)) throw new DomainError("GRANT_INACTIVE", grant.revokedAt ? "Grant revoked" : grant.runs.length >= grant.maxRuns ? "Grant quota used up" : "Grant expired", 403);
  const step = plan.plans.find(p => p.id === req.step);
  if (!step) throw new DomainError("NOT_FOUND", "Plan step not found", 404);
  const project = deps.project(grant.projectId);
  if (plan.projectId && plan.projectId !== grant.projectId) throw new DomainError("GRANT_SCOPE", "Plan belongs to another project", 403);
  if (!(grant.tools as string[]).includes(step.tool)) throw new DomainError("GRANT_SCOPE", `Tool ${step.tool} is not covered by this grant`, 403);
  if (step.changes.some(c => c.direction === "relaxed")) throw new DomainError("GRANT_RELAXATION", "A step that relaxes a frozen requirement needs a human confirmation", 403);
  if (step.dependsOn) throw new DomainError("GRANT_SCOPE", "Dependent steps need a human confirmation", 403);
  if (plan.confirmations.some(c => c.planId === step.id)) throw new DomainError("ALREADY_EXECUTED", "This step was already executed", 409);
  preflightPlan(store, planId, step.id);
  const tool = step.tool as AutonomousTool;
  const requestId = (await import("node:crypto")).createHash("sha256").update(`pai-grant-${grant.id}-${planId}-${step.id}`).digest("hex")
    .replace(/^(.{8})(.{4})(.{3})(.{3})(.{12}).*/, "$1-$2-4$3-8$4-$5");
  const body = { ...step.payload, projectRevision: project.revision, requestId };
  // Reserve the quota first: a concurrent second call sees the reservation and stops at the revision check.
  const reserved: AutonomyGrant = { ...grant, revision: grant.revision + 1,
    runs: [...grant.runs, { planId, stepId: step.id, tool, recordKind: KIND(tool), recordId: "pending", at: new Date().toISOString(), by }] };
  store.put("autonomy-grant", reserved, grant.revision);
  const { config, live } = deps;
  const operation = AUTONOMOUS_LANES[tool].start(store, config, project, body, live);
  // Every native service claims its request before its first await; the record exists after one tick.
  const release = () => {  // nothing started: give the reserved run back
    const latest = store.get<AutonomyGrant>("autonomy-grant", grant.id)!;
    const released: AutonomyGrant = { ...latest, revision: latest.revision + 1, runs: latest.runs.filter(r => !(r.planId === planId && r.stepId === step.id)) };
    store.put("autonomy-grant", released, latest.revision);
  };
  let recordId: string | undefined;
  try {
    // Most lanes claim their request before the first await; generated code is policy-checked first. Wait for the
    // claim (or for the operation to settle) rather than assuming one tick.
    let settled: { r?: { id: string }; e?: unknown } | undefined;
    operation.then(r => { settled = { r }; }, e => { settled = { e }; });
    for (let i = 0; i < 600 && !settled && !(recordId = store.requestRun(requestId)); i++) await new Promise(res => setTimeout(res, 100));
    if (settled?.e) throw settled.e;
    recordId ??= settled?.r?.id ?? store.requestRun(requestId);
  } catch (e) {
    // Validation or configuration errors happen before the native claim; anything later is the record's own failure.
    recordId = store.requestRun(requestId);
    if (!recordId) { release(); throw e; }
  }
  if (!recordId) { release(); throw new DomainError("GRANT_RUN_FAILED", "The native run did not start", 422); }
  operation.catch(() => { /* the service records its own failure state */ });
  const latest = store.get<AutonomyGrant>("autonomy-grant", grant.id)!;
  const bound: AutonomyGrant = { ...latest, revision: latest.revision + 1, runs: latest.runs.map(r => r.planId === planId && r.stepId === step.id ? { ...r, recordId } : r) };
  store.put("autonomy-grant", bound, latest.revision);
  const confirmed = confirmPlan(store, planId, { planId: step.id, recordKind: KIND(tool), recordId, grantId: grant.id });
  void confirmed;
  const record = store.get<{ state: string }>(KIND(tool), recordId);
  return { recordKind: KIND(tool), recordId, state: record?.state ?? "running", grant: { id: grant.id, runsLeft: reserved.maxRuns - reserved.runs.length } };
}
