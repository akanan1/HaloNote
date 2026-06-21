// Cross-cutting error helpers used by route handlers. These live here
// (not in lib/) because none of them are pure data — they wrap Express
// response shapes and Drizzle-specific error quirks.

// 23505 = Postgres unique_violation. Drizzle sometimes nests the pg
// error under `cause` (depending on the call path / driver mode), so a
// naive `err.code === "23505"` check misses half the cases. Use this
// helper at the catch site of any insert/update that has a UNIQUE
// constraint you want to surface as a 409.
export function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  if (e.code === "23505") return true;
  if (e.cause && typeof e.cause === "object" && e.cause.code === "23505") {
    return true;
  }
  return false;
}
