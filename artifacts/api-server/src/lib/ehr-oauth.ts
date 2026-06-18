import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import {
  ehrConnectionsTable,
  ehrOauthStatesTable,
  getDb,
  type EhrConnection,
} from "@workspace/db";
import { JwksClient, verifyJwt, JwtVerificationError } from "@workspace/ehr";
import { decryptToken, encryptToken } from "./token-crypto";
import { cernerConfig } from "./cerner-launch";

export type EhrProvider = "athenahealth" | "epic" | "cerner";

export class OauthStateError extends Error {
  override readonly name = "OauthStateError";
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class OauthExchangeError extends Error {
  override readonly name = "OauthExchangeError";
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.status = status;
  }
}

interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  fhirBaseUrl: string;
  clientId: string;
  clientSecret: string;
  scope: string;
  redirectUri: string;
  // Optional. When set, id_tokens returned from the token endpoint are
  // signature-verified against the JWKS at this URL before any claim
  // (practitioner id, fhirUser, etc.) is trusted. Providers without a
  // configured jwksUri fall back to TLS-trusted top-level token-response
  // fields only — the unverified id_token payload is NEVER read.
  jwksUri?: string;
  // Optional. When set, the access token minted at callback time is
  // introspected (RFC 7662) before the connection is persisted. The
  // returned `scope` is checked against `requiredScopes` — a missing
  // required scope fails the OAuth flow rather than letting the user
  // hit a confusing 4xx on first write-back.
  introspectUrl?: string;
  // Optional. When set, every scope in this list must appear in the
  // introspect response's granted-scope set. Empty / unset = no
  // enforcement (callback succeeds with whatever scopes Athena granted).
  requiredScopes?: string[];
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for the SMART OAuth flow.`);
  return v;
}

function maybeEnv(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

// Athena's preview / production environments expose
//   /oauth2/v1/authorize
//   /oauth2/v1/token
// next to the FHIR base. We accept explicit env vars so a customer
// running against a different deployment doesn't need a code change.
function athenahealthConfig(): ProviderConfig {
  const tokenUrl = requireEnv("ATHENA_TOKEN_URL");
  const fhirBaseUrl = requireEnv("ATHENA_FHIR_BASE_URL");
  // Default the authorize URL by replacing /token with /authorize on the
  // configured token URL — Athena keeps them at sibling paths.
  const authorizeUrl =
    maybeEnv("ATHENA_AUTHORIZE_URL") ??
    tokenUrl.replace(/\/token(\b|$)/, "/authorize$1");
  const clientId = requireEnv("ATHENA_CLIENT_ID");
  // Athena (Okta-backed) JWKS is at the sibling `/keys` path and
  // requires the `client_id` query param. See:
  //   https://docs.athenahealth.com/api/guides/additional-oauth-endpoints
  const jwksUri =
    maybeEnv("ATHENA_JWKS_URL") ??
    `${tokenUrl.replace(/\/token(\b|$)/, "/keys$1")}?client_id=${encodeURIComponent(clientId)}`;
  // Introspect is a sibling of `/token` per Athena's docs.
  const introspectUrl =
    maybeEnv("ATHENA_INTROSPECT_URL") ??
    tokenUrl.replace(/\/token(\b|$)/, "/introspect$1");
  // Operators set this to enforce a minimum scope set at connect-time.
  // Example: "openid fhirUser user/DocumentReference.write patient/*.read"
  const requiredScopes = maybeEnv("ATHENA_REQUIRED_SCOPES")
    ?.split(/\s+/)
    .filter(Boolean);
  return {
    authorizeUrl,
    tokenUrl,
    fhirBaseUrl,
    clientId,
    clientSecret: requireEnv("ATHENA_CLIENT_SECRET"),
    scope: process.env["ATHENA_SCOPE"] ?? "openid fhirUser",
    redirectUri: requireEnv("ATHENA_REDIRECT_URI"),
    jwksUri,
    introspectUrl,
    requiredScopes,
  };
}

export function providerConfig(provider: EhrProvider): ProviderConfig {
  if (provider === "athenahealth") return athenahealthConfig();
  if (provider === "cerner") return cernerConfig();
  // Epic uses the same SMART flow but a different env-var family. Wire
  // when needed — the rest of this module is provider-agnostic.
  throw new Error(`SMART OAuth not configured for provider "${provider}".`);
}

// PKCE per RFC 7636. Verifier is high-entropy URL-safe; challenge is
// SHA-256(verifier), base64url'd. Athena requires the S256 method.
function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

function generateState(): string {
  return randomBytes(32).toString("base64url");
}

export interface StartFlowResult {
  authorizeUrl: string;
  state: string;
}

const STATE_TTL_MS = 10 * 60 * 1000;

export async function startOauthFlow({
  organizationId,
  userId,
  provider,
  returnPath,
  launch,
}: {
  // The org the connection will be created for. Locked at /start time
  // so a mid-flow org-switch can't cause the callback to write the
  // connection into the wrong tenant.
  organizationId: string;
  userId: string;
  provider: EhrProvider;
  returnPath?: string;
  /**
   * SMART EHR-launch token. When present, the authorize URL carries
   * `launch=<token>` so the IdP knows which clinical-context bundle
   * to associate with the authorize request. Cerner-launched flows
   * always supply this; Athena's standalone-launch flow does not.
   * Per SMART, the `launch` scope must also be in the scope set
   * when this is used — callers configure that via providerConfig.
   */
  launch?: string;
}): Promise<StartFlowResult> {
  const cfg = providerConfig(provider);
  const state = generateState();
  const { verifier, challenge } = generatePkcePair();

  await getDb().insert(ehrOauthStatesTable).values({
    state,
    organizationId,
    userId,
    provider,
    codeVerifier: verifier,
    returnPath: returnPath ?? null,
  });

  // Athena requires `aud` set to the FHIR base URL — without it the
  // authorize endpoint 400s. PKCE S256 + state are SMART-standard.
  // Cerner additionally consumes `launch` here for the EHR-launch
  // flow (`aud` is the iss the EHR passed us, which our config has
  // pinned to CERNER_FHIR_BASE_URL).
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("scope", cfg.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("aud", cfg.fhirBaseUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (launch) {
    url.searchParams.set("launch", launch);
  }

  return { authorizeUrl: url.toString(), state };
}

interface PendingState {
  // Nullable for backfill on rows created before migration 0022.
  // completeOauthFlow throws if this is null when finalizing.
  organizationId: string | null;
  userId: string;
  provider: EhrProvider;
  codeVerifier: string;
  returnPath: string | null;
}

export async function consumeOauthState(state: string): Promise<PendingState> {
  // Garbage-collect any state rows older than the TTL while we're here —
  // a stray failed flow can leave verifier rows lying around indefinitely
  // otherwise.
  const cutoff = new Date(Date.now() - STATE_TTL_MS);
  await getDb()
    .delete(ehrOauthStatesTable)
    .where(lt(ehrOauthStatesTable.createdAt, cutoff));

  const [row] = await getDb()
    .delete(ehrOauthStatesTable)
    .where(eq(ehrOauthStatesTable.state, state))
    .returning();
  if (!row) {
    throw new OauthStateError("state_not_found");
  }
  if (row.createdAt.getTime() < cutoff.getTime()) {
    throw new OauthStateError("state_expired");
  }
  return {
    organizationId: row.organizationId,
    userId: row.userId,
    provider: row.provider as EhrProvider,
    codeVerifier: row.codeVerifier,
    returnPath: row.returnPath,
  };
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  // Athena returns SMART context claims at the top level:
  patient?: string;
  encounter?: string;
  practitioner?: string;
  // Some servers wrap context in a nested object.
  fhirContext?: { reference?: string }[];
  // Some servers return the practitioner via a `user` claim or `sub`.
  sub?: string;
  user?: string;
  id_token?: string;
}

// Module-level cache of JwksClient keyed by jwksUri — one client per
// (provider, deployment) URL. The client itself caches the JWKS document
// internally; this map just deduplicates client instances so we don't
// hold a separate TTL clock per callback.
const jwksClients = new Map<string, JwksClient>();

function getJwksClient(jwksUri: string): JwksClient {
  let client = jwksClients.get(jwksUri);
  if (!client) {
    client = new JwksClient({ jwksUri });
    jwksClients.set(jwksUri, client);
  }
  return client;
}

/** Exported for tests; do not call from production code. */
export function _resetJwksCacheForTests(): void {
  jwksClients.clear();
}

async function readVerifiedJwtClaims(
  idToken: string,
  cfg: ProviderConfig,
): Promise<Record<string, unknown>> {
  if (!cfg.jwksUri) {
    // Provider has no JWKS configured. Refuse to read claims from an
    // unsigned id_token — the caller will fall through to the
    // TLS-trusted top-level fields. This is intentional: silently
    // trusting an unverified id_token would defeat the whole point of
    // adding signature verification.
    throw new JwtVerificationError("no_jwks_configured");
  }
  const { claims } = await verifyJwt({
    token: idToken,
    jwks: getJwksClient(cfg.jwksUri),
    // OIDC: aud of an id_token is the client_id it was issued to.
    expectedAudience: cfg.clientId,
  });
  return claims;
}

function practitionerFromClaims(
  claims: Record<string, unknown>,
): string | null {
  // SMART id_tokens carry `fhirUser` as a reference like
  // "Practitioner/abc-123". Some IdPs also use `profile`.
  const candidates = [claims["fhirUser"], claims["profile"]];
  for (const c of candidates) {
    if (typeof c === "string" && c.includes("Practitioner/")) {
      return c.slice(c.lastIndexOf("/") + 1);
    }
  }
  return null;
}

async function extractPractitionerId(
  json: TokenResponse,
  cfg: ProviderConfig,
): Promise<string | null> {
  if (typeof json.practitioner === "string" && json.practitioner.length > 0) {
    // Sometimes returned as "Practitioner/123" — keep only the id part.
    const ref = json.practitioner;
    return ref.includes("/") ? ref.slice(ref.lastIndexOf("/") + 1) : ref;
  }
  for (const ctx of json.fhirContext ?? []) {
    const ref = ctx?.reference;
    if (typeof ref === "string" && ref.startsWith("Practitioner/")) {
      return ref.slice("Practitioner/".length);
    }
  }
  if (json.id_token && cfg.jwksUri) {
    // Signature-verified id_token. A verification failure here is treated
    // as a hard error by the caller — better to refuse the connection
    // than to attribute notes to a practitioner id we can't authenticate.
    const claims = await readVerifiedJwtClaims(json.id_token, cfg);
    const fromJwt = practitionerFromClaims(claims);
    if (fromJwt) return fromJwt;
  }
  return null;
}

function formEncode(value: string): string {
  // RFC 6749 §2.3.1: client credentials must be form-urlencoded (not
  // percent-encoded — `+` for space, `*'()!` retained literally) before
  // being concatenated for Basic auth.
  const p = new URLSearchParams();
  p.set("v", value);
  return p.toString().slice(2);
}

function basicAuthHeader(clientId: string, clientSecret: string): string {
  return Buffer.from(
    `${formEncode(clientId)}:${formEncode(clientSecret)}`,
  ).toString("base64");
}

interface IntrospectResponse {
  active: boolean;
  scope?: string;
  exp?: number;
}

/**
 * RFC 7662 token introspection. Athena requires client authentication
 * via Basic header (see additional-oauth-endpoints docs). Returns the
 * parsed response on success; throws OauthExchangeError on non-2xx so
 * callers see a clear failure mode rather than a silent "no enforcement
 * happened" path.
 */
export async function introspectToken(
  cfg: ProviderConfig,
  accessToken: string,
): Promise<IntrospectResponse> {
  if (!cfg.introspectUrl) {
    throw new Error("introspectToken called without introspectUrl");
  }
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
    authorization: `Basic ${basicAuthHeader(cfg.clientId, cfg.clientSecret)}`,
  };
  const body = new URLSearchParams();
  body.set("token", accessToken);
  body.set("token_type_hint", "access_token");
  const res = await fetch(cfg.introspectUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });
  if (!res.ok) {
    // Body is intentionally not echoed — introspect responses include
    // scope strings and token metadata that we don't want in logs.
    throw new OauthExchangeError(
      `Token introspection failed: ${res.status} ${res.statusText}`,
      res.status,
    );
  }
  return (await res.json()) as IntrospectResponse;
}

function checkRequiredScopes(
  granted: string | undefined,
  required: string[],
): void {
  const grantedSet = new Set(
    (granted ?? "").split(/\s+/).filter((s) => s.length > 0),
  );
  const missing = required.filter((s) => !grantedSet.has(s));
  if (missing.length > 0) {
    // Don't echo the granted scope string — it's not PHI but it is
    // operator-tier configuration data that doesn't belong in client-
    // facing errors. The missing-scope list IS safe to surface (the
    // operator chose those values).
    throw new OauthExchangeError(
      `Required scopes not granted: ${missing.join(" ")}`,
      403,
    );
  }
}

async function postTokenEndpoint(
  cfg: ProviderConfig,
  body: URLSearchParams,
): Promise<TokenResponse> {
  // Confidential clients: send credentials via Basic so the secret
  // never appears in any logged request body.
  // Public clients (Cerner pilot registers as public): the secret is
  // empty; SMART says to put `client_id` in the body and omit Basic
  // entirely. PKCE still authenticates the client.
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/x-www-form-urlencoded",
  };
  if (cfg.clientSecret.length > 0) {
    headers["authorization"] = `Basic ${basicAuthHeader(cfg.clientId, cfg.clientSecret)}`;
  } else if (!body.has("client_id")) {
    body.set("client_id", cfg.clientId);
  }
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers,
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    // Sanitize: do NOT echo body content — token responses can include
    // refresh tokens or echoed credentials.
    let detail = "";
    try {
      const j = JSON.parse(text) as {
        error?: string;
        error_description?: string;
      };
      if (j.error || j.error_description) {
        detail = `${j.error ?? ""}${
          j.error_description ? `: ${j.error_description}` : ""
        }`;
      }
    } catch {
      // non-JSON
    }
    throw new OauthExchangeError(
      `Token exchange failed: ${res.status} ${res.statusText}` +
        (detail ? ` — ${detail}` : ""),
      res.status,
    );
  }
  return JSON.parse(text) as TokenResponse;
}

export interface CompletedConnection {
  organizationId: string;
  userId: string;
  provider: EhrProvider;
  practitionerId: string | null;
  expiresAt: Date;
  returnPath: string | null;
  /**
   * SMART launch context returned by the IdP in the token response.
   * Populated when present (Cerner EHR-launch flows always include
   * them; Athena's standalone flow leaves them null). The plaintext
   * access token is included so the caller can do a one-shot FHIR
   * read for patient sync — it is NOT persisted in plaintext
   * (upsertConnection already encrypted the stored copy).
   */
  launchContext: {
    patient: string | null;
    encounter: string | null;
    accessToken: string;
  } | null;
}

export async function completeOauthFlow({
  state,
  code,
}: {
  state: string;
  code: string;
}): Promise<CompletedConnection> {
  const pending = await consumeOauthState(state);
  const cfg = providerConfig(pending.provider);

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("code", code);
  body.set("redirect_uri", cfg.redirectUri);
  body.set("client_id", cfg.clientId);
  body.set("code_verifier", pending.codeVerifier);

  const json = await postTokenEndpoint(cfg, body);
  const expiresInSec = clampExpiresIn(json.expires_in);
  const expiresAt = new Date(Date.now() + expiresInSec * 1000);
  let practitionerId: string | null;
  try {
    practitionerId = await extractPractitionerId(json, cfg);
  } catch (err) {
    if (err instanceof JwtVerificationError) {
      // Tampered or invalid id_token signature — refuse the whole
      // connection. The token endpoint response is TLS-trusted, but a
      // valid id_token signature is the OIDC-spec defense against
      // misissued or replayed tokens and the binding for practitioner
      // attribution. Failing closed here is a HIPAA-integrity choice.
      throw new OauthExchangeError(
        `id_token verification failed (${err.reason})`,
        401,
      );
    }
    throw err;
  }

  // Introspect + scope enforcement. Gated on both `introspectUrl` and a
  // non-empty `requiredScopes` so unconfigured providers (Cerner, Epic
  // until wired) and operators who haven't opted in skip the extra
  // round-trip. The granted-scope source of truth is the introspect
  // response — NOT the token response's `scope` field — because some
  // IdPs return a permissive `scope` echo in the token response and a
  // narrower actually-granted set via introspect.
  let grantedScope = json.scope ?? null;
  if (
    cfg.introspectUrl &&
    cfg.requiredScopes &&
    cfg.requiredScopes.length > 0
  ) {
    const introspected = await introspectToken(cfg, json.access_token);
    if (!introspected.active) {
      throw new OauthExchangeError("introspected_token_inactive", 401);
    }
    checkRequiredScopes(introspected.scope, cfg.requiredScopes);
    if (introspected.scope) grantedScope = introspected.scope;
  }

  if (!pending.organizationId) {
    // Legacy state row created before 0022. We could fall back to the
    // user's primary membership, but failing closed is safer: this
    // would only happen for in-flight flows that crossed the migration
    // boundary, and forcing a restart is benign.
    throw new OauthStateError("state_missing_organization");
  }
  await upsertConnection({
    organizationId: pending.organizationId,
    userId: pending.userId,
    provider: pending.provider,
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt,
    practitionerId,
    scope: grantedScope,
  });

  // Parse SMART launch context from the token response. Patient
  // comes back as a bare id (per SMART) but defensively strip a
  // `Patient/` prefix if a server adds one. Same for encounter.
  const stripRef = (ref: string | undefined, type: string): string | null => {
    if (!ref) return null;
    if (ref.startsWith(`${type}/`)) return ref.slice(type.length + 1);
    return ref;
  };
  const launchContext =
    json.patient || json.encounter
      ? {
          patient: stripRef(json.patient, "Patient"),
          encounter: stripRef(json.encounter, "Encounter"),
          // The caller decrypts again later via getValidAccessToken
          // for any persistent operations; but for the one-shot
          // FHIR Patient read at callback time we have the plaintext
          // right here. Persisted copy is already encrypted above.
          accessToken: json.access_token,
        }
      : null;

  return {
    // Non-null is guaranteed by the throw above on pending.organizationId.
    organizationId: pending.organizationId,
    userId: pending.userId,
    provider: pending.provider,
    practitionerId,
    expiresAt,
    returnPath: pending.returnPath,
    launchContext,
  };
}

function clampExpiresIn(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return 300;
  return Math.min(Math.floor(n), 86_400);
}

// Exported for tests that assert the at-rest encryption boundary.
// Production callers should still go through `completeOauthFlow`.
export async function upsertConnection(input: {
  organizationId: string;
  userId: string;
  provider: EhrProvider;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  practitionerId: string | null;
  scope: string | null;
}): Promise<void> {
  const db = getDb();
  // Encrypt at the boundary — the DB only ever sees ciphertext for
  // access/refresh tokens.
  const encryptedAccess = encryptToken(input.accessToken);
  const encryptedRefresh =
    input.refreshToken !== null ? encryptToken(input.refreshToken) : null;
  await db.transaction(async (tx) => {
    // Onconflict-update so reconnect refreshes the row instead of
    // erroring on the unique index.
    await tx
      .insert(ehrConnectionsTable)
      .values({
        organizationId: input.organizationId,
        userId: input.userId,
        provider: input.provider,
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        expiresAt: input.expiresAt,
        practitionerId: input.practitionerId,
        scope: input.scope,
      })
      .onConflictDoUpdate({
        target: [ehrConnectionsTable.userId, ehrConnectionsTable.provider],
        set: {
          accessToken: encryptedAccess,
          refreshToken: encryptedRefresh,
          expiresAt: input.expiresAt,
          practitionerId: input.practitionerId,
          scope: input.scope,
          updatedAt: new Date(),
        },
      });

    // Mirror the practitioner id onto users.ehr_practitioner_id so the
    // existing per-user-scoped queries (schedule, etc.) pick it up
    // without code changes elsewhere.
    if (input.practitionerId) {
      const { usersTable } = await import("@workspace/db");
      await tx
        .update(usersTable)
        .set({ ehrPractitionerId: input.practitionerId })
        .where(eq(usersTable.id, input.userId));
    }
  });
}

export async function getConnection(
  userId: string,
  provider: EhrProvider,
): Promise<EhrConnection | null> {
  const [row] = await getDb()
    .select()
    .from(ehrConnectionsTable)
    .where(
      and(
        eq(ehrConnectionsTable.userId, userId),
        eq(ehrConnectionsTable.provider, provider),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function deleteConnection(
  userId: string,
  provider: EhrProvider,
): Promise<boolean> {
  const rows = await getDb()
    .delete(ehrConnectionsTable)
    .where(
      and(
        eq(ehrConnectionsTable.userId, userId),
        eq(ehrConnectionsTable.provider, provider),
      ),
    )
    .returning({ id: ehrConnectionsTable.id });
  return rows.length > 0;
}

const REFRESH_SKEW_MS = 30_000;

/**
 * Returns a current access token for the user's connection, refreshing
 * if it's within the skew window. Persists the refreshed token back to
 * the row. Throws if no connection exists or the refresh fails.
 */
export async function getValidAccessToken(
  userId: string,
  provider: EhrProvider,
): Promise<string> {
  const conn = await getConnection(userId, provider);
  if (!conn) {
    throw new OauthExchangeError("no_connection", 404);
  }
  if (conn.expiresAt.getTime() - REFRESH_SKEW_MS > Date.now()) {
    // expiresAt is in plaintext on the row; the access token itself is
    // ciphertext and must be decrypted before being handed to callers.
    return decryptToken(conn.accessToken);
  }
  if (!conn.refreshToken) {
    throw new OauthExchangeError("no_refresh_token", 401);
  }
  const cfg = providerConfig(provider);
  const plaintextRefresh = decryptToken(conn.refreshToken);
  const body = new URLSearchParams();
  body.set("grant_type", "refresh_token");
  body.set("refresh_token", plaintextRefresh);
  body.set("client_id", cfg.clientId);

  const json = await postTokenEndpoint(cfg, body);
  const newExpiresAt = new Date(
    Date.now() + clampExpiresIn(json.expires_in) * 1000,
  );

  // Some IdPs rotate the refresh token; if a new one came back, store it.
  // Otherwise keep the existing (still-encrypted) value on the row.
  const newRefreshCiphertext =
    json.refresh_token !== undefined
      ? encryptToken(json.refresh_token)
      : conn.refreshToken;

  await getDb()
    .update(ehrConnectionsTable)
    .set({
      accessToken: encryptToken(json.access_token),
      refreshToken: newRefreshCiphertext,
      expiresAt: newExpiresAt,
      scope: json.scope ?? conn.scope,
      updatedAt: new Date(),
    })
    .where(eq(ehrConnectionsTable.id, conn.id));

  return json.access_token;
}
