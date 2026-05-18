// Safe post-login redirect helpers.
//
// Some flows want to bounce a user through /login and back. The
// canonical example: Cerner SMART EHR-launch — the api-server's
// /api/auth/ehr/cerner/launch endpoint 303s unauthenticated users to
// /login?next=<launch-url> so they can resume after signing in.
//
// `?next=` is caller-controlled query input → open-redirect surface.
// `safeNext` is the validation gate: it returns a normalized
// same-origin path-only string, or null. Callers must NEVER use the
// raw query value.

const MAX_LEN = 2048;

/**
 * Validate a caller-supplied redirect target. Returns a normalized
 * path-only string (pathname + search + hash) when the input
 * represents a same-origin relative path; returns null otherwise.
 *
 * Defense layers:
 *   1. Type + length bound.
 *   2. Must start with a single forward slash.
 *   3. Reject "//" (protocol-relative) and "/\" (some browsers
 *      normalize backslashes to slashes).
 *   4. Parse via `new URL` against the current origin and verify the
 *      resolved origin matches. This catches every host-injection
 *      trick (embedded credentials, encoded chars, etc.) because the
 *      browser's parser is the authority.
 */
export function safeNext(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_LEN) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (typeof window === "undefined") {
    // Defensive: SSR contexts can't validate origin. Treat as unsafe.
    return null;
  }
  try {
    const u = new URL(raw, window.location.origin);
    if (u.origin !== window.location.origin) return null;
    // javascript:, data:, etc. don't survive `new URL` resolution
    // against an http(s) base — their protocol would be carried
    // through and the origin check would fail. Belt-and-suspenders:
    if (u.protocol !== window.location.protocol) return null;
    return `${u.pathname}${u.search}${u.hash}`;
  } catch {
    return null;
  }
}

/**
 * Perform the post-login redirect.
 *
 *   - If `next` is a same-origin API route (`/api/...`), we do a
 *     full-page nav. Wouter's SPA router would 404 inside <Switch>;
 *     plus, hitting the api endpoint with the freshly-set session
 *     cookie is exactly what we want for the Cerner launch resume.
 *   - If `next` is any other same-origin path, also use full-page
 *     nav for simplicity. Optimizing SPA-routed targets to use
 *     wouter is a possible future polish; today the only real `next`
 *     producer is the Cerner launch endpoint, which is always /api.
 *   - If `next` is null/invalid, fall back to the caller's default
 *     navigate (wouter SPA nav to "/").
 *
 * Exposed as a thin wrapper so the Login page stays declarative and
 * the tests can spy on a single seam.
 */
export function redirectAfterLogin(
  next: string | null,
  fallbackNavigate: () => void,
): void {
  if (next) {
    if (typeof window !== "undefined") {
      window.location.assign(next);
      return;
    }
  }
  fallbackNavigate();
}
