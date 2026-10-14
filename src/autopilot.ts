/**
 * Autopilot: a bounded "propose → native check → revise" loop for one design goal.
 *
 * Each round asks the model, through the bounded executor and its shared attempt ledger (no automatic retries), for
 * ONE typed plan on a granted tool. The step runs under the maintainer's autonomy grant; the round waits for the
 * native verdict; the next round sees the measured failures. The loop stops when the native verdict is accepted, when
 * the round budget or the grant is used up, when the model returns no runnable plan, or when an AI run needs a human
 * reconciliation. It never changes requirements, approves, releases or moves feedback.
 */
import type { RecordKind } from "./ontology/kinds.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PROFILES } from "./controller.js";
import type { Config } from "./config.js";
import { Id, type Project } from "./contracts.js";
import { canonical, DomainError, sha256 } from "./domain.js";
import type { Store } from "./store.js";
import type { LiveBus } from "./live.js";
import type { Lifecycle } from "./lifecycle.js";
import { createAiPlan } from "./ai.js";
import { grantActive, runUnderGrant, type AutonomyGrant } from "./autonomy.js";
import { join } from "node:path";
import type { CadFamily, CadRequirements } from "./cad.js";
import { screenVariants, type Screening } from "./surrogate-screen.js";

/** Most model-written variants screened per round (each costs a sandbox build and a surrogate prediction, seconds). */
export const MAX_VARIANTS = 4;

export const AutopilotRequest = z.object({
  requestId: Id, grantId: Id, goal: z.string().trim().min(10).max(1500), maxRounds: z.number().int().min(1).max(6).default(3),
  /** Engines for the planner, in the executor's order (same contract as /api/assistant/ai); deployment default when absent. */
  profiles: z.array(z.enum(PROFILES)).min(1).max(5).optional(),
}).strict();
export interface AutopilotRound { screening?: Screening; round: number; planId?: string; tool?: string; recordKind?: RecordKind; recordId?: string; verdict?: string; failing?: { id: string; observed: unknown; required: unknown }[]; note?: string }
export interface Autopilot {
  id: string; projectId: string; requestId: string; grantId: string; goal: string; maxRounds: number; rounds: AutopilotRound[];
  state: "running" | "completed" | "failed" | "interrupted"; outcome?: "goal-met" | "rounds-exhausted" | "grant-exhausted" | "no-runnable-plan" | "needs-human";
  error?: string; createdAt: string; finishedAt?: string;
}

type Check = { id: string; passed: boolean; observed?: unknown; required?: unknown };
type Native = { state: string; verdict?: string; candidate?: { checks: Check[] }; baseline?: { checks: Check[] }; result?: { lightestFeasible: number | null } };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function prompt(goal: string, tools: string[], rounds: AutopilotRound[]) {
  const last = rounds.at(-1);
  return [
    `Autopilot design goal: ${goal}`,
    tools.includes("cad-code")
      ? `Propose ONE plan using one of these tools: ${tools.join(", ")}; or, with cad-code, up to ${MAX_VARIANTS} alternative cad-code plans with genuinely different designs (same family and requirements): they are screened by the released structural surrogate and the B-Rep checks, and only the best-ranked one is reviewed natively. Do not relax any frozen requirement; requirement changes are not allowed.`
      : `Propose exactly ONE plan, using one of these tools: ${tools.join(", ")}. Do not relax any frozen requirement; requirement changes are not allowed.`,
    last?.recordId ? `Previous round ${last.round}: ${last.tool} gave verdict ${last.verdict}; failing checks: ${JSON.stringify(last.failing ?? [])}. Cite that record and change the design to fix them, from first principles.`
      : last?.note ? `Previous round ${last.round} could not run: ${last.note}` : "This is the first round: start from the current workspace evidence.",
  ].join("\n");
}

export async function runAutopilot(deps: { store: Store; config: Config; live?: LiveBus; project: (id: string) => Project; lifecycle: (p: Project) => Lifecycle },
  project: Project, input: unknown, by: string): Promise<Autopilot> {
  const { store } = deps;
  const req = AutopilotRequest.parse(input);
  const grant = store.get<AutonomyGrant>("autonomy-grant", req.grantId);
  if (!grant || grant.projectId !== project.id) throw new DomainError("NOT_FOUND", "Grant not found for this project", 404);
  if (!grantActive(grant)) throw new DomainError("GRANT_INACTIVE", "Grant is revoked, expired or used up", 403);
  const record: Autopilot = { id: randomUUID(), projectId: project.id, requestId: req.requestId, grantId: grant.id, goal: req.goal, maxRounds: req.maxRounds,
    rounds: [], state: "running", createdAt: new Date().toISOString() };
  const claimed = store.claim(req.requestId, sha256(canonical({ kind: "autopilot", projectId: project.id, req })), record, "autopilot");
  if (claimed !== record.id) return store.get<Autopilot>("autopilot", claimed)!;
  const save = () => store.put("autopilot", record);
  try {
    for (let round = 1; round <= req.maxRounds; round++) {
      const g = store.get<AutonomyGrant>("autonomy-grant", grant.id)!;
      if (!grantActive(g)) { record.outcome = "grant-exhausted"; break; }
      const plan = await createAiPlan(store, deps.config, { requestId: randomUUID(), projectId: project.id, message: prompt(req.goal, g.tools, record.rounds),
        tools: g.tools.map(t => t as never), ...(req.profiles ? { profiles: req.profiles } : {}) }, deps.lifecycle);
      if (plan.state && plan.state !== "done") { record.rounds.push({ round, planId: plan.id, note: `AI run ${plan.state}` }); record.outcome = "needs-human"; save(); break; }
      let step = plan.plans.find(p => (g.tools as string[]).includes(p.tool));
      // Several model-written variants: screen them (sandbox build + B-Rep checks + surrogate) and review only the best.
      const variants = plan.plans.filter(p => p.tool === "cad-code" && (g.tools as string[]).includes("cad-code") && !p.changes.some(c => c.direction === "relaxed"));
      let screening: Screening | undefined;
      if (variants.length >= 2) {
        const first = variants[0].payload as { family?: CadFamily; requirements: CadRequirements };
        const same = variants.filter(v => ((v.payload as { family?: string }).family ?? "nema17-bracket") === (first.family ?? "nema17-bracket")
          && canonical((v.payload as { requirements: unknown }).requirements) === canonical(first.requirements)).slice(0, MAX_VARIANTS);
        screening = await screenVariants(store, deps.config, first.family ?? "nema17-bracket", first.requirements,
          same.map(v => ({ stepId: v.id, code: (v.payload as { source: { code: string } }).source.code })), join(deps.config.state, "autopilot", record.id, `round-${round}`))
          .catch(() => undefined);
        const chosen = screening?.variants.find(v => v.chosen);
        if (screening && !chosen) { record.rounds.push({ round, planId: plan.id, screening, note: "every screened variant failed its B-Rep checks" }); save(); continue; }
        if (chosen) step = same.find(v => v.id === chosen.stepId);
      }
      if (!step) { record.rounds.push({ round, planId: plan.id, note: "no plan on a granted tool" }); record.outcome = "no-runnable-plan"; save(); break; }
      let started;
      try { started = await runUnderGrant(deps, plan.id, { grantId: g.id, step: step.id }, `autopilot:${record.id}`); }
      catch (e) { record.rounds.push({ round, planId: plan.id, tool: step.tool, note: e instanceof DomainError ? `${e.code}: ${e.message}` : String(e) }); save(); continue; }
      const r: AutopilotRound = { round, planId: plan.id, tool: step.tool, recordKind: started.recordKind, recordId: started.recordId, ...(screening ? { screening } : {}) };
      record.rounds.push(r); save();
      let native: Native | undefined;
      for (let i = 0; i < 2700; i++) {  // up to 90 min per native run
        native = store.get<Native>(started.recordKind, started.recordId);
        if (native && native.state !== "running") break;
        await sleep(2000);
      }
      r.verdict = native?.state === "completed" ? native.verdict ?? (native.result ? (native.result.lightestFeasible !== null ? "feasible-point-found" : "no-feasible-point") : undefined) : native?.state;
      r.failing = [...(native?.candidate?.checks ?? []).filter(c => !c.passed).map(c => ({ id: c.id, observed: c.observed, required: c.required })),
        // A lane whose verdict also needs the reference baseline to pass (CAD) reports those failures explicitly.
        ...(native?.baseline?.checks ?? []).filter(c => !c.passed).map(c => ({ id: `baseline:${c.id}`, observed: c.observed, required: c.required }))];
      save();
      if (r.verdict?.startsWith("accepted") || r.verdict === "feasible-point-found") { record.outcome = "goal-met"; break; }
    }
    record.outcome ??= "rounds-exhausted";
    record.state = "completed";
  } catch (e) { record.state = "failed"; record.error = e instanceof DomainError ? `${e.code}: ${e.message}` : String(e); }
  record.finishedAt = new Date().toISOString(); save();
  void by;
  return record;
}
