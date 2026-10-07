/** Extract a string message from an unknown caught value. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
