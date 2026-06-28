import {
  createAthenahealthClient,
  type AthenahealthEhrClient,
} from "@workspace/ehr/athenahealth";
import { OAuth2TokenProvider } from "@workspace/ehr/auth";

let cached: AthenahealthEhrClient | undefined;
let cachedTokenProvider: OAuth2TokenProvider | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required for the athenahealth client but was not set.`,
    );
  }
  return value;
}

// Lazy singleton. Reads ATHENA_* env vars on first call so the api-server
// can boot without athenahealth configured (only routes that touch it fail).
export function getAthenahealthClient(): AthenahealthEhrClient {
  if (!cached) {
    cached = createAthenahealthClient({
      fhirBaseUrl: requireEnv("ATHENA_FHIR_BASE_URL"),
      tokenUrl: requireEnv("ATHENA_TOKEN_URL"),
      clientId: requireEnv("ATHENA_CLIENT_ID"),
      clientSecret: requireEnv("ATHENA_CLIENT_SECRET"),
      scope: process.env.ATHENA_SCOPE,
    });
  }
  return cached;
}

/**
 * Single Athena token cache + provider, shared by every code path in
 * the api-server that needs a 2-legged client_credentials access token
 * (the FHIR client, the chart-API client, future ad-hoc fetches). Uses
 * the library's OAuth2TokenProvider so the RFC 6749 §2.3.1 Basic-auth
 * form-encoding lands correctly even when the secret contains `+`, `/`,
 * `=`, or space — the bug that bit the prior hand-rolled chart-api
 * token mint.
 *
 * Why a separate provider from the FhirClient's internal one: the
 * AthenahealthEhrClient constructor wraps its provider inside the FHIR
 * pipeline; we can't reach into it without reaching across a published
 * package boundary. Building one more module-scoped provider with the
 * same config + cache semantics gives us one observable cache from the
 * application's POV — both reads coalesce on the same `CachedTokenProvider`
 * single-flight under concurrent callers — without forking the library.
 */
export function getAthenahealthTokenProvider(): OAuth2TokenProvider {
  if (!cachedTokenProvider) {
    cachedTokenProvider = new OAuth2TokenProvider({
      tokenUrl: requireEnv("ATHENA_TOKEN_URL"),
      clientId: requireEnv("ATHENA_CLIENT_ID"),
      clientSecret: requireEnv("ATHENA_CLIENT_SECRET"),
      ...(process.env.ATHENA_SCOPE
        ? { scope: process.env.ATHENA_SCOPE }
        : {}),
    });
  }
  return cachedTokenProvider;
}

/**
 * Convenience: resolve a current access token through the shared
 * provider. Honors the provider's cache + 90s skew window (defined in
 * the library's CachedTokenProvider), so back-to-back callers don't
 * each mint a fresh bearer. Throws on token-mint failure (4xx/5xx);
 * caller decides whether to surface to a 502 or retry.
 */
export async function getAthenahealthAccessToken(): Promise<string> {
  return getAthenahealthTokenProvider().getToken();
}

/** Test seam: drop the cached client + provider so a re-import picks up new env. */
export function _resetAthenahealthClientForTests(): void {
  cached = undefined;
  cachedTokenProvider = undefined;
}
