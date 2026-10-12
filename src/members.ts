/**
 * Tenant members: people a maintainer invites by e-mail to use the platform as a tenant (ADR 0002 §5).
 *
 * - Roles are default-deny. A browser session is a maintainer only if its verified subject is listed in
 *   PAI_MAINTAINER_SUBS; it is a tenant member only if an *active* member record carries that subject; anything else
 *   gets no access. Hosted sessions are always verified first (ALB-signed claims, src/auth.ts).
 * - Inviting creates the Cognito user (username = e-mail) and Cognito e-mails the login address, the username and a
 *   temporary password; the first sign-in sets a new password. The record is written before the call, so a failed or
 *   repeated invitation is visible and never grants access by itself.
 * - Revoking takes effect on the next request (the record is checked on every request, not only at sign-in), then
 *   disables the Cognito user and signs it out globally. Runs and usage of the tenant are kept.
 * - A new tenant can be created with the first invitation (quotas included); tenants with an OAuth client still come
 *   from the deployment (PAI_TENANTS). E-mail addresses are personal data: never in the workspace projection.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.js";
import { DomainError } from "./domain.js";
import type { Store } from "./store.js";
import { TENANT_ID, type Tenant } from "./tenant-config.js";

/** Identity provider operations the workbench may perform (Cognito in production; a fake in tests). */
export interface Directory {
  /** Create the user and send the invitation e-mail; returns the immutable subject. */
  invite(email: string): Promise<{ username: string; sub: string }>;
  /** Send the invitation again (new temporary password); only while the user has not signed in. */
  resend(username: string): Promise<void>;
  /** Disable the user and revoke its refresh tokens. */
  disable(username: string): Promise<void>;
}

export interface StoredTenant { id: string; maxConcurrentRuns: number; maxRunsPerDay: number; createdAt: string; createdBy: string; reason: string }
export interface TenantMember {
  id: string; tenantId: string; email: string; username?: string; sub?: string;
  state: "inviting" | "invited" | "active" | "revoked" | "failed";
  invitedAt: string; invitedBy: string; reason: string; activatedAt?: string; lastSeenAt?: string;
  invitations: number; revokedAt?: string; revokedBy?: string; revokeReason?: string; error?: string;
}

const Email = z.string().trim().toLowerCase().max(254).regex(/^[^\s@]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/, "a valid e-mail address");
const Reason = z.string().trim().min(5).max(500);
export const InviteMember = z.object({
  email: Email, tenant: z.string().regex(TENANT_ID).refine(t => t !== "workspace", "reserved tenant id"),
  /** Required when the tenant does not exist yet: it is created with these quotas. */
  newTenant: z.object({ maxConcurrentRuns: z.number().int().min(1).max(20).default(2), maxRunsPerDay: z.number().int().min(1).max(1000).default(50) }).strict().optional(),
  reason: Reason,
}).strict();
export const RevokeMember = z.object({ reason: Reason }).strict();
/** A tenant asks for a labelled synthetic input of an offered workflow (to try it; never customer data). */
export const TenantSample = z.object({ workflow: z.string().min(1).max(120), params: z.record(z.string(), z.unknown()).default({}) }).strict();

/** Every tenant: the deployment's (OAuth clients) and those created by invitation. Ids are unique across both. */
export function allTenants(store: Store, config: Config): Tenant[] {
  const fixed = config.tenants ?? [];
  const created = store.list<StoredTenant>("tenant").filter(t => !fixed.some(f => f.id === t.id))
    .map(t => ({ id: t.id, maxConcurrentRuns: t.maxConcurrentRuns, maxRunsPerDay: t.maxRunsPerDay }) as Tenant);
  return [...fixed, ...created];
}

/** What the member list shows a maintainer (no subject or Cognito username). */
export const memberView = (m: TenantMember) => ({ id: m.id, tenant: m.tenantId, email: m.email, state: m.state, invitedAt: m.invitedAt, invitedBy: m.invitedBy,
  activatedAt: m.activatedAt ?? null, lastSeenAt: m.lastSeenAt ?? null, invitations: m.invitations, revokedAt: m.revokedAt ?? null, error: m.error ?? null });

export async function inviteMember(store: Store, config: Config, directory: Directory | undefined, input: unknown, actor: string) {
  if (!directory) throw new DomainError("INVITES_UNAVAILABLE", "Invitations need the hosted identity provider", 503);
  const req = InviteMember.parse(input);
  const tenants = allTenants(store, config);
  if (!tenants.some(t => t.id === req.tenant)) {
    if (!req.newTenant) throw new DomainError("UNKNOWN_TENANT", `Tenant ${req.tenant} does not exist; give its quotas to create it`, 422);
    const created: StoredTenant = { id: req.tenant, ...req.newTenant, createdAt: new Date().toISOString(), createdBy: actor, reason: req.reason };
    store.insert("tenant", created);
  } else if (req.newTenant) throw new DomainError("TENANT_EXISTS", `Tenant ${req.tenant} already exists`, 409);
  if (store.list<TenantMember>("tenant-member").some(m => m.email === req.email && m.state !== "revoked" && m.state !== "failed"))
    throw new DomainError("MEMBER_EXISTS", "This address already has an invitation or access", 409);
  const member: TenantMember = { id: randomUUID(), tenantId: req.tenant, email: req.email, state: "inviting", invitedAt: new Date().toISOString(),
    invitedBy: actor, reason: req.reason, invitations: 1 };
  store.insert("tenant-member", member);
  try {
    const { username, sub } = await directory.invite(req.email);
    Object.assign(member, { username, sub, state: "invited" });
  } catch (e) {
    Object.assign(member, { state: "failed", error: e instanceof DomainError ? e.code : "INVITE_FAILED" });
    store.put("tenant-member", member);
    throw e instanceof DomainError ? e : new DomainError("INVITE_FAILED", "The identity provider did not accept the invitation", 502);
  }
  store.put("tenant-member", member);
  return memberView(member);
}

const memberOf = (store: Store, id: string) => {
  const m = store.get<TenantMember>("tenant-member", id);
  if (!m) throw new DomainError("NOT_FOUND", "No such member", 404);
  return m;
};

export async function resendInvitation(store: Store, directory: Directory | undefined, id: string) {
  if (!directory) throw new DomainError("INVITES_UNAVAILABLE", "Invitations need the hosted identity provider", 503);
  const m = memberOf(store, id);
  if (m.state !== "invited" || !m.username) throw new DomainError("INVALID_TRANSITION", `Member is ${m.state}; only a pending invitation is sent again`, 409);
  await directory.resend(m.username);
  m.invitations += 1; store.put("tenant-member", m);
  return memberView(m);
}

export async function revokeMember(store: Store, directory: Directory | undefined, id: string, input: unknown, actor: string) {
  const { reason } = RevokeMember.parse(input), m = memberOf(store, id);
  if (m.state === "revoked") throw new DomainError("INVALID_TRANSITION", "Member is already revoked", 409);
  // Access ends here, before the identity provider is called: the record is checked on every request.
  Object.assign(m, { state: "revoked", revokedAt: new Date().toISOString(), revokedBy: actor, revokeReason: reason });
  store.put("tenant-member", m);
  if (m.username && directory) await directory.disable(m.username).catch(() => { m.error = "DISABLE_PENDING"; store.put("tenant-member", m); });
  return memberView(m);
}

export type SessionRole = { kind: "maintainer" } | { kind: "tenant"; tenant: Tenant; member: TenantMember } | { kind: "none" };

/** The role of a verified browser session (default deny). Local development without ALB authentication is a maintainer. */
export function sessionRole(store: Store, config: Config, sub: string | undefined): SessionRole {
  if (!config.albAuth) return { kind: "maintainer" };
  if (!sub) return { kind: "none" };
  if (config.maintainerSubs?.includes(sub)) return { kind: "maintainer" };
  const m = store.list<TenantMember>("tenant-member").find(x => x.sub === sub && (x.state === "invited" || x.state === "active"));
  const tenant = m && allTenants(store, config).find(t => t.id === m.tenantId);
  if (!m || !tenant) return { kind: "none" };
  const now = new Date().toISOString();
  // First authenticated request: the invitation was accepted (the password was changed at the hosted sign-in).
  if (m.state === "invited") Object.assign(m, { state: "active", activatedAt: now });
  if (!m.lastSeenAt || Date.parse(now) - Date.parse(m.lastSeenAt) > 60_000) { m.lastSeenAt = now; store.put("tenant-member", m); }
  return { kind: "tenant", tenant, member: m };
}

/** Routes a tenant member's browser session may reach; everything else under /api is refused. */
export const tenantSessionAllows = (method: string, url: string) => {
  const path = url.split("?")[0];
  if (!path.startsWith("/api/")) return method === "GET" || method === "HEAD";
  return path === "/api/session" || path === "/api/version" || path.startsWith("/api/v1/tenant/");
};

/** Cognito (hosted): only the four administrative calls the instance role allows, on this pool only. */
export async function cognitoDirectory(userPoolId: string, region: string): Promise<Directory> {
  const sdk = await import("@aws-sdk/client-cognito-identity-provider");
  const client = new sdk.CognitoIdentityProviderClient({ region });
  return {
    async invite(email) {
      try {
        const r = await client.send(new sdk.AdminCreateUserCommand({ UserPoolId: userPoolId, Username: email, DesiredDeliveryMediums: ["EMAIL"],
          UserAttributes: [{ Name: "email", Value: email }, { Name: "email_verified", Value: "true" }] }));
        const sub = r.User?.Attributes?.find(a => a.Name === "sub")?.Value;
        if (!sub || !r.User?.Username) throw new DomainError("INVITE_FAILED", "The identity provider returned no subject", 502);
        return { username: r.User.Username, sub };
      } catch (e) {
        if (e instanceof sdk.UsernameExistsException) throw new DomainError("USER_EXISTS", "A user with this address already exists in the identity provider", 409);
        if (e instanceof sdk.LimitExceededException || e instanceof sdk.TooManyRequestsException) throw new DomainError("INVITE_LIMIT", "E-mail sending limit reached; try later", 429);
        throw e;
      }
    },
    async resend(username) { await client.send(new sdk.AdminCreateUserCommand({ UserPoolId: userPoolId, Username: username, MessageAction: "RESEND", DesiredDeliveryMediums: ["EMAIL"] })); },
    async disable(username) {
      await client.send(new sdk.AdminDisableUserCommand({ UserPoolId: userPoolId, Username: username }));
      await client.send(new sdk.AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username: username }));
    },
  };
}
