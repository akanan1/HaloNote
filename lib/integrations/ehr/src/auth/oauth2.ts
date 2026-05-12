import type { AccessToken, OAuth2Config, TokenProvider } from "./types";

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

// Refresh slightly before the token actually expires to avoid races against
// in-flight requests using a token that's about to die.
const REFRESH_SKEW_MS = 30_000;

// Fallback when the IdP omits or returns an invalid `expires_in`. Some
// servers do that for opaque tokens; without this guard we'd compute
// `Date.now() + NaN` and treat every token as already-expired, causing a
// re-fetch on every call (self-DoS + IdP rate-limit risk).
const DEFAULT_EXPIRES_IN_SECONDS = 300;
const MAX_EXPIRES_IN_SECONDS = 86_400;

function validateExpiresIn(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_EXPIRES_IN_SECONDS;
  return Math.min(Math.floor(n), MAX_EXPIRES_IN_SECONDS);
}

// RFC 6749 §2.3.1 requires the client_id and client_secret to be
// `application/x-www-form-urlencoded`-encoded before being concatenated
// with `:` and base64'd. `encodeURIComponent` is *not* the same encoding —
// it leaves `!*'()` unencoded and emits `%20` for spaces instead of `+`.
// URLSearchParams uses the correct encoding.
function formEncode(value: string): string {
  const params = new URLSearchParams();
  params.set("v", value);
  return params.toString().slice(2);
}

async function readSanitizedTokenError(res: Response): Promise<string> {
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
      // Non-JSON body — fall through and discard. We deliberately do NOT
      // echo the raw body: IdP error responses can contain echoed
      // credentials, JWT assertions, and other sensitive material.
    }
  } catch {
    // Failed to read body.
  }
  return "";
}

export class OAuth2TokenProvider implements TokenProvider {
  private readonly config: OAuth2Config;
  private readonly fetchImpl: typeof fetch;
  private cached: AccessToken | null = null;
  private inflight: Promise<AccessToken> | null = null;

  constructor(config: OAuth2Config) {
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async getToken(): Promise<string> {
    const token = await this.getAccessToken();
    return token.token;
  }

  async getAccessToken(): Promise<AccessToken> {
    if (this.cached && this.cached.expiresAt - REFRESH_SKEW_MS > Date.now()) {
      return this.cached;
    }
    if (this.inflight) return this.inflight;

    this.inflight = this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  invalidate(): void {
    this.cached = null;
  }

  private async fetchToken(): Promise<AccessToken> {
    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    if (this.config.scope) body.set("scope", this.config.scope);

    const basic = Buffer.from(
      `${formEncode(this.config.clientId)}:${formEncode(this.config.clientSecret)}`,
    ).toString("base64");

    const res = await this.fetchImpl(this.config.tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        authorization: `Basic ${basic}`,
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const detail = await readSanitizedTokenError(res);
      throw new Error(
        `OAuth2 token request failed: ${res.status} ${res.statusText}` +
          (detail ? ` — ${detail}` : ""),
      );
    }

    const json = (await res.json()) as TokenResponse;
    const token: AccessToken = {
      token: json.access_token,
      expiresAt: Date.now() + validateExpiresIn(json.expires_in) * 1000,
      tokenType: json.token_type,
      ...(json.scope !== undefined ? { scope: json.scope } : {}),
    };
    this.cached = token;
    return token;
  }
}
