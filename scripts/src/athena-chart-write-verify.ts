// Chart-API parameter discovery probe against Athena's sandbox.
//
// Run: pnpm --filter @workspace/scripts run athena-chart-write-verify
//
// ─── Why this exists ──────────────────────────────────────────────────
// Athena's chart REST endpoints (the proprietary /v1/{practiceId}/...
// surface that the product uses for diagnosis/procedure/problem write-
// back) accept slightly different parameter names depending on practice
// type and API version. The product code in
//   artifacts/api-server/src/lib/athena-chart-api.ts
// codes a best-guess set of param names and flags three uncertainties:
//
//   - diagnosis push: `icd10code` vs `diagnosiscode`
//   - procedure push: `procedurecode` vs `cpt`
//   - problem  push: status enum casing `ACTIVE`/`RESOLVED` vs `active`/`resolved`
//
// Rather than ship a guess to a new practice and discover the answer
// from production errors, this script hits each endpoint against the
// sandbox practice with the *individual* variants in turn so we learn
// which param Athena actually accepts. Update athena-chart-api.ts
// based on what this prints.
//
// ─── PHI safety ───────────────────────────────────────────────────────
// Sandbox practice + canned demo data, but the same contract applies as
// the smoke + write-probe scripts: never log tokens, raw response
// bodies, OperationOutcome diagnostics, Athena resource ids, patient
// ids, or encounter ids. The test patient + encounter ids are read from
// env vars and never echoed back to stdout — only their PRESENCE is
// logged. Status codes, attempt outcomes, allow-listed response headers,
// and structural shape flags are fine.
//
// ─── Inputs ───────────────────────────────────────────────────────────
// Required env vars (all read from the workspace .env via tsx --env-file):
//   ATHENA_TOKEN_URL
//   ATHENA_SANDBOX_CLIENT_ID
//   ATHENA_SANDBOX_CLIENT_SECRET
//   ATHENA_SANDBOX_SCOPE
//   ATHENA_SANDBOX_PRACTICE_ID
//   ATHENA_SANDBOX_TEST_PATIENT_ID    — a sandbox patient id (numeric, Athena format)
//   ATHENA_SANDBOX_TEST_ENCOUNTER_ID  — an OPEN encounter for that patient
// Optional:
//   ATHENA_CHART_BASE_URL             — defaults to the preview host
//
// ─── Side effects ─────────────────────────────────────────────────────
// Each successful attempt CREATES A RECORD in the sandbox practice
// (diagnosis on the encounter, charge line on the encounter, problem
// on the patient). Sandbox practices accumulate this junk until you
// reset them; this is acceptable, but the script logs the COUNT of
// records created so the operator knows what to expect.
// ──────────────────────────────────────────────────────────────────────

import { OAuth2TokenProvider } from "@workspace/ehr";

// ── env helpers ───────────────────────────────────────────────────────

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

// ── PHI-safe error formatting (mirrors athena-sandbox-smoke.ts) ───────

function safeFormatError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name || "Error";
    const msg = err.message
      .replace(/\?[^\s]*/g, "?[redacted-query]")
      .replace(/[A-Za-z0-9_-]{32,}/g, "[redacted-token-like]");
    return `${name}: ${msg}`;
  }
  return `non-Error thrown (typeof=${typeof err})`;
}

// ── allow-listed response headers ─────────────────────────────────────

const HEADER_ALLOW = [
  "content-type",
  "content-length",
  "www-authenticate",
  "x-correlation-id",
  "x-request-id",
  "x-amzn-requestid",
  "x-amzn-errortype",
  "retry-after",
  "allow",
];

function pickAllowedHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of HEADER_ALLOW) {
    const v = res.headers.get(name);
    if (v) out[name] = v;
  }
  return out;
}

// ── attempt orchestrator ──────────────────────────────────────────────

interface AttemptResult {
  label: string;
  status: number;
  ok: boolean;
  /** Top-level keys of the JSON response (NOT values). Empty if HTML / non-JSON. */
  responseShape: string[];
  /** True if the response contained at least one id-shaped field. */
  hasIdField: boolean;
  /** Allow-listed headers only. */
  headers: Record<string, string>;
}

const ID_KEY_HINTS = new Set([
  "id",
  "encounterdiagnosisid",
  "diagnosisid",
  "chargeid",
  "serviceid",
  "problemid",
]);

function shapeOf(raw: unknown): { keys: string[]; hasIdField: boolean } {
  const inspect = (obj: unknown): { keys: string[]; hasIdField: boolean } => {
    if (!obj || typeof obj !== "object") return { keys: [], hasIdField: false };
    const keys = Object.keys(obj as Record<string, unknown>);
    return {
      keys,
      hasIdField: keys.some((k) => ID_KEY_HINTS.has(k.toLowerCase())),
    };
  };
  if (Array.isArray(raw)) {
    const first = raw[0];
    return inspect(first);
  }
  return inspect(raw);
}

async function attempt(
  label: string,
  url: string,
  body: Record<string, string>,
  bearer: string,
  idempotencyKey: string,
): Promise<AttemptResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": idempotencyKey,
    },
    body: new URLSearchParams(body),
  });

  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Some Athena error pages are HTML — leave responseShape empty.
  }

  const { keys, hasIdField } = shapeOf(parsed);

  return {
    label,
    status: res.status,
    ok: res.ok,
    responseShape: keys,
    hasIdField,
    headers: pickAllowedHeaders(res),
  };
}

function logAttempt(r: AttemptResult): void {
  const verdict = r.ok
    ? `OK status=${r.status}`
    : `REJECTED status=${r.status}`;
  console.log(
    `      [${r.label}] ${verdict}` +
      ` shape=[${r.responseShape.join(",")}]` +
      ` hasIdField=${r.hasIdField}`,
  );
  if (r.headers["x-amzn-errortype"] || r.headers["www-authenticate"]) {
    console.log(`           hdrs=${JSON.stringify(r.headers)}`);
  }
}

// ── main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const baseUrl = (
    optional("ATHENA_CHART_BASE_URL") ??
    "https://api.preview.platform.athenahealth.com"
  ).replace(/\/+$/, "");
  const practiceId = required("ATHENA_SANDBOX_PRACTICE_ID");
  const patientId = required("ATHENA_SANDBOX_TEST_PATIENT_ID");
  const encounterId = required("ATHENA_SANDBOX_TEST_ENCOUNTER_ID");

  console.log(`[setup] base=${baseUrl}`);
  console.log(`[setup] practiceId set: yes`);
  console.log(`[setup] test patient/encounter ids set: yes`);

  const tokenProvider = new OAuth2TokenProvider({
    tokenUrl: required("ATHENA_TOKEN_URL"),
    clientId: required("ATHENA_SANDBOX_CLIENT_ID"),
    clientSecret: required("ATHENA_SANDBOX_CLIENT_SECRET"),
    scope: required("ATHENA_SANDBOX_SCOPE"),
  });

  console.log(`[setup] minting 2-legged token…`);
  const bearer = await tokenProvider.getToken();
  console.log(`[setup] token obtained`);

  // Deliberate benign codes — Z00.00 (general adult exam) for dx/problem,
  // 99213 (office visit, established patient) for procedure. Both are
  // safe in a sandbox practice and easy to spot if cleanup is needed.
  const safeIcd10 = "Z00.00";
  const safeCpt = "99213";

  const diagUrl =
    `${baseUrl}/v1/${practiceId}` +
    `/chart/encounter/${encodeURIComponent(encounterId)}/diagnoses`;
  const procUrl =
    `${baseUrl}/v1/${practiceId}` +
    `/chart/encounter/${encodeURIComponent(encounterId)}/services`;
  const probUrl =
    `${baseUrl}/v1/${practiceId}` +
    `/chart/${encodeURIComponent(patientId)}/problems`;

  let createdCount = 0;

  // [1/3] DIAGNOSIS — three variants: icd10code only, diagnosiscode only, both.
  console.log(`\n[1/3] DIAGNOSIS — POST .../encounter/{id}/diagnoses`);
  const diagResults: AttemptResult[] = [];
  diagResults.push(
    await attempt(
      "icd10code-only",
      diagUrl,
      { icd10code: safeIcd10, diagnosisdescription: "verify-script: dx-1" },
      bearer,
      "verify-script-dx-icd10code",
    ),
  );
  diagResults.push(
    await attempt(
      "diagnosiscode-only",
      diagUrl,
      {
        diagnosiscode: safeIcd10,
        diagnosisdescription: "verify-script: dx-2",
      },
      bearer,
      "verify-script-dx-diagnosiscode",
    ),
  );
  diagResults.push(
    await attempt(
      "both-params",
      diagUrl,
      {
        icd10code: safeIcd10,
        diagnosiscode: safeIcd10,
        diagnosisdescription: "verify-script: dx-3",
      },
      bearer,
      "verify-script-dx-both",
    ),
  );
  diagResults.forEach(logAttempt);
  createdCount += diagResults.filter((r) => r.ok).length;

  // [2/3] PROCEDURE — two variants: procedurecode-only vs cpt-only.
  console.log(`\n[2/3] PROCEDURE — POST .../encounter/{id}/services`);
  const procResults: AttemptResult[] = [];
  procResults.push(
    await attempt(
      "procedurecode",
      procUrl,
      {
        procedurecode: safeCpt,
        proceduredescription: "verify-script: proc-1",
      },
      bearer,
      "verify-script-proc-procedurecode",
    ),
  );
  procResults.push(
    await attempt(
      "cpt",
      procUrl,
      { cpt: safeCpt, proceduredescription: "verify-script: proc-2" },
      bearer,
      "verify-script-proc-cpt",
    ),
  );
  procResults.forEach(logAttempt);
  createdCount += procResults.filter((r) => r.ok).length;

  // [3/3] PROBLEM — two variants: status=ACTIVE vs status=active.
  console.log(`\n[3/3] PROBLEM — POST .../chart/{patientId}/problems`);
  const probResults: AttemptResult[] = [];
  probResults.push(
    await attempt(
      "status-uppercase",
      probUrl,
      {
        snomedcode: "",
        icd10code: safeIcd10,
        note: "verify-script: problem-1",
        status: "ACTIVE",
      },
      bearer,
      "verify-script-prob-uppercase",
    ),
  );
  probResults.push(
    await attempt(
      "status-lowercase",
      probUrl,
      {
        snomedcode: "",
        icd10code: safeIcd10,
        note: "verify-script: problem-2",
        status: "active",
      },
      bearer,
      "verify-script-prob-lowercase",
    ),
  );
  probResults.forEach(logAttempt);
  createdCount += probResults.filter((r) => r.ok).length;

  // ── Verdict ──
  console.log(`\n────────────────────────────────────────────────────────────`);
  console.log(`Sandbox records created (best estimate): ${createdCount}`);
  console.log(`(Each 2xx above implies a real write — clean up your sandbox.)`);
  console.log(`\nDecision matrix:`);
  console.log(
    `  Diagnosis  → use the FIRST variant above that returned 2xx + hasIdField=true`,
  );
  console.log(
    `  Procedure  → use the variant above that returned 2xx + hasIdField=true`,
  );
  console.log(
    `  Problem    → use the casing that returned 2xx + hasIdField=true`,
  );
  console.log(
    `\nIf MULTIPLE variants succeed for diagnosis or procedure, Athena is`,
  );
  console.log(
    `accepting both — the current product code (sends both diag fields) is`,
  );
  console.log(`safe; pick whichever the docs list as canonical.`);
  console.log(
    `\nIf NONE succeed for a given category, capture the 4xx headers + status`,
  );
  console.log(`above and check practice-config / scopes before flipping EHR_MODE.`);
}

main().catch((err: unknown) => {
  console.error(`Chart-write verify failed: ${safeFormatError(err)}`);
  process.exit(1);
});
