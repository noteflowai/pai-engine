/**
 * Machine (agent) access to a narrow, read-and-propose subset of the workbench API under `/api/agent/*`.
 *
 * Hosted: an OAuth 2.0 client-credentials access token from the workbench's Cognito pool (resource server
 * `pai-agent`). The ALB verifies it first (`jwt-validation` listener action) and the workbench verifies it
 * again here with aws-jwt-verify: signature, issuer, `token_use=access`, allowed `client_id` and the scope the
 * route needs. Local loopback: no token, exactly like the browser routes.
 *
 * Nothing here confirms or executes a plan, starts native work, transitions feedback or touches releases.
 */
import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { Config } from "./config.js";

export const AGENT_PREFIX = "/api/agent";
/** `run` executes an already-validated plan step only within a maintainer's autonomy grant (never approve/release). */
export const AGENT_SCOPES = { read: "pai-agent/read", propose: "pai-agent/propose", run: "pai-agent/run", tenant: "pai-agent/tenant" } as const;
export type Scope = keyof typeof AGENT_SCOPES;

/** The complete allowlist. Anything else under /api/agent is 404 before routing. */
export const AGENT_ROUTES: readonly { method: "GET" | "POST"; pattern: RegExp; scope: Scope }[] = [
  { method: "GET", pattern: /^\/state$/, scope: "read" },
  { method: "GET", pattern: /^\/assistant\/context(\?projectId=[0-9a-f-]{36})?$/, scope: "read" },
  { method: "GET", pattern: /^\/assistant\/plans\/[0-9a-f-]{36}$/, scope: "read" },
  { method: "GET", pattern: /^\/projects\/[0-9a-f-]{36}\/records\/[a-z0-9-]{1,24}$/, scope: "read" },
  { method: "GET", pattern: /^\/projects\/[0-9a-f-]{36}\/versions$/, scope: "read" },
  { method: "GET", pattern: /^\/dataset\/solver(\?domain=(structural-fea|aero-rans))?$/, scope: "read" },
  { method: "GET", pattern: /^\/projects\/[0-9a-f-]{36}\/admission\?kind=[a-z-]{1,24}&runId=[0-9a-f-]{36}$/, scope: "read" },
  { method: "POST", pattern: /^\/cad\/code-check$/, scope: "read" },
  { method: "POST", pattern: /^\/assistant\/external-plans$/, scope: "propose" },
  { method: "POST", pattern: /^\/assistant\/plans\/[0-9a-f-]{36}\/autonomous-runs$/, scope: "run" },
  { method: "GET", pattern: /^\/autonomy-grants\?projectId=[0-9a-f-]{36}$/, scope: "read" },
  // Ontology: the semantic model, engine catalogue and object reads (read scope only; writes stay behind actions).
  { method: "GET", pattern: /^\/v1\/ontology(\.ttl)?$/, scope: "read" },
  { method: "GET", pattern: /^\/v1\/engines$/, scope: "read" },
  // Object reads: the server further limits agents to the kinds /state already returns (ontology/model.ts AGENT_STATE_KINDS).
  { method: "GET", pattern: /^\/v1\/objects(\/[A-Z][A-Za-z]{1,40}(\/[A-Za-z0-9@._-]{1,160})?)?(\?(limit=\d{1,3})?(&?after=[A-Za-z0-9@._-]{1,160})?)?$/, scope: "read" },
  // Invite-only tenants (src/tenants.ts): their own catalogue, runs and usage; nothing of the workspace.
  { method: "GET", pattern: /^\/v1\/tenant\/catalog$/, scope: "tenant" },
  { method: "GET", pattern: /^\/v1\/tenant\/usage(\?since=\d{4}-\d\d-\d\d(T[0-9:.]{2,12}Z)?)?$/, scope: "tenant" },
  { method: "GET", pattern: /^\/v1\/tenant\/runs$/, scope: "tenant" },
  { method: "POST", pattern: /^\/v1\/tenant\/runs$/, scope: "tenant" },
  { method: "GET", pattern: /^\/v1\/tenant\/runs\/[0-9a-f-]{36}$/, scope: "tenant" },
  { method: "GET", pattern: /^\/v1\/tenant\/runs\/[0-9a-f-]{36}\/data\?(node=[a-z][a-z0-9-]{0,30}&)?name=[a-z][A-Za-z0-9]{0,30}$/, scope: "tenant" },
  { method: "POST", pattern: /^\/v1\/tenant\/runs\/[0-9a-f-]{36}\/decisions$/, scope: "tenant" },
];

export interface AgentPrincipal { clientId: string; verified: boolean; session?: string; scope?: Scope }
const AGENT = Symbol("pai-agent");
type Tagged = { [AGENT]?: { scope: Scope } };

/** Fastify `rewriteUrl`: map an allowlisted agent path onto its internal route and tag the raw request. */
export function rewriteAgentUrl(raw: { url?: string; method?: string } & Tagged): string {
  const url = raw.url ?? "/";
  if (!url.startsWith(`${AGENT_PREFIX}/`)) return url;
  const rest = url.slice(AGENT_PREFIX.length);
  const route = AGENT_ROUTES.find(r => r.method === raw.method && r.pattern.test(rest));
  if (!route) return "/api/agent-not-found";
  raw[AGENT] = { scope: route.scope };
  return `/api${rest}`;
}
export const agentRoute = (raw: unknown) => (raw as Tagged)[AGENT];

const SESSION = /^[A-Za-z0-9._:-]{1,80}$/;
/** Verifier for agent requests; returns the principal or undefined (reject). */
export function agentAuthentication(config: Config) {
  const verifier = config.agentAuth ? CognitoJwtVerifier.create({
    userPoolId: config.agentAuth.userPoolId, clientId: config.agentAuth.clientIds, tokenUse: "access",
  }) : undefined;
  if (verifier && config.agentAuth?.jwks) verifier.cacheJwks(config.agentAuth.jwks as Parameters<typeof verifier.cacheJwks>[0]);
  return async (headers: Record<string, string | string[] | undefined>, scope: Scope): Promise<AgentPrincipal | undefined> => {
    const sessionHeader = headers["x-pai-agent-session"];
    const session = typeof sessionHeader === "string" && SESSION.test(sessionHeader) ? sessionHeader : undefined;
    // Without a configured pool only a loopback workbench serves agent routes (enforced by config validation).
    if (!verifier) return config.publicOrigin ? undefined : { clientId: "local", verified: false, session };
    const auth = headers.authorization;
    if (typeof auth !== "string" || !auth.startsWith("Bearer ") || auth.length > 8_000) return undefined;
    try {
      const claims = await verifier.verify(auth.slice(7), { scope: AGENT_SCOPES[scope] });
      return { clientId: String(claims.client_id), verified: true, session };
    } catch { return undefined; }
  };
}
