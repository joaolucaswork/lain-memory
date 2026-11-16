/**
 * Shared HTTP plumbing for server routes (server split S1).
 */

export type Handler = (data: Record<string, any>) => Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}
