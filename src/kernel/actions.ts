/**
 * Action runtime (ADR 0003 step 3): write routes are registered from the ontology's action types, not by hand.
 *
 * `action(id, handler)` looks up the action type, registers its method and route, and before the handler runs:
 *  - authorizes the caller against the action's declared submitters (maintainer session, agent with a scope, tenant);
 *    the boundary lives on the action, not in ad-hoc checks, and an unlisted caller gets 403 ACTION_FORBIDDEN;
 * Parameters are validated by the domain function that owns them, with exactly the schema the action type exports
 * (tests/ontology.test.ts proves it). Validating here as well would replace their specific errors, such as a workflow's
 * 422 WORKFLOW_SCHEMA with the failing field path, by a generic 400.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { DomainError } from "../domain.js";
import { ACTION_TYPES, type ActionType } from "../ontology/model.js";
import type { Scope } from "../agent-api.js";

export type Caller = { kind: "maintainer" } | { kind: "agent"; scope: Scope } | { kind: "tenant"; tenant: string };
export interface ActionContext { request: FastifyRequest; reply: FastifyReply; input: unknown; caller: Caller; action: ActionType }

export const allowed = (a: ActionType, c: Caller) =>
  c.kind === "maintainer" ? a.submitters.includes("maintainer")
    : c.kind === "tenant" ? a.submitters.includes("tenant")
      : (a.submitters as string[]).includes(`agent:${c.scope}`);

export type Define = (id: string, handler: (ctx: ActionContext) => unknown, options?: Pick<RouteShorthandOptions, "bodyLimit">) => void;

/** One audit record per write attempt (refused, failed or done). No request body: only ids from the path. */
export interface AuditEvent {
  id: string; at: string; action: string; method: string; route: string; params: Record<string, string>;
  caller: Caller; actor: string; status: number; outcome: "done" | "accepted" | "refused" | "invalid" | "failed"; code?: string; durationMs: number;
}
const statusOf = (e: unknown) => e instanceof DomainError ? e.status : e instanceof ZodError || e instanceof SyntaxError ? 400
  : typeof e === "object" && e !== null && "statusCode" in e ? Number((e as { statusCode: unknown }).statusCode) || 500 : 500;
const outcomeOf = (status: number): AuditEvent["outcome"] => status === 202 ? "accepted" : status < 300 ? "done" : status === 401 || status === 403 ? "refused" : status < 500 ? "invalid" : "failed";

export function actionRuntime(app: FastifyInstance, callerOf: (raw: unknown) => Caller,
  audit?: { actor: (request: FastifyRequest) => string; record: (event: AuditEvent) => void }): Define {
  return (id, handler, options = {}) => {
    const action = ACTION_TYPES.find(a => a.id === id);
    if (!action) throw new Error(`No action type ${id} in the ontology`);
    app.route({ method: action.method, url: action.route, ...options, handler: async (request, reply) => {
      const caller = callerOf(request.raw), started = Date.now();
      const write = (status: number, code?: string) => {
        if (!audit) return;
        const params = Object.fromEntries(Object.entries((request.params ?? {}) as Record<string, unknown>).map(([k, v]) => [k, String(v).slice(0, 160)]));
        try {
          audit.record({ id: randomUUID(), at: new Date().toISOString(), action: action.id, method: action.method, route: action.route, params, caller,
            actor: audit.actor(request), status, outcome: outcomeOf(status), ...(code ? { code } : {}), durationMs: Date.now() - started });
        } catch { /* auditing never changes the answer */ }
      };
      if (!allowed(action, caller)) { write(403, "ACTION_FORBIDDEN"); throw new DomainError("ACTION_FORBIDDEN", `${action.id} is not available to this caller`, 403); }
      try {
        const result = await handler({ request, reply, input: request.body, caller, action });
        write(reply.statusCode);
        return result;
      } catch (e) { write(statusOf(e), e instanceof DomainError ? e.code : undefined); throw e; }
    } });
  };
}
