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
function formEncode(value: string): string {
  const params = new URLSearchParams();
  params.set("v", value);
  return params.toString().slice(2);
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
    return buildAccessToken(json);
  }
}
