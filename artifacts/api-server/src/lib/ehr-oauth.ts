import { createHash, randomBytes } from "node:crypto";
import { and, eq, lt } from "drizzle-orm";
import {
  ehrConnectionsTable,
  ehrOauthStatesTable,
  getDb,
  type EhrConnection,
} from "@workspace/db";
import { decryptToken, encryptToken } from "./token-crypto";

export type EhrProvider = "athenahealth" | "epic";

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
  return {
    authorizeUrl,
    tokenUrl,
    fhirBaseUrl,
    clientId: requireEnv("ATHENA_CLIENT_ID"),
    clientSecret: requireEnv("ATHENA_CLIENT_SECRET"),
    scope: process.env["ATHENA_SCOPE"] ?? "openid fhirUser",
    redirectUri: requireEnv("ATHENA_REDIRECT_URI"),
  };
}

export function providerConfig(provider: EhrProvider): ProviderConfig {
  if (provider === "athenahealth") return athenahealthConfig();
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
  userId,
  provider,
  returnPath,
}: {
  userId: string;
  provider: EhrProvider;
  returnPath?: string;
}): Promise<StartFlowResult> {
  const cfg = providerConfig(provider);
  const state = generateState();
  const { verifier, challenge } = generatePkcePair();

  await getDb().insert(ehrOauthStatesTable).values({
    state,
    userId,
    provider,
    codeVerifier: verifier,
    returnPath: returnPath ?? null,
  });

  // Athena requires `aud` set to the FHIR base URL — without it the
  // authorize endpoint 400s. PKCE S256 + state are SMART-standard.
  const url = new URL(cfg.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("scope", cfg.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("aud", cfg.fhirBaseUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return { authorizeUrl: url.toString(), state };
}

interface PendingState {
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

function readJwtPractitioner(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    // SMART id_tokens carry `fhirUser` as a reference like
    // "Practitioner/abc-123". Some IdPs also use `profile`.
    const candidates = [payload["fhirUser"], payload["profile"]];
    for (const c of candidates) {
      if (typeof c === "string" && c.includes("Practitioner/")) {
        return c.slice(c.lastIndexOf("/") + 1);
      }
    }
  } catch {
    // best effort
  }
  return null;
}

function extractPractitionerId(json: TokenResponse): string | null {
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
  const fromJwt = readJwtPractitioner(json.id_token);
  if (fromJwt) return fromJwt;
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

async function postTokenEndpoint(
  cfg: ProviderConfig,
  body: URLSearchParams,
): Promise<TokenResponse> {
  // Athena's preview accepts the client_secret in either the Basic
  // header or the body. We use Basic so the secret never appears in
  // any logged request body.
  const basic = basicAuthHeader(cfg.clientId, cfg.clientSecret);
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${basic}`,
    },
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
  userId: string;
  provider: EhrProvider;
  practitionerId: string | null;
  expiresAt: Date;
  returnPath: string | null;
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
  const practitionerId = extractPractitionerId(json);

  await upsertConnection({
    userId: pending.userId,
    provider: pending.provider,
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt,
    practitionerId,
    scope: json.scope ?? null,
  });

  return {
    userId: pending.userId,
    provider: pending.provider,
    practitionerId,
    expiresAt,
    returnPath: pending.returnPath,
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
