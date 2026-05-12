import * as Sentry from "@sentry/node";
import { logger } from "./logger";

let initialized = false;

/**
 * Initialize Sentry from env. Safe to call when SENTRY_DSN is unset —
 * the function no-ops, and the rest of the codebase can call
 * `captureError()` without worrying about whether Sentry is on.
 *
 * SENTRY_DSN — the project's ingest URL.
 * SENTRY_ENVIRONMENT — overrides NODE_ENV in event tags.
 * SENTRY_TRACES_SAMPLE_RATE — defaults to 0 (no perf tracing).
 */
export function initSentry(): void {
  if (initialized) return;
  const dsn = process.env["SENTRY_DSN"]?.trim();
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment:
      process.env["SENTRY_ENVIRONMENT"]?.trim() ??
      process.env["NODE_ENV"] ??
      "development",
    tracesSampleRate: Number(
      process.env["SENTRY_TRACES_SAMPLE_RATE"] ?? "0",
    ),
    // PHI scrubbing — mirror the pino redact policy so a Sentry event
    // doesn't ship clinical text that the logs already strip. Sentry's
    // built-in PII scrubbers (sendDefaultPii: false) cover request
    // headers + IPs; this hook handles the bespoke shapes specific
    // to this codebase.
    beforeSend(event) {
      return scrubPhi(event);
    },
    beforeBreadcrumb(crumb) {
      // Breadcrumbs default to including request URLs + data; strip
      // anything that looks like a note body or patient identifier.
      if (crumb.data) {
        crumb.data = scrubObject(crumb.data) as typeof crumb.data;
      }
      return crumb;
    },
  });
  initialized = true;
  logger.info({ environment: Sentry.getClient()?.getOptions().environment }, "Sentry initialized");
}

// Field names worth scrubbing wholesale. Mirrors REDACT_PATHS in logger.ts.
const PHI_KEYS = new Set([
  "password",
  "passwordHash",
  "token",
  "tokenHash",
  "client_secret",
  "client_assertion",
  "access_token",
  "refresh_token",
  "body",
  "rawBody",
  "outcome",
  "mrn",
  "firstName",
  "lastName",
  "dateOfBirth",
  "text", // FHIR DocumentReference.content.text
  "base64",
  "description",
  "relatesTo",
]);

function scrubObject(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(scrubObject);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (PHI_KEYS.has(k)) {
      out[k] = "[redacted]";
    } else {
      out[k] = scrubObject(v);
    }
  }
  return out;
}

function scrubPhi(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  if (event.request) {
    if (event.request.data) {
      event.request.data = scrubObject(event.request.data);
    }
    if (event.request.cookies) {
      event.request.cookies = "[redacted]" as unknown as typeof event.request.cookies;
    }
    if (event.request.headers) {
      const headers = { ...event.request.headers };
      delete headers["authorization"];
      delete headers["cookie"];
      event.request.headers = headers;
    }
  }
  if (event.extra) {
    event.extra = scrubObject(event.extra) as typeof event.extra;
  }
  if (event.contexts) {
    event.contexts = scrubObject(event.contexts) as typeof event.contexts;
  }
  return event;
}

/**
 * Report an error to Sentry if configured, otherwise log it locally.
 * Use for the api-server's unhandled-error path and any catch blocks
 * where you want a backend-visible alert.
 */
export function captureError(
  err: unknown,
  context?: Record<string, unknown>,
): void {
  if (initialized) {
    Sentry.withScope((scope) => {
      if (context) {
        scope.setContext("extra", scrubObject(context) as Record<string, unknown>);
      }
      Sentry.captureException(err);
    });
  }
  // Always log too — Sentry can drop events; the audit trail is local.
  logger.error({ err, ...context }, "captureError");
}

/** Test seam — resets the init flag between Vitest specs. */
export function _resetSentryForTests(): void {
  initialized = false;
}
