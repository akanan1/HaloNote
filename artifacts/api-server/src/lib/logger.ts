import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

/**
 * Paths fast-redact will scrub before pino serializes a log object.
 * Two categories:
 *
 *   1. Credentials — Authorization, cookies, OAuth secrets, JWT
 *      assertions, hashed passwords. Never want these in logs.
 *   2. PHI carriers — request bodies, FHIR DocumentReference content,
 *      OperationOutcome diagnostics, raw upstream error bodies. A
 *      note's clinical text or a patient name showing up in a log
 *      drop is the kind of leak HIPAA audits flag.
 *
 * Keep this list defensive. Adding an over-redacted path costs a "[redacted]"
 * placeholder in dev logs; under-redacting costs an incident.
 *
 * Path syntax is fast-redact's: dotted paths, single-level `*`
 * wildcards, and `[]` indexing.
 */
const REDACT_PATHS: ReadonlyArray<string> = [
  // ----- credentials -----
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers['set-cookie']",
  "*.password",
  "*.passwordHash",
  "password",
  "passwordHash",
  "*.token",
  "*.tokenHash",
  "token",
  "tokenHash",
  "*.client_secret",
  "*.client_assertion",
  "*.access_token",
  "*.refresh_token",
  // Token-at-rest crypto material (defense in depth — current code paths
  // don't log these, but a future regression that dumps an encryption
  // context object would be caught by the redactor).
  "*.iv",
  "iv",
  "*.ciphertext",
  "ciphertext",
  "*.authTag",
  "authTag",
  "EHR_TOKEN_ENC_KEY",

  // ----- request / response bodies (never log them) -----
  "req.body",
  "req.body.*",
  "body",
  "body.*",

  // ----- FHIR DocumentReference payload + amendment chain -----
  // baseInput in ehr-push.ts has `content.text` (raw note body) and a
  // `description` field that includes patient first + last name.
  "docRef.content.text",
  "docRef.content.base64",
  "docRef.description",
  "content.text",
  "content.base64",
  "description",
  "*.relatesTo",

  // ----- upstream error bodies that quote PHI back at us -----
  // FhirError.rawBody is whatever the EHR returned — often a JSON
  // OperationOutcome with patient identifiers in diagnostics.
  "*.rawBody",
  "rawBody",
  "*.outcome",
  "outcome",

  // ----- patient / note fields that occasionally end up in {err} -----
  "*.mrn",
  "mrn",
  "*.firstName",
  "*.lastName",
  "*.dateOfBirth",
];

export const logger = pino({
  level: process.env["LOG_LEVEL"] ?? "info",
  redact: {
    paths: [...REDACT_PATHS],
    censor: "[redacted]",
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});

// Exported only so the unit test can assert the same redaction policy
// applies without instantiating two pino instances.
export const _REDACT_PATHS_FOR_TESTS = REDACT_PATHS;
