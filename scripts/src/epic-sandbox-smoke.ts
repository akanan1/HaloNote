// Diagnostic smoke test for the Epic SMART per-user OAuth integration.
// Verifies the moving pieces of the auth chain WITHOUT performing the
// browser-only auth_code exchange:
//
//   [1] /.well-known/jwks.json on the configured api-server returns the
//       Epic key id Epic will see in client_assertion.kid.
//   [2] A client_assertion JWT can be built locally with EPIC_* env vars
//       and is well-formed (parses, alg=ES384/RS384/…, iss=sub=clientId,
//       aud=tokenUrl, exp in future, kid matches the public JWK).
//   [3] The full SMART authorize URL is well-formed (PKCE-S256, scope
//       set, redirect_uri matches EPIC_REDIRECT_URI). Printed for manual
//       browser-driven completion of the auth_code flow.
//
// Run: pnpm --filter @workspace/scripts run epic-sandbox-smoke
//
// ─── PHI-safe logging contract ────────────────────────────────────────
// This script never contacts a customer Epic tenant — only the public
// sandbox + your own api-server's JWKS endpoint. Even so, treat the
// printed authorize URL as sensitive: it embeds the PKCE code_verifier
// (mint a fresh one every run; never reuse).
// ──────────────────────────────────────────────────────────────────────

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { signJwt } from "@workspace/ehr/auth";
import type { JwtSigningAlgorithm } from "@workspace/ehr/auth";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  if (!value || value.trim().length === 0) return undefined;
  return value;
}

function normalizePem(raw: string): string {
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

interface PublicJwk {
  kty: string;
  kid: string;
  alg: string;
  use?: string;
}

interface JwksDocument {
  keys: PublicJwk[];
}

function base64urlNoPad(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64urlNoPad(randomBytes(64));
  const challenge = base64urlNoPad(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function step1_VerifyJwksEndpoint(jwksUrl: string, expectedKid: string): Promise<void> {
  console.log(`[1/3] GET ${jwksUrl}`);
  const res = await fetch(jwksUrl, { headers: { accept: "application/json" } });
  if (!res.ok) {
    throw new Error(
      `      FAIL — JWKS endpoint returned ${res.status} ${res.statusText}. ` +
        `Is api-server deployed with EPIC_PRIVATE_KEY + EPIC_KEY_ID set?`,
    );
  }
  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.includes("application/json")) {
    throw new Error(
      `      FAIL — JWKS endpoint returned non-JSON content-type: ${ctype}`,
    );
  }
  const doc = (await res.json()) as JwksDocument;
  if (!doc.keys || doc.keys.length === 0) {
    throw new Error(
      "      FAIL — JWKS document has empty `keys` array. " +
        "EPIC_PRIVATE_KEY / EPIC_KEY_ID likely unset on the deployed api-server.",
    );
  }
  const match = doc.keys.find((k) => k.kid === expectedKid);
  if (!match) {
    const seen = doc.keys.map((k) => k.kid).join(", ");
    throw new Error(
      `      FAIL — expected kid "${expectedKid}" not found in JWKS. ` +
        `Saw: [${seen}]. The local EPIC_KEY_ID does not match what api-server publishes.`,
    );
  }
  // PHI-safe: kid and alg are operator-tier config, not credentials.
  console.log(
    `      OK — ${doc.keys.length} key(s) published; matched kid="${match.kid}" alg="${match.alg}" kty="${match.kty}"`,
  );
}

async function step2_BuildClientAssertion(args: {
  clientId: string;
  tokenUrl: string;
  audience: string;
  algorithm: JwtSigningAlgorithm;
  privateKey: string;
  keyId: string;
}): Promise<string> {
  console.log(`[2/3] Building client_assertion JWT (alg=${args.algorithm})…`);
  const now = Math.floor(Date.now() / 1000);
  const assertion = await signJwt({
    header: { kid: args.keyId },
    claims: {
      iss: args.clientId,
      sub: args.clientId,
      aud: args.audience,
      jti: randomUUID(),
      iat: now - 30,
      exp: now + 300,
    },
    algorithm: args.algorithm,
    privateKey: args.privateKey,
  });

  // Decode and sanity-check structure. We do NOT verify the signature
  // here — the public key Epic will use lives at the JWKS URL, already
  // verified in step 1.
  const parts = assertion.split(".");
  if (parts.length !== 3) {
    throw new Error(`      FAIL — built assertion has ${parts.length} parts, expected 3`);
  }
  const headerB64 = parts[0] as string;
  const claimsB64 = parts[1] as string;
  const header = JSON.parse(
    Buffer.from(headerB64, "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  const claims = JSON.parse(
    Buffer.from(claimsB64, "base64url").toString("utf8"),
  ) as Record<string, unknown>;

  if (header["alg"] !== args.algorithm) {
    throw new Error(
      `      FAIL — assertion alg=${String(header["alg"])}, expected ${args.algorithm}`,
    );
  }
  if (header["kid"] !== args.keyId) {
    throw new Error(
      `      FAIL — assertion kid=${String(header["kid"])}, expected ${args.keyId}`,
    );
  }
  if (claims["iss"] !== args.clientId || claims["sub"] !== args.clientId) {
    throw new Error(
      `      FAIL — assertion iss/sub mismatch (expected ${args.clientId})`,
    );
  }
  if (claims["aud"] !== args.audience) {
    throw new Error(
      `      FAIL — assertion aud=${String(claims["aud"])}, expected ${args.audience}`,
    );
  }
  const exp = claims["exp"];
  if (typeof exp !== "number" || exp <= now) {
    throw new Error(
      `      FAIL — assertion exp=${String(exp)} not in the future (now=${now})`,
    );
  }
  console.log(
    `      OK — well-formed; iss/sub=${args.clientId}, aud=${args.audience}, ttl=${exp - now}s`,
  );
  return assertion;
}

function step3_BuildAuthorizeUrl(args: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  aud: string;
}): string {
  console.log(`[3/3] Building SMART authorize URL with PKCE-S256…`);
  const { verifier, challenge } = generatePkcePair();
  const state = base64urlNoPad(randomBytes(24));
  const url = new URL(args.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("scope", args.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("aud", args.aud);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  console.log(
    `      OK — authorize URL built (scope contains ${args.scope.split(/\s+/).length} entries)`,
  );
  console.log(`\n      Open in a browser to complete the auth_code flow:`);
  console.log(`      ${url.toString()}\n`);
  console.log(
    `      code_verifier (paste into token-exchange test, single use): ${verifier}\n`,
  );
  return url.toString();
}

async function main(): Promise<void> {
  // Pulled directly from the api-server's env-var family — same names so
  // operators don't have to remember a second set.
  const clientId = required("EPIC_CLIENT_ID");
  const tokenUrl = required("EPIC_TOKEN_URL");
  const authorizeUrl =
    optional("EPIC_AUTHORIZE_URL") ??
    tokenUrl.replace(/\/token(\b|$)/, "/authorize$1");
  const fhirBaseUrl = required("EPIC_FHIR_BASE_URL");
  const redirectUri = required("EPIC_REDIRECT_URI");
  const privateKey = normalizePem(required("EPIC_PRIVATE_KEY"));
  const keyId = required("EPIC_KEY_ID");
  const audience = optional("EPIC_AUDIENCE") ?? tokenUrl;
  const algorithmRaw = (process.env["EPIC_ALGORITHM"] ?? "ES384").toUpperCase();
  const scope =
    optional("EPIC_SCOPE") ??
    "openid fhirUser launch/patient offline_access " +
      "patient/Patient.read patient/Encounter.read " +
      "patient/Condition.read patient/Observation.read " +
      "patient/MedicationRequest.read patient/AllergyIntolerance.read " +
      "patient/DocumentReference.read patient/DocumentReference.write";

  // JWKS URL is the api-server's own /.well-known/jwks.json. Default to
  // the production host; operators can override for local/sandbox.
  const jwksUrl =
    optional("EPIC_JWKS_PUBLISH_URL") ?? "https://api.halonote.app/.well-known/jwks.json";

  console.log(`Epic SMART smoke test — diagnostic only, no real auth performed`);
  console.log(`  client_id    = ${clientId}`);
  console.log(`  token_url    = ${tokenUrl}`);
  console.log(`  authorize    = ${authorizeUrl}`);
  console.log(`  fhir_base    = ${fhirBaseUrl}`);
  console.log(`  redirect_uri = ${redirectUri}`);
  console.log(`  kid          = ${keyId}`);
  console.log(`  algorithm    = ${algorithmRaw}\n`);

  await step1_VerifyJwksEndpoint(jwksUrl, keyId);
  await step2_BuildClientAssertion({
    clientId,
    tokenUrl,
    audience,
    algorithm: algorithmRaw as JwtSigningAlgorithm,
    privateKey,
    keyId,
  });
  step3_BuildAuthorizeUrl({
    authorizeUrl,
    clientId,
    redirectUri,
    scope,
    aud: fhirBaseUrl,
  });

  console.log(`Epic SMART smoke test passed (steps 1–3).`);
  console.log(
    `Step 4 (auth_code → token exchange) is browser-driven; open the URL above to complete it.`,
  );
}

main().catch((err: unknown) => {
  // Never `console.error(err)` directly — JWT errors can include the
  // signing input which (in pathological cases) could carry env values.
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`Epic SMART smoke test failed: ${msg}`);
  process.exit(1);
});
