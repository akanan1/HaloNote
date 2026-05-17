// Live smoke test against athenahealth's Preview FHIR sandbox using the
// 2-legged sandbox app. Validates the OAuth2TokenProvider + FhirClient
// path end-to-end against Practice 195900's documented test patients,
// without needing a real provider OAuth login.
//
// Run: pnpm --filter @workspace/scripts run athena-sandbox-smoke
//
// ─── PHI-safe logging contract ────────────────────────────────────────
// This script runs against a *sandbox* with canned demo data, BUT the
// same script is used to verify connectivity in environments where the
// FHIR base URL has been pointed at a production-shaped endpoint by an
// operator typo. Treat every value returned from FHIR as PHI:
//
//   - DO log:    step labels, success/failure, counts, elapsed ms,
//                FHIR resource type, HTTP status on errors.
//   - DO NOT log: access tokens (not even prefixes — a fragment is
//                still credential material), refresh tokens, patient
//                names, MRNs, DOBs, gender, FHIR resource ids,
//                OperationOutcome diagnostics, or any raw FHIR body.
//
// `FhirError` carries `rawBody` and `outcome` — Athena fills the
// diagnostics field with patient-identifying text on validation
// failures, so those fields are deliberately never read here.
// ──────────────────────────────────────────────────────────────────────

import { createAthenahealthClient } from "@workspace/ehr/athenahealth";

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// Build a credential- and PHI-free one-line description of a thrown
// error. We extract only allow-listed scalar fields and never touch
// FhirError.rawBody or FhirError.outcome (both can quote PHI back at
// us). Falls back to the constructor name when no useful structure is
// available, so we still get *some* signal without leaking.
function safeFormatError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name || "Error";
    // Strip anything that looks like a URL query string or a token-ish
    // long base64-ish blob from the message before logging. Defensive —
    // the underlying libraries already sanitize, but a regression
    // upstream shouldn't leak through this script.
    const msg = err.message
      .replace(/\?[^\s]*/g, "?[redacted-query]")
      .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted-token-like]");
    const statusRaw = (err as { status?: unknown }).status;
    const status = typeof statusRaw === "number" ? ` status=${statusRaw}` : "";
    return `${name}: ${msg}${status}`;
  }
  return `non-Error thrown (typeof=${typeof err})`;
}

function elapsed(startMs: number): string {
  return `${Date.now() - startMs}ms`;
}

async function main(): Promise<void> {
  const practiceId = required("ATHENA_SANDBOX_PRACTICE_ID");
  const client = createAthenahealthClient({
    fhirBaseUrl: required("ATHENA_FHIR_BASE_URL"),
    tokenUrl: required("ATHENA_TOKEN_URL"),
    clientId: required("ATHENA_SANDBOX_CLIENT_ID"),
    clientSecret: required("ATHENA_SANDBOX_CLIENT_SECRET"),
    scope: required("ATHENA_SANDBOX_SCOPE"),
  });

  const ahPractice = `Organization/a-1.Practice-${practiceId}`;

  // Step 1 — token mint. Log only the fact that a token came back and
  // how long it took. Never log the token, a prefix of it, or its
  // length (length leaks information about the IdP's format).
  const t1 = Date.now();
  console.log(`[1/3] Minting access token via client_credentials…`);
  await client.auth.getToken();
  console.log(`      OK — token minted in ${elapsed(t1)}`);

  // Step 2 — patient search. The search criterion is a fixed sandbox
  // demo string; log a generic description instead of echoing the name
  // filter (the criterion happens to be benign here, but the habit of
  // echoing search params back into logs is the wrong default).
  const t2 = Date.now();
  console.log(`[2/3] Searching Patient resources in Practice ${practiceId}…`);
  const bundle = await client.fhir.search<{
    resourceType: "Patient";
    id: string;
    name?: Array<{ family?: string; given?: string[] }>;
    birthDate?: string;
    gender?: string;
  }>("Patient", {
    "ah-practice": ahPractice,
    name: "Sandboxtest",
  });
  const entries = bundle.entry ?? [];
  console.log(`      OK — ${entries.length} patient(s) returned in ${elapsed(t2)}`);
  // Per-entry structural summary only — booleans, never values. Useful
  // for catching "Athena returned rows but they were all malformed"
  // without logging any PHI.
  let withName = 0;
  let withBirthDate = 0;
  let withGender = 0;
  for (const e of entries) {
    const p = e.resource;
    if (!p) continue;
    if (p.name && p.name.length > 0) withName += 1;
    if (p.birthDate) withBirthDate += 1;
    if (p.gender) withGender += 1;
  }
  console.log(
    `      shape: name=${withName}/${entries.length}` +
      ` birthDate=${withBirthDate}/${entries.length}` +
      ` gender=${withGender}/${entries.length}`,
  );

  // Step 3 — read-back. We need a resource id to issue the GET, but we
  // must not log it (FHIR ids are identifiers under HIPAA §164.514).
  const t3 = Date.now();
  console.log(`[3/3] Reading the first patient back by ID…`);
  const firstId = entries[0]?.resource?.id;
  if (!firstId) {
    console.log(`      Skipped — no patients in search result.`);
    return;
  }
  const patient = await client.fhir.read<{
    resourceType: "Patient";
    id: string;
    name?: Array<{ family?: string; given?: string[] }>;
  }>("Patient", firstId);
  // Only log presence flags — no id, no name.
  const hasName = !!(patient.name && patient.name.length > 0);
  console.log(
    `      OK — Patient resource decoded in ${elapsed(t3)} (name field present: ${hasName})`,
  );

  console.log(`\nSandbox smoke test passed.`);
}

main().catch((err: unknown) => {
  // Never `console.error(err)` directly — would dump FhirError.rawBody
  // and OperationOutcome diagnostics, both of which Athena fills with
  // PHI on validation failures.
  console.error(`Sandbox smoke test failed: ${safeFormatError(err)}`);
  process.exit(1);
});

// ─── Test approach (not wired — scripts/ has no vitest today) ─────────
// To verify this script's logging is PHI-safe, the recommended pattern
// is a tiny harness that:
//
//   1. vi.mock("@workspace/ehr/athenahealth") to return a stub
//      `createAthenahealthClient` whose `auth.getToken()` resolves to
//      a fixture string like "FIXTURE_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaa"
//      and whose `fhir.search` / `fhir.read` resolve to a Bundle with
//      patients carrying distinctive PHI sentinels:
//        id        = "FIXTURE_PATIENT_ID_12345"
//        family    = "FIXTURE_FAMILY_NAME"
//        given     = ["FIXTURE_GIVEN_NAME"]
//        birthDate = "1970-01-01"
//        mrn       = "FIXTURE_MRN_67890"
//   2. Capture stdout/stderr by monkey-patching `console.log` /
//      `console.error` before `await import("./athena-sandbox-smoke")`.
//   3. Assert that none of the sentinel substrings appear in the
//      captured output. Also assert the happy-path operational lines
//      (`OK — token minted`, `OK — N patient(s) returned`) DO appear,
//      so we don't silently drop useful signal.
//
// The same harness shape also works for the error path: have the stub
// throw a `FhirError(msg, 422, outcome, rawBody)` where `rawBody`
// contains the same sentinels, and assert they don't leak through
// `safeFormatError`.
