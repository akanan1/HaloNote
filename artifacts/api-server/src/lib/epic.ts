import {
  createEpicClient,
  type EpicEhrClient,
} from "@workspace/ehr/epic";
import type { JwtSigningAlgorithm } from "@workspace/ehr/auth";

let cached: EpicEhrClient | undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is required for the Epic client but was not set.`,
    );
  }
  return value;
}

const SUPPORTED_ALGS: ReadonlyArray<JwtSigningAlgorithm> = [
  "RS256",
  "RS384",
  "RS512",
  "ES256",
  "ES384",
  "ES512",
];

function readAlgorithm(): JwtSigningAlgorithm {
  const raw = process.env["EPIC_ALGORITHM"]?.trim().toUpperCase();
  if (!raw) return "RS384"; // SMART backend services recommended default
  const match = SUPPORTED_ALGS.find((a) => a === raw);
  if (!match) {
    throw new Error(
      `EPIC_ALGORITHM=${raw} is not supported. Use one of: ${SUPPORTED_ALGS.join(", ")}.`,
    );
  }
  return match;
}

// PEM in an env var means embedded newlines, which most shells / .env loaders
// preserve OK but some serialize as the literal string "\n". Normalize both
// shapes so operators don't have to think about it.
function readPrivateKey(): string {
  const raw = requireEnv("EPIC_PRIVATE_KEY");
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

// Lazy singleton. Reads EPIC_* env vars on first call so the api-server can
// boot without Epic configured (only routes that hit getEpicClient fail).
export function getEpicClient(): EpicEhrClient {
  if (!cached) {
    const audience = process.env["EPIC_AUDIENCE"]?.trim();
    const scope = process.env["EPIC_SCOPE"]?.trim();
    const keyId = process.env["EPIC_KEY_ID"]?.trim();

    cached = createEpicClient({
      fhirBaseUrl: requireEnv("EPIC_FHIR_BASE_URL"),
      tokenUrl: requireEnv("EPIC_TOKEN_URL"),
      clientId: requireEnv("EPIC_CLIENT_ID"),
      algorithm: readAlgorithm(),
      privateKey: readPrivateKey(),
      ...(audience ? { audience } : {}),
      ...(scope ? { scope } : {}),
      ...(keyId ? { keyId } : {}),
    });
  }
  return cached;
}

/** Reset the cached client. For tests that flip EPIC_* env between cases. */
export function resetEpicClientCache(): void {
  cached = undefined;
}
