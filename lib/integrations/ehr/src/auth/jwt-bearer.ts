import { randomUUID } from "node:crypto";
import { signJwt } from "./jwt";
import {
  buildAccessToken,
  CachedTokenProvider,
  readSanitizedTokenError,
  type TokenResponse,
} from "./base";
import type { AccessToken, JwtBearerAuthConfig } from "./types";

const DEFAULT_ASSERTION_LIFETIME_SECONDS = 300;
// Backdate `iat` to absorb minor clock drift between us and the IdP — Epic
// has historically rejected assertions where `iat` is even ~1s in the future.
const IAT_BACKDATE_SECONDS = 30;
const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";

export class JwtBearerAuthProvider extends CachedTokenProvider {
  private readonly config: JwtBearerAuthConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: JwtBearerAuthConfig) {
    super();
    if (!config.privateKey && !config.signer) {
      throw new Error(
        "JwtBearerAuthProvider requires either `privateKey` or `signer`.",
      );
    }
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
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

  protected override async fetchToken(): Promise<AccessToken> {
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
    return buildAccessToken(json);
  }
}
