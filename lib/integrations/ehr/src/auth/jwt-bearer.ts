import { randomUUID } from "node:crypto";
import { signJwt } from "./jwt";
import type {
  AccessToken,
  JwtBearerAuthConfig,
  TokenProvider,
} from "./types";

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

const REFRESH_SKEW_MS = 30_000;
const DEFAULT_ASSERTION_LIFETIME_SECONDS = 300;
// Backdate `iat` to absorb minor clock drift between us and the IdP — Epic
// has historically rejected assertions where `iat` is even ~1s in the future.
const IAT_BACKDATE_SECONDS = 30;
const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

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
      // Non-JSON body — discard. IdP error bodies can echo the
      // client_assertion JWT (with its kid and jti), so we never log raw.
    }
  } catch {
    // Failed to read body.
  }
  return "";
}

export class JwtBearerAuthProvider implements TokenProvider {
  private readonly config: JwtBearerAuthConfig;
  private readonly fetchImpl: typeof fetch;
  private cached: AccessToken | null = null;
  private inflight: Promise<AccessToken> | null = null;

  constructor(config: JwtBearerAuthConfig) {
    if (!config.privateKey && !config.signer) {
      throw new Error(
        "JwtBearerAuthProvider requires either `privateKey` or `signer`.",
      );
    }
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

  private async buildAssertion(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const iat = now - IAT_BACKDATE_SECONDS;
    const lifetime =
      this.config.assertionLifetimeSeconds ??
      DEFAULT_ASSERTION_LIFETIME_SECONDS;

    const header: Record<string, unknown> = {};
    if (this.config.keyId) header.kid = this.config.keyId;

    const claims: Record<string, unknown> = {
      iss: this.config.clientId,
      sub: this.config.clientId,
      aud: this.config.audience ?? this.config.tokenUrl,
      jti: randomUUID(),
      iat,
      exp: now + lifetime,
    };

    return signJwt({
      header,
      claims,
      algorithm: this.config.algorithm,
      ...(this.config.privateKey !== undefined
        ? { privateKey: this.config.privateKey }
        : {}),
      ...(this.config.signer !== undefined
        ? { signer: this.config.signer }
        : {}),
    });
  }

  private async fetchToken(): Promise<AccessToken> {
    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    body.set("client_assertion_type", CLIENT_ASSERTION_TYPE);
    body.set("client_assertion", await this.buildAssertion());
    if (this.config.scope) body.set("scope", this.config.scope);

    const res = await this.fetchImpl(this.config.tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    if (!res.ok) {
      const detail = await readSanitizedTokenError(res);
      throw new Error(
        `JWT-bearer token request failed: ${res.status} ${res.statusText}` +
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
