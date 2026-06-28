// Athena chart-API writeback adapter (Phase 3).
//
// Background
// ----------
// Athena's FHIR R4 surface is READ-ONLY for clinical data — we use it
// for problem-list / patient pulls, but anything that mutates the chart
// goes through Athena's proprietary REST endpoints at:
//
//   https://api.platform.athenahealth.com/v1/{practiceId}/...
//
// The relevant write endpoints we exercise here:
//
//   POST /v1/{practiceId}/chart/encounter/{encounterId}/diagnoses
//        — add an ICD-10 diagnosis to an encounter
//   POST /v1/{practiceId}/chart/encounter/{encounterId}/services
//        — add a procedure / CPT charge line
//   POST /v1/{practiceId}/chart/{patientId}/problems
//        — add to the patient's problem list (and PUT to update)
//
// ⚠️ READ THIS BEFORE FLIPPING EHR_MODE=athenahealth ⚠️
// -----------------------------------------------------
// I have not run these endpoints against a live Athena sandbox.
// The HTTP path shapes are taken from Athena's published REST API
// reference; the exact parameter names ("icd10code", "departmentid",
// etc.) and required fields VARY BY PRACTICE TYPE and have changed
// across Athena API versions. Before enabling real-mode writeback:
//
//   1. Hit each endpoint against your preview/sandbox practice with
//      a deliberate test diagnosis (e.g. Z00.00) and confirm the
//      response shape matches `AthenaWriteOutcome`.
//   2. If parameter names differ in your practice's API surface, fix
//      the request bodies below — the rest of the call site doesn't
//      need to change.
//   3. Watch the api-server logs for "athena chart api: real call"
//      to confirm the mock fallback isn't silently swallowing.
//
// The shape of this module is verified — the URL builder, retry
// posture, idempotency-key handling, and error→EhrPushError mapping
// all mirror the patterns used elsewhere in the codebase. The wire
// parameters need your eyes.

import { getAthenahealthAccessToken } from "./athena";
import { scrubEhrErrorMessage } from "./audit-events";
import { EhrPushError } from "./ehr-push";
import { fetchWithRetry } from "./http-retry";
import { logger } from "./logger";

// Token endpoint contract is the same as the FHIR client — Athena's
// OAuth gateway issues bearer tokens valid for both surfaces. Reuse
// the existing client_credentials grant from athena.ts via a token
// callback so the OAuth dance stays in one place.
export interface AthenaChartClientConfig {
  baseUrl: string;
  practiceId: string;
  /** Resolves a fresh access token (handles refresh internally). */
  getToken: () => Promise<string>;
}

export interface AthenaWriteOutcome {
  /** Athena's identifier for the newly-created or updated record. */
  athenaId: string;
  /** A FHIR-style reference for parity with FHIR-write outcomes elsewhere. */
  resourceRef: string;
  /** Verbatim Athena response payload (useful for the audit log). */
  raw: unknown;
}

export interface PushDiagnosisInput {
  encounterId: string;
  icd10: string;
  description: string;
  /** Reason this dx is being added; surfaces in Athena's audit. */
  note?: string;
  /** Idempotency key — same key on retry must not double-write. */
  idempotencyKey: string;
}

export interface PushProcedureInput {
  encounterId: string;
  cpt: string;
  description: string;
  /** Optional ICD-10 link if Athena's practice requires diagnosis pointer. */
  diagnosisIcd10?: string;
  idempotencyKey: string;
}

export interface PushProblemInput {
  patientId: string;
  icd10: string;
  description: string;
  status: "active" | "resolved";
  onsetDate?: string | null;
  idempotencyKey: string;
}

export class AthenaChartClient {
  constructor(private cfg: AthenaChartClientConfig) {}

  private url(path: string): string {
    const base = this.cfg.baseUrl.replace(/\/+$/, "");
    return `${base}/v1/${this.cfg.practiceId}${path.startsWith("/") ? path : `/${path}`}`;
  }

  // Internal POST. Retries 429/502/503/504 + network errors via the
  // shared fetchWithRetry (exponential backoff + jitter, Retry-After
  // aware, max 3 attempts). Anything else → throw an EhrPushError so
  // the calling adapter can persist the message. Idempotency-key on
  // every attempt means a server-side dedupe is safe even if our retry
  // hits a write that the previous attempt actually committed.
  private async post(
    path: string,
    body: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<unknown> {
    const url = this.url(path);
    const token = await this.cfg.getToken();
    const exec = async (): Promise<Response> => {
      return fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/x-www-form-urlencoded",
          // Athena dedupes within its retention window on this header.
          // Same key on automatic + manual retry → same outcome.
          "idempotency-key": idempotencyKey,
        },
        // Athena's REST endpoints take form-encoded bodies, not JSON.
        // (The FHIR endpoints take JSON; this one differs.)
        body: new URLSearchParams(
          Object.entries(body).reduce<Record<string, string>>(
            (acc, [k, v]) => {
              if (v === undefined || v === null) return acc;
              acc[k] = String(v);
              return acc;
            },
            {},
          ),
        ),
      });
    };

    const res = await fetchWithRetry(exec, {
      onRetry: ({ attempt, delayMs, status }) => {
        logger.warn(
          { url, attempt, delayMs, status },
          "athena chart api: retrying transient failure",
        );
      },
    });

    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // Some Athena error pages are HTML — keep the body as text.
    }

    if (!res.ok) {
      // PHI-safety: Athena REST errors sometimes echo patient names
      // ("Patient JOHN SMITH not found"). Logger redacts on output but
      // the EhrPushError message gets persisted to approved_billing_codes.ehr_error
      // verbatim — surfacing PHI in a column we read into the UI is a
      // HIPAA violation, so scrub before throwing.
      logger.warn(
        { url, status: res.status, body: parsed },
        "athena chart api: non-2xx response",
      );
      const bodyStr =
        typeof parsed === "string" ? parsed : JSON.stringify(parsed);
      throw new EhrPushError(
        `athena_chart_${res.status}: ${scrubEhrErrorMessage(bodyStr)}`,
        res.status === 401 || res.status === 403 ? 502 : 502,
      );
    }
    return parsed;
  }

  /**
   * Add an ICD-10 diagnosis to an encounter. SANDBOX-VERIFY parameter
   * names before flipping EHR_MODE — see file header.
   */
  async pushDiagnosis(input: PushDiagnosisInput): Promise<AthenaWriteOutcome> {
    logger.info(
      {
        encounterId: input.encounterId,
        icd10: input.icd10,
      },
      "athena chart api: real call — pushDiagnosis",
    );
    const raw = await this.post(
      `/chart/encounter/${encodeURIComponent(input.encounterId)}/diagnoses`,
      {
        // PARAM NAMES TO VERIFY: Athena's docs reference both `icd10code`
        // and `diagnosiscode` across versions. Setting both is harmless
        // if one is ignored; setting the wrong one causes a 400.
        icd10code: input.icd10,
        diagnosisdescription: input.description,
        ...(input.note ? { note: input.note } : {}),
      },
      input.idempotencyKey,
    );

    // Athena typically returns `[{ encounterdiagnosisid: "12345" }]`
    // — accept both array + object shapes since the practice config
    // can affect which surface is returned.
    const id = extractFirstId(raw, [
      "encounterdiagnosisid",
      "diagnosisid",
      "id",
    ]);
    if (!id) {
      throw new EhrPushError(
        "athena_chart_diagnosis_unknown_response_shape",
        502,
      );
    }
    return {
      athenaId: id,
      resourceRef: `EncounterDiagnosis/${id}`,
      raw,
    };
  }

  /** Add a procedure / CPT charge line. SANDBOX-VERIFY param names. */
  async pushProcedure(input: PushProcedureInput): Promise<AthenaWriteOutcome> {
    logger.info(
      {
        encounterId: input.encounterId,
        cpt: input.cpt,
      },
      "athena chart api: real call — pushProcedure",
    );
    const raw = await this.post(
      `/chart/encounter/${encodeURIComponent(input.encounterId)}/services`,
      {
        // PARAM NAMES TO VERIFY: `procedurecode` is the documented
        // field but some Athena practice setups expect `cpt`.
        procedurecode: input.cpt,
        proceduredescription: input.description,
        ...(input.diagnosisIcd10
          ? { diagnosiscode: input.diagnosisIcd10 }
          : {}),
      },
      input.idempotencyKey,
    );
    const id = extractFirstId(raw, ["chargeid", "serviceid", "id"]);
    if (!id) {
      throw new EhrPushError(
        "athena_chart_procedure_unknown_response_shape",
        502,
      );
    }
    return {
      athenaId: id,
      resourceRef: `Charge/${id}`,
      raw,
    };
  }

  /** Add a problem to the patient's problem list. SANDBOX-VERIFY. */
  async pushProblem(input: PushProblemInput): Promise<AthenaWriteOutcome> {
    logger.info(
      {
        patientId: input.patientId,
        icd10: input.icd10,
        status: input.status,
      },
      "athena chart api: real call — pushProblem",
    );
    const raw = await this.post(
      `/chart/${encodeURIComponent(input.patientId)}/problems`,
      {
        snomedcode: "",
        icd10code: input.icd10,
        // The note field is what shows in the chart's problem-list UI.
        note: input.description,
        status: input.status === "resolved" ? "RESOLVED" : "ACTIVE",
        ...(input.onsetDate ? { startdate: input.onsetDate } : {}),
      },
      input.idempotencyKey,
    );
    const id = extractFirstId(raw, ["problemid", "id"]);
    if (!id) {
      throw new EhrPushError(
        "athena_chart_problem_unknown_response_shape",
        502,
      );
    }
    return {
      athenaId: id,
      resourceRef: `Problem/${id}`,
      raw,
    };
  }
}

// Helper: walk a JSON response (array-of-object or bare object) and
// return the first matching id field. Athena's responses are wildly
// inconsistent across endpoints, so the matrix of acceptable keys is
// per-endpoint.
function extractFirstId(
  raw: unknown,
  keys: string[],
): string | null {
  const pick = (obj: unknown): string | null => {
    if (!obj || typeof obj !== "object") return null;
    const o = obj as Record<string, unknown>;
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "string" && v.length > 0) return v;
      if (typeof v === "number") return String(v);
    }
    return null;
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const got = pick(item);
      if (got) return got;
    }
    return null;
  }
  return pick(raw);
}

// ---------------------------------------------------------------------------
// Lazy singleton. Reads ATHENA_CHART_BASE_URL + ATHENA_PRACTICE_ID; the
// token endpoint, client id/secret, and scope are owned by
// lib/athena.ts — the chart client now defers to the shared OAuth
// provider there so we have one Athena token cache + one RFC-6749-
// compliant Basic-auth encoding across the api-server. Provider must
// set the chart-specific env vars in real mode; the adapter throws on
// first call when they're missing.
//
// History: this file used to keep its own cachedToken + its own
// fetchClientCredentialsToken that joined `${clientId}:${clientSecret}`
// without percent-encoding the halves first — a +, /, =, or space in
// the secret produced a malformed header and a silent 401 from
// Athena's IdP. The fix lives in @workspace/ehr's OAuth2TokenProvider
// via buildBasicAuthCredential.
// ---------------------------------------------------------------------------

let cachedClient: AthenaChartClient | null = null;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `${name} is required for the Athena chart-API client in real mode.`,
    );
  }
  return v;
}

export function getAthenaChartClient(): AthenaChartClient {
  if (!cachedClient) {
    // The Athena chart REST API is at a different base URL than the
    // FHIR surface — explicit var so dev/sandbox/prod can be set
    // independently of the FHIR base URL.
    const baseUrl =
      process.env["ATHENA_CHART_BASE_URL"] ??
      // Sensible default per Athena's docs; override if your sandbox
      // lives under a different host.
      "https://api.preview.platform.athenahealth.com";
    const practiceId =
      process.env["ATHENA_SANDBOX_PRACTICE_ID"] ??
      requireEnv("ATHENA_PRACTICE_ID");
    cachedClient = new AthenaChartClient({
      baseUrl,
      practiceId,
      getToken: getAthenahealthAccessToken,
    });
  }
  return cachedClient;
}

/** Test seam: drop the chart client cache so a re-import picks up new env. */
export function _resetAthenaChartClientForTests(): void {
  cachedClient = null;
}
