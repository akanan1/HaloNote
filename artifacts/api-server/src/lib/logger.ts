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
  // TOTP codes are short-lived (30s) but still credentials in flight —
  // and the disable / reset flows accept them in the request body, so
  // any debug log that includes the parsed body would otherwise leak.
  "*.totpCode",
  "totpCode",
  "*.totpSecret",
  "totpSecret",
  "*.client_secret",
  "*.client_assertion",
  "*.access_token",
  "*.refresh_token",
  // CamelCase variants of the same fields. The snake_case shapes come
  // from raw OAuth wire payloads; the camelCase shapes come from our
  // internal AccessToken / connection-row objects (e.g. ehr_connections
  // mapped through Drizzle, OauthExchangeError debug payloads, and
  // anything that builds a credentials object before serializing). A
  // regression that logs `{ conn }` or `{ providerConfig }` without
  // these rules would leak token material into operator-tier logs.
  "*.accessToken",
  "accessToken",
  "*.refreshToken",
  "refreshToken",
  "*.clientSecret",
  "clientSecret",
  "client_secret",
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

  // ----- additional HIPAA direct identifiers (45 CFR 164.514) -----
  // Email is a HIPAA direct identifier when paired with health
  // information — log a userId for operational signal instead.
  "*.email",
  "email",
  "*.phone",
  "phone",
  "*.phoneNumber",
  "phoneNumber",
  "*.ssn",
  "ssn",

  // ----- additional FHIR Patient PHI shapes -----
  // Existing rules cover Halo's internal patient shape
  // (firstName / lastName / dateOfBirth / mrn). FHIR responses from
  // Athena / Epic use HumanName (given / family), Patient.birthDate,
  // and Patient.identifier[*] — so a stray `{ patient }` log of a
  // parsed FHIR resource would otherwise leak.
  "*.birthDate",
  "birthDate",
  "*.given",
  "given",
  "*.family",
  "family",
  "*.identifier",
  "identifier",
  // FHIR HumanName lives at patient.name[i].given / .family — the
  // simpler `*.given` rule above only catches one level of nesting.
  // Add explicit array-aware paths so a parsed FHIR Patient logged
  // as `{ patient }` has its names redacted too.
  "*.name.*.given",
  "name.*.given",
  "*.name.*.family",
  "name.*.family",

  // ----- additional OAuth state-machine secrets -----
  // code_verifier is the PKCE pre-image; logging it alongside a
  // leaked `code` from a callback would let an attacker complete the
  // token exchange. id_token + assertion are JWTs carrying identity
  // and signing material that must never leave the process.
  "*.code_verifier",
  "code_verifier",
  "*.id_token",
  "id_token",
  "*.assertion",
  "assertion",

  // ----- additional clinical content channels -----
  // The Deepgram → Anthropic pipeline carries the raw transcript and
  // structured SOAP shapes through several intermediate objects.
  // Catch the common field names so a debug log of any pipeline
  // intermediate doesn't drop a full encounter into the log stream.
  "*.transcript",
  "transcript",
  "*.noteBody",
  "noteBody",
  "*.noteText",
  "noteText",
  "*.soap",
  "soap",
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
