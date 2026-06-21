// Cursor-pagination primitives shared by list endpoints. The historical
// pattern (audit-log, notes) was: GET /thing?before=<ISO>&limit=<N>,
// returning `{ data, nextCursor }` where nextCursor is the oldest row's
// `at` ISO string (or null when no more pages). These helpers parse the
// raw query values and clamp limit to a safe range.

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export function parseIsoDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function clampLimit(
  value: unknown,
  defaultLimit: number = DEFAULT_PAGE_LIMIT,
  maxLimit: number = MAX_PAGE_LIMIT,
): number {
  const raw =
    typeof value === "string"
      ? Number(value)
      : typeof value === "number"
        ? value
        : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return defaultLimit;
  return Math.min(Math.floor(raw), maxLimit);
}

// Trim and reject empty strings — the audit-log route used this for
// optional filter params where "" should mean "not supplied", not
// "match the empty string literal".
export function readStringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}
