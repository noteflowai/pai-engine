/** Tenant configuration (`PAI_TENANTS`): a leaf module so config.ts depends on nothing but zod. */
import { z } from "zod";

export const TENANT_ID = /^[a-z][a-z0-9-]{1,39}$/;
export const TenantConfig = z.object({
  id: z.string().regex(TENANT_ID), clientId: z.string().regex(/^[a-z0-9]{1,128}$/),
  maxConcurrentRuns: z.number().int().min(1).max(20).default(2), maxRunsPerDay: z.number().int().min(1).max(1000).default(50),
}).strict();
export type Tenant = z.infer<typeof TenantConfig>;

/** `PAI_TENANTS`: JSON array of tenants; ids and client ids must be unique; never the reserved workspace id. */
export function parseTenants(value?: string): Tenant[] {
  if (!value) return [];
  const list = z.array(TenantConfig).max(9).parse(JSON.parse(value)); // ALB claim limit: 1 agent client + 9 tenants
  if (new Set(list.map(t => t.id)).size !== list.length || new Set(list.map(t => t.clientId)).size !== list.length) throw new Error("PAI_TENANTS ids and client ids must be unique");
  if (list.some(t => t.id === "workspace")) throw new Error("PAI_TENANTS must not use the reserved id workspace");
  return list;
}
