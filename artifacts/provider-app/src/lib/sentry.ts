import * as Sentry from "@sentry/react";

let initialized = false;

/**
 * Initialize Sentry from Vite-injected env. Safe no-op when
 * VITE_SENTRY_DSN is unset — UI just runs without telemetry.
 *
 * Mirrors the api-server PHI scrubbing policy so neither half of
 * the stack ships clinical text to Sentry.
 */
export function initSentry(): void {
  if (initialized) return;
  const dsn = import.meta.env["VITE_SENTRY_DSN"];
  if (!dsn || typeof dsn !== "string" || dsn.trim().length === 0) return;

  Sentry.init({
    dsn,
    environment:
      (import.meta.env["VITE_SENTRY_ENVIRONMENT"] as string | undefined) ??
      import.meta.env["MODE"],
    tracesSampleRate: Number(
      import.meta.env["VITE_SENTRY_TRACES_SAMPLE_RATE"] ?? "0",
    ),
    beforeSend(event) {
      return scrubPhi(event);
    },
    beforeBreadcrumb(crumb) {
      if (crumb.data) {
        crumb.data = scrubObject(crumb.data) as typeof crumb.data;
      }
      return crumb;
    },
  });
  initialized = true;
}

const PHI_KEYS = new Set([
  "password",
  "passwordHash",
  "token",
  "tokenHash",
  "body",
  "rawBody",
  "outcome",
  "mrn",
  "firstName",
  "lastName",
  "dateOfBirth",
  "text",
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
  if (event.request?.data) {
    event.request.data = scrubObject(event.request.data);
  }
  if (event.extra) {
    event.extra = scrubObject(event.extra) as typeof event.extra;
  }
  if (event.contexts) {
    event.contexts = scrubObject(event.contexts) as typeof event.contexts;
  }
  return event;
}

/** Report an error explicitly (e.g., from a caught exception). */
export function captureError(err: unknown, context?: Record<string, unknown>): void {
  if (!initialized) return;
  Sentry.withScope((scope) => {
    if (context) {
      scope.setContext("extra", scrubObject(context) as Record<string, unknown>);
    }
    Sentry.captureException(err);
  });
}
