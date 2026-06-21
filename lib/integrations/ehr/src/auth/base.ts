import type { AccessToken, TokenProvider } from "./types";

// Refresh slightly before the token actually expires to avoid races
// against in-flight requests using a token that's about to die.
export const REFRESH_SKEW_MS = 30_000;

// Fallback when the IdP omits or returns an invalid `expires_in`. Some
// servers do that for opaque tokens; without this guard we'd compute
// `Date.now() + NaN` and treat every token as already-expired, causing
// a re-fetch on every call (self-DoS + IdP rate-limit risk).
const DEFAULT_EXPIRES_IN_SECONDS = 300;
const MAX_EXPIRES_IN_SECONDS = 86_400;

export function validateExpiresIn(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_EXPIRES_IN_SECONDS;
  return Math.min(Math.floor(n), MAX_EXPIRES_IN_SECONDS);
}

// IdP error bodies frequently echo back the credentials or assertion
// that was rejected (client_secret on a 401, the full JWT on a bad
// assertion). We deliberately surface only the standard OAuth2
// `error` / `error_description` fields and discard everything else,
// so no sensitive material leaks into logs.
export async function readSanitizedTokenError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const json: unknown = JSON.parse(text);
      if (json && typeof json === "object") {
        const obj = json as Record<string, unknown>;
        const err = typeof obj["error"] === "string" ? obj["error"] : null;
        const desc =
          typeof obj["error_description"] === "string"
            ? obj["error_description"]
            : null;
        if (err && desc) return `${err}: ${desc}`;
        if (err) return err;
        if (desc) return desc;
      }
    } catch {
      // Non-JSON body — discard.
    }
  } catch {
    // Failed to read body.
  }
  return "";
}

// Shape of a vanilla OAuth2 token-endpoint response. Both client-credentials
// and SMART backend-services (jwt-bearer) endpoints return this.
export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

// Convert a parsed token-endpoint response into our internal AccessToken
// shape. Lives next to validateExpiresIn so the expiry-clamping policy
// has exactly one home.
export function buildAccessToken(json: TokenResponse): AccessToken {
  return {
    token: json.access_token,
    expiresAt: Date.now() + validateExpiresIn(json.expires_in) * 1000,
    tokenType: json.token_type,
    ...(json.scope !== undefined ? { scope: json.scope } : {}),
  };
}

/**
 * Shared lifecycle for token providers: in-memory cache with refresh-skew
 * gating, in-flight coalescing so concurrent `getToken()` calls share one
 * network round-trip, and an `invalidate()` escape hatch for callers that
 * detect server-side revocation.
 *
 * Subclasses implement {@link fetchToken} — everything else is here.
 */
export abstract class CachedTokenProvider implements TokenProvider {
  private cached: AccessToken | null = null;
  private inflight: Promise<AccessToken> | null = null;

  async getToken(): Promise<string> {
    const token = await this.getAccessToken();
    return token.token;
  }

  async getAccessToken(): Promise<AccessToken> {
    if (this.cached && this.cached.expiresAt - REFRESH_SKEW_MS > Date.now()) {
      return this.cached;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchToken()
      .then((token) => {
        this.cached = token;
        return token;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  invalidate(): void {
    this.cached = null;
  }

  /**
   * Make the network call to mint a fresh token. Implementations should
   * use {@link readSanitizedTokenError} for error formatting and
   * {@link buildAccessToken} to convert the parsed response — that keeps
   * expiry-clamping and PHI-sanitisation policy centralised.
   */
  protected abstract fetchToken(): Promise<AccessToken>;
}
