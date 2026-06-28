import {
  buildAccessToken,
  CachedTokenProvider,
  readSanitizedTokenError,
  type TokenResponse,
} from "./base";
import type { AccessToken, OAuth2Config } from "./types";

// RFC 6749 §2.3.1 requires the client_id and client_secret to be
// `application/x-www-form-urlencoded`-encoded before being concatenated
// with `:` and base64'd. `encodeURIComponent` is *not* the same encoding —
// it leaves `!*'()` unencoded and emits `%20` for spaces instead of `+`.
// URLSearchParams uses the correct encoding.
//
// Exported so other OAuth-aware modules (e.g. the api-server SMART OAuth
// helper) share one implementation rather than maintaining lookalike
// copies that can drift out of spec compliance.
export function formEncodeOAuth(value: string): string {
  const params = new URLSearchParams();
  params.set("v", value);
  return params.toString().slice(2);
}

/**
 * Build the base64-encoded `username:password` payload that follows the
 * `Basic ` scheme in an HTTP `Authorization` header. Both halves are
 * RFC-6749 form-urlencoded first (see {@link formEncodeOAuth}). The
 * returned string is the credential portion only — the caller is
 * responsible for prefixing `Basic `.
 */
export function buildBasicAuthCredential(
  clientId: string,
  clientSecret: string,
): string {
  return Buffer.from(
    `${formEncodeOAuth(clientId)}:${formEncodeOAuth(clientSecret)}`,
  ).toString("base64");
}

export class OAuth2TokenProvider extends CachedTokenProvider {
  private readonly config: OAuth2Config;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OAuth2Config) {
    super();
    this.config = config;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  protected override async fetchToken(): Promise<AccessToken> {
    const body = new URLSearchParams();
    body.set("grant_type", "client_credentials");
    if (this.config.scope) body.set("scope", this.config.scope);

    const basic = buildBasicAuthCredential(
      this.config.clientId,
      this.config.clientSecret,
    );

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
    return buildAccessToken(json);
  }
}
