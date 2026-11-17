/**
 * Shared HTTP plumbing for server routes (server split S1).
 */

import { MASTER_TENANT, normalizeTenant } from '../tenants.js';

export type Handler = (data: Record<string, any>) => Promise<Response>;

/** Tenant resolved by the dispatcher from the bearer key (master default). */
export function tenantOf(data: Record<string, any>): string {
  return normalizeTenant(data?.tenant) || MASTER_TENANT;
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

export function json(body: unknown, status = 200): Response {
  const response = Response.json(body, { status });
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  return response;
}
