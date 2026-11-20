/**
 * Shared HTTP plumbing for server routes (server split S1).
 */

import { MASTER_TENANT, normalizeTenant } from '../tenants.js';

export type Handler = (data: Record<string, any>) => Promise<Response>;

/** Tenant resolved by the dispatcher from the bearer key (master default). */
export function tenantOf(data: Record<string, any>): string {
  return normalizeTenant(data?.tenant) || MASTER_TENANT;
}

/**
 * Admin-only gate. Returns a 403 Response when the caller is not master,
 * null when allowed. Apply at the top of global maintenance handlers.
 */
export function requireMaster(data: Record<string, any>): Response | null {
  if (data?.isMaster === true) return null;
  return json({ error: 'master only' }, 403);
}

/**
 * Real client IP behind Caddy. Trusts X-Forwarded-For / X-Real-IP ONLY when
 * the direct peer is loopback (127.0.0.1 / ::1) — i.e. traffic came through
 * the local reverse proxy. Direct exposure (non-loopback peer) ignores the
 * headers, preserving spoof protection.
 * Takes the LAST hop of X-Forwarded-For (closest untrusted proxy entry).
 */
export function resolveClientIp(req: Request, direct: string): string {
  const loopback = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1';
  if (!loopback) return direct;
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const hops = xff.split(',').map(s => s.trim()).filter(Boolean);
    if (hops.length > 0) {
      const last = hops[hops.length - 1];
      if (last) return last;
    }
  }
  const xri = req.headers.get('x-real-ip')?.trim();
  if (xri) return xri;
  return direct;
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
