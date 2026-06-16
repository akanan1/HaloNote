import { createPublicKey, type KeyObject } from "node:crypto";

// A JSON Web Key as published by an OIDC IdP's JWKS endpoint. We only
// declare the fields we read; the rest are passed through to
// `createPublicKey({ key, format: "jwk" })`, which validates the full
// structure per the relevant alg.
export interface Jwk {
  kid?: string;
  kty: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
  [otherClaim: string]: unknown;
}

export interface JwksDocument {
  keys: Jwk[];
}

export interface JwksClientOptions {
  /** URL to fetch the JWKS from. */
  jwksUri: string;
  /**
   * How long to trust a cached JWKS document before re-fetching, in ms.
   * The cache is ALSO forcibly refreshed on a `kid` miss (covers fast
   * key rotation by the IdP), so this TTL is the "happy-path" upper
   * bound, not a hard correctness boundary.
   */
  cacheTtlMs?: number;
  /**
   * Minimum interval between forced refreshes on `kid` miss. Stops a
   * flood of malformed / spoofed tokens from turning each request into
   * a JWKS fetch (cheap DoS amplifier).
   */
  refreshCooldownMs?: number;
  fetchImpl?: typeof fetch;
}

const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_REFRESH_COOLDOWN_MS = 30 * 1000;

interface CacheEntry {
  fetchedAt: number;
  keysByKid: Map<string, KeyObject>;
  keysByKty: Map<string, KeyObject>;
}

export class JwksFetchError extends Error {
  override readonly name = "JwksFetchError";
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.status = status;
  }
}

export class JwksKeyNotFoundError extends Error {
  override readonly name = "JwksKeyNotFoundError";
  constructor(kid: string | null) {
    super(
      kid
        ? `No JWKS key matched kid "${kid}".`
        : "Token had no `kid` header and JWKS exposes multiple keys.",
    );
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class JwksClient {
  private cache: CacheEntry | null = null;
  private lastForceRefreshAt = 0;
  private inflight: Promise<CacheEntry> | null = null;

  constructor(private readonly opts: JwksClientOptions) {}

  /**
   * Returns the public key matching `kid` from the cached JWKS, refreshing
   * the cache if it's stale or doesn't contain `kid`. When `kid` is null
   * (some tokens omit it), returns the single key in the JWKS if there is
   * exactly one — otherwise throws, because picking arbitrarily defeats
   * the point of signature verification.
   */
  async getKey(kid: string | null): Promise<KeyObject> {
    const ttl = this.opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    const cooldown =
      this.opts.refreshCooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
    const now = Date.now();

    let entry = this.cache;
    const cacheStale = !entry || now - entry.fetchedAt > ttl;
    if (cacheStale) {
      entry = await this.refresh();
    }

    const found = lookup(entry!, kid);
    if (found) return found;

    // kid not in cache. Most likely the IdP rotated; force one more
    // fetch (rate-limited) and retry. If still missing, give up loudly
    // so the caller surfaces a meaningful error to the user.
    if (now - this.lastForceRefreshAt < cooldown) {
      throw new JwksKeyNotFoundError(kid);
    }
    this.lastForceRefreshAt = now;
    entry = await this.refresh();
    const retried = lookup(entry, kid);
    if (retried) return retried;
    throw new JwksKeyNotFoundError(kid);
  }

  /** For tests + diagnostics. */
  peekCached(): { fetchedAt: number; kids: string[] } | null {
    if (!this.cache) return null;
    return {
      fetchedAt: this.cache.fetchedAt,
      kids: [...this.cache.keysByKid.keys()],
    };
  }

  private async refresh(): Promise<CacheEntry> {
    // Coalesce concurrent refreshes — multiple in-flight token exchanges
    // hitting an expired cache should not stampede the JWKS endpoint.
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const fetcher = this.opts.fetchImpl ?? fetch;
        const res = await fetcher(this.opts.jwksUri, {
          headers: { accept: "application/json" },
        });
        if (!res.ok) {
          throw new JwksFetchError(
            `JWKS fetch failed: ${res.status} ${res.statusText}`,
            res.status,
          );
        }
        const doc = (await res.json()) as JwksDocument;
        if (!doc || !Array.isArray(doc.keys)) {
          throw new JwksFetchError(
            "JWKS response had no `keys` array.",
            res.status,
          );
        }
        const keysByKid = new Map<string, KeyObject>();
        const keysByKty = new Map<string, KeyObject>();
        for (const jwk of doc.keys) {
          // Refuse symmetric keys outright — an `oct` key in a JWKS used
          // for ID-token verification is a configuration error, and
          // accepting one would let a malicious IdP pass an HMAC secret
          // that we'd then use to "verify" anything.
          if (jwk.kty === "oct") continue;
          let key: KeyObject;
          try {
            key = createPublicKey({ key: jwk as never, format: "jwk" });
          } catch {
            // Skip unparseable keys rather than failing the whole fetch —
            // a single broken entry shouldn't wedge the integration.
            continue;
          }
          if (jwk.kid) keysByKid.set(jwk.kid, key);
          if (!keysByKty.has(jwk.kty)) keysByKty.set(jwk.kty, key);
        }
        const entry: CacheEntry = {
          fetchedAt: Date.now(),
          keysByKid,
          keysByKty,
        };
        this.cache = entry;
        return entry;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}

function lookup(entry: CacheEntry, kid: string | null): KeyObject | null {
  if (kid) {
    return entry.keysByKid.get(kid) ?? null;
  }
  // No kid in the token header. Only safe to proceed when the JWKS has
  // exactly one key total (across all kty values) — otherwise we'd be
  // guessing which key signed the token.
  if (entry.keysByKid.size + entry.keysByKty.size === 1) {
    const only =
      entry.keysByKid.values().next().value ??
      entry.keysByKty.values().next().value ??
      null;
    return only;
  }
  return null;
}
