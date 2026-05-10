import type { AccessToken, OAuth2Config } from "./types";

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

// Refresh slightly before the token actually expires to avoid races against
// in-flight requests using a token that's about to die.
const REFRESH_SKEW_MS = 30_000;

export class OAuth2TokenProvider {
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
      `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`,
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
      const detail = await res.text().catch(() => "");
      throw new Error(
        `OAuth2 token request failed: ${res.status} ${res.statusText}` +
          (detail ? ` — ${detail}` : ""),
      );
    }

    const json = (await res.json()) as TokenResponse;
    const token: AccessToken = {
      token: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
      tokenType: json.token_type,
      scope: json.scope,
    };
    this.cached = token;
    return token;
  }
}
