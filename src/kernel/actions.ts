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

export function actionRuntime(app: FastifyInstance, callerOf: (raw: unknown) => Caller): Define {
  return (id, handler, options = {}) => {
    const action = ACTION_TYPES.find(a => a.id === id);
    if (!action) throw new Error(`No action type ${id} in the ontology`);
    app.route({ method: action.method, url: action.route, ...options, handler: async (request, reply) => {
      const caller = callerOf(request.raw);
      if (!allowed(action, caller)) throw new DomainError("ACTION_FORBIDDEN", `${action.id} is not available to this caller`, 403);
      return handler({ request, reply, input: request.body, caller, action });
    } });
  };
}
