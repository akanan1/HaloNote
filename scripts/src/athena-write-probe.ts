// One-off probe: does athenahealth's FHIR R4 endpoint accept
// POST /DocumentReference at all?
//
// Run: pnpm --filter @workspace/scripts run athena-write-probe
//
// ─── Why this exists ──────────────────────────────────────────────────
// Athena's developer documentation lists only GET/_search verbs against
// /fhir/r4/DocumentReference — no documented create. The product code
// path in lib/integrations/ehr/src/document-reference/pusher.ts POSTs
// to the FHIR base anyway, so before reshaping the integration around
// /v1/{practiceid}/encounter/{encounterid}/services/note, we want
// verbatim evidence of what Athena's preview FHIR endpoint actually
// returns for a POST DocumentReference call.
//
// ─── PHI safety ───────────────────────────────────────────────────────
// This probe sends a synthetic payload with a clearly-fake patient
// reference and a literal "no PHI" attachment body. The response is
// expected to be 4xx — capturing the response status, headers (allow-
// listed), and body for diagnosis. If by some chance Athena returns
// 2xx with a created resource id, we log a loud warning and DO NOT
// repeat the request: that would create a leftover sandbox resource
// that someone has to clean up.
//
// Tokens are never logged. Bearer tokens minted here are 2-legged
// client_credentials — the only path runnable without a browser/user
// session. To probe under a 3-legged provider token, paste it into
// ATHENA_WRITE_PROBE_BEARER before running.
// ──────────────────────────────────────────────────────────────────────

import { OAuth2TokenProvider } from "@workspace/ehr";

interface ProbeResult {
  url: string;
  method: "POST";
  tokenSource: "2-legged client_credentials" | "ATHENA_WRITE_PROBE_BEARER";
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyTruncated: boolean;
  parsedOperationOutcome: { severity?: string; code?: string; diagnostics?: string }[] | null;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

// Allow-list of response headers worth logging. Avoids dumping cookies /
// trace ids / anything that could be vendor-internal.
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

async function obtainBearer(): Promise<{
  bearer: string;
  source: ProbeResult["tokenSource"];
}> {
  const override = optional("ATHENA_WRITE_PROBE_BEARER");
  if (override) {
    return { bearer: override, source: "ATHENA_WRITE_PROBE_BEARER" };
  }
  const provider = new OAuth2TokenProvider({
    tokenUrl: required("ATHENA_TOKEN_URL"),
    clientId: required("ATHENA_SANDBOX_CLIENT_ID"),
    clientSecret: required("ATHENA_SANDBOX_CLIENT_SECRET"),
    scope: required("ATHENA_SANDBOX_SCOPE"),
  });
  const bearer = await provider.getToken();
  return { bearer, source: "2-legged client_credentials" };
}

function buildSyntheticDocumentReference(): unknown {
  const noteBody =
    "This is a synthetic write probe to determine whether Athena's FHIR R4 " +
    "DocumentReference endpoint accepts POST. No PHI is present.";
  return {
    resourceType: "DocumentReference",
    status: "current",
    // LOINC "Progress note" — the safest neutral document type for a probe.
    type: {
      coding: [
        {
          system: "http://loinc.org",
          code: "11506-3",
          display: "Progress note",
        },
      ],
    },
    // Deliberately a non-resolvable, clearly-synthetic Patient reference.
    // If Athena's endpoint validates references before the operation-
    // level rejection, we still want a reference shape that makes it
    // obvious in any vendor-side log that this is a probe.
    subject: { reference: "Patient/synthetic-write-probe" },
    content: [
      {
        attachment: {
          contentType: "text/plain",
          title: "synthetic write probe — no PHI",
          // base64 of `noteBody`
          data: Buffer.from(noteBody, "utf8").toString("base64"),
        },
      },
    ],
    description: "synthetic write probe — no PHI",
  };
}

function pickAllowedHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of HEADER_ALLOW) {
    const v = res.headers.get(name);
    if (v) out[name] = v;
  }
  return out;
}

function parseOperationOutcome(
  body: string,
): ProbeResult["parsedOperationOutcome"] {
  try {
    const json = JSON.parse(body) as {
      resourceType?: string;
      issue?: { severity?: string; code?: string; diagnostics?: string }[];
    };
    if (json.resourceType !== "OperationOutcome") return null;
    return (json.issue ?? []).map((i) => ({
      severity: i.severity,
      code: i.code,
      diagnostics: i.diagnostics,
    }));
  } catch {
    return null;
  }
}

const MAX_BODY_CHARS = 8_000;

async function main(): Promise<void> {
  const fhirBase = required("ATHENA_FHIR_BASE_URL").replace(/\/+$/, "");
  const { bearer, source } = await obtainBearer();
  const url = `${fhirBase}/DocumentReference`;

  console.log(`[probe] POST ${url}`);
  console.log(`[probe] token source: ${source}`);
  console.log(`[probe] sending synthetic DocumentReference (no PHI)…`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/fhir+json",
      "content-type": "application/fhir+json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(buildSyntheticDocumentReference()),
  });

  const rawBody = await res.text();
  const truncated = rawBody.length > MAX_BODY_CHARS;
  const bodyForLog = truncated ? rawBody.slice(0, MAX_BODY_CHARS) : rawBody;

  const result: ProbeResult = {
    url,
    method: "POST",
    tokenSource: source,
    status: res.status,
    statusText: res.statusText,
    headers: pickAllowedHeaders(res),
    body: bodyForLog,
    bodyTruncated: truncated,
    parsedOperationOutcome: parseOperationOutcome(rawBody),
  };

  // Hard guard against a surprise 201 — if Athena DID create something,
  // we want a loud warning rather than burying the lead in a JSON dump.
  if (res.status >= 200 && res.status < 300) {
    console.log("");
    console.log("=== !! SURPRISE 2XX — Athena APPEARS TO HAVE ACCEPTED THE WRITE !! ===");
    console.log("This contradicts the developer docs. Do NOT repeat this request.");
    console.log("Capture the response below, share with vendor for clarification,");
    console.log("and (if a resource id is present) ask Athena to delete it.");
    console.log("");
  } else {
    console.log("");
    console.log(`=== Athena rejected the write (HTTP ${res.status}) ===`);
    console.log("");
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err: unknown) => {
  const msg =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : `non-Error thrown (typeof=${typeof err})`;
  console.error(`Write probe failed before getting a response: ${msg}`);
  process.exit(1);
});
