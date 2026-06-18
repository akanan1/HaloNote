import { FhirClient } from "@workspace/ehr";
import { DocumentReferencePusher } from "@workspace/ehr/document-reference";
import { getConnection, getValidAccessToken } from "./ehr-oauth";

export interface UserEhrClient {
  fhir: FhirClient;
  documentReference: DocumentReferencePusher;
  practitionerId: string | null;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for the EHR client.`);
  return v;
}

/**
 * Build a FhirClient scoped to a specific provider's SMART OAuth
 * connection. The token getter resolves the user's row each call and
 * refreshes via the refresh_token grant when the access token is
 * within the skew window — see `getValidAccessToken`.
 *
 * Returns null when the user hasn't connected the given provider, so
 * callers can fall back to mock mode without throwing.
 */
export async function getAthenahealthClientForUser(
  userId: string,
): Promise<UserEhrClient | null> {
  const conn = await getConnection(userId, "athenahealth");
  if (!conn) return null;

  const fhir = new FhirClient({
    baseUrl: requireEnv("ATHENA_FHIR_BASE_URL"),
    getToken: () => getValidAccessToken(userId, "athenahealth"),
  });
  return {
    fhir,
    documentReference: new DocumentReferencePusher(fhir),
    practitionerId: conn.practitionerId,
  };
}

// Mirrors the Athena helper above so callers can request per-user
// Cerner FHIR access the same way they do Athena. Cerner-launched
// residents must hit this path — falling back to the env-driven
// global Athena/Epic client would surface another tenant's chart
// data, which is the kind of bug we don't get to ship.
export async function getCernerClientForUser(
  userId: string,
): Promise<UserEhrClient | null> {
  const conn = await getConnection(userId, "cerner");
  if (!conn) return null;

  const fhir = new FhirClient({
    baseUrl: requireEnv("CERNER_FHIR_BASE_URL"),
    getToken: () => getValidAccessToken(userId, "cerner"),
  });
  return {
    fhir,
    documentReference: new DocumentReferencePusher(fhir),
    practitionerId: conn.practitionerId,
  };
}
