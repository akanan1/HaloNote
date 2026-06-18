// Cerner (Oracle Health) SMART-on-FHIR EHR-launch helpers.
//
// Scope: resident pilot launches a HaloNote SMART app from inside
// Cerner PowerChart, gets patient + encounter context preloaded, and
// drafts a note. Standalone-launch and DocumentReference write-back
// to Cerner are intentionally NOT implemented here (the resident
// flow uses HaloNote's existing Copy/Print/PDF exports for
// write-back).
//
// What this module owns:
//   - provider config (env-driven, single-tenant)
//   - allow-listing the incoming `iss` against the configured tenant
//   - patient upsert from the token-response context (so the
//     resident lands on a HaloNote-internal patient page with the
//     EHR's data already loaded)
//
// What it deliberately doesn't own:
//   - SMART configuration discovery (we use env vars per
//     single-tenant pilot deployment — discovery can be wired in as
//     a follow-up when we expand to multiple hospitals)
//   - long-lived per-user Cerner FHIR client (the existing
//     `getValidAccessToken("cerner", userId)` path covers refresh,
//     and write-back is out of scope)

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  FhirClient,
  mapFhirPatient,
  type Patient as FhirPatient,
} from "@workspace/ehr";
import { getDb, patientsTable } from "@workspace/db";

export interface CernerConfig {
  authorizeUrl: string;
  tokenUrl: string;
  fhirBaseUrl: string;
  clientId: string;
  /** Empty string means "public client" — token requests must omit
   *  Basic auth and put client_id in the form body instead. */
  clientSecret: string;
  scope: string;
  redirectUri: string;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for the Cerner SMART flow.`);
  return v;
}

export function cernerConfig(): CernerConfig {
  return {
    fhirBaseUrl: requireEnv("CERNER_FHIR_BASE_URL"),
    authorizeUrl: requireEnv("CERNER_AUTHORIZE_URL"),
    tokenUrl: requireEnv("CERNER_TOKEN_URL"),
    clientId: requireEnv("CERNER_CLIENT_ID"),
    clientSecret: process.env["CERNER_CLIENT_SECRET"] ?? "",
    // Default scope set is sane for a resident note-drafting workflow:
    // openid + fhirUser identify the launching practitioner;
    // `launch` activates EHR-launch context; user/Patient.read +
    // user/Encounter.read load context; offline_access enables
    // refresh tokens so the session survives expiry.
    scope:
      process.env["CERNER_SCOPE"] ??
      "openid fhirUser launch user/Patient.read user/Encounter.read offline_access",
    redirectUri: requireEnv("CERNER_REDIRECT_URI"),
  };
}

/** True if the operator has configured the env Cerner needs. Used by
 *  the launch endpoint to decide whether to surface a clear 503 vs
 *  letting `requireEnv` throw a generic error mid-handshake. */
export function isCernerConfigured(): boolean {
  return Boolean(
    process.env["CERNER_FHIR_BASE_URL"] &&
      process.env["CERNER_AUTHORIZE_URL"] &&
      process.env["CERNER_TOKEN_URL"] &&
      process.env["CERNER_CLIENT_ID"] &&
      process.env["CERNER_REDIRECT_URI"],
  );
}

/**
 * Validate the incoming `iss` query parameter from Cerner against the
 * tenant the operator has configured. Single-tenant pilot — exact
 * match (trailing slash tolerated). A future multi-tenant version
 * would consult an allow-list.
 */
export function isAllowedIssuer(iss: unknown): boolean {
  if (typeof iss !== "string" || iss.length === 0) return false;
  const expected = process.env["CERNER_FHIR_BASE_URL"];
  if (!expected) return false;
  const normalize = (s: string) => s.replace(/\/+$/, "");
  return normalize(iss) === normalize(expected);
}

/**
 * The launch token is an opaque string from Cerner. We never persist
 * it; it lives in-memory until we append it to the authorize URL.
 * Validation is purely shape-based — Cerner is the only authority on
 * what it means.
 */
export function isValidLaunchToken(value: unknown): boolean {
  return typeof value === "string" && value.length > 0 && value.length < 2048;
}

/**
 * One-shot Cerner FHIR Patient read using the just-minted access
 * token, mapped to HaloNote's internal Patient row.
 *
 * Why this lives here and not in patient-sync.ts: the existing sync
 * is shaped around `getAthenahealthClientForUser` (which requires a
 * persisted `ehr_connections` row). At callback time we have the
 * fresh access token in hand — there's no point reconstructing a
 * per-user client just to immediately reuse the same token. This is
 * the minimum: read, map, upsert.
 *
 * Returns the internal HaloNote patient id.
 */
export async function upsertCernerPatientFromLaunch(opts: {
  /** The tenant this launch is happening in. The upserted patient row
   *  is scoped to this org; MRN uniqueness is per-org. */
  organizationId: string;
  /** Athena/Cerner-side patient resource id (the `patient` claim from
   *  the SMART token response). */
  externalId: string;
  /** FHIR base URL from the validated iss / config. */
  fhirBaseUrl: string;
  /** Cerner-issued access token. NOT persisted by this function — the
   *  caller (`completeOauthFlow`) handles encryption + persistence. */
  accessToken: string;
}): Promise<string> {
  const fhir = new FhirClient({
    baseUrl: opts.fhirBaseUrl,
    // Static getter: this call is single-shot.
    getToken: async () => opts.accessToken,
  });

  const fhirPatient = await fhir.read<FhirPatient>("Patient", opts.externalId);
  const mapped = mapFhirPatient(fhirPatient);

  const db = getDb();
  // MRN is unique per (org, mrn); look up within the launch org only.
  const [existing] = await db
    .select({ id: patientsTable.id })
    .from(patientsTable)
    .where(
      and(
        eq(patientsTable.organizationId, opts.organizationId),
        eq(patientsTable.mrn, mapped.mrn),
      ),
    )
    .limit(1);

  if (existing) {
    // Refresh demographics in case they changed upstream. Same fields
    // the /patients/sync route updates.
    await db
      .update(patientsTable)
      .set({
        firstName: mapped.firstName,
        lastName: mapped.lastName,
        dateOfBirth: mapped.dateOfBirth,
      })
      .where(
        and(
          eq(patientsTable.id, existing.id),
          eq(patientsTable.organizationId, opts.organizationId),
        ),
      );
    return existing.id;
  }

  const id = `pt_${randomUUID()}`;
  await db.insert(patientsTable).values({
    id,
    organizationId: opts.organizationId,
    firstName: mapped.firstName,
    lastName: mapped.lastName,
    dateOfBirth: mapped.dateOfBirth,
    mrn: mapped.mrn,
  });
  return id;
}

/**
 * Build the path the callback should redirect to after a successful
 * Cerner EHR launch. Drops the resident onto NewNote for the
 * upsertted patient with the encounter id available as a query
 * param (NewNote can read it for note context; persisting it onto
 * the note row is a follow-up).
 *
 * Same-origin, leading slash — wouter routes off this; the callback's
 * `safeReturnPath` rules still apply at the route layer.
 */
export function buildLaunchReturnPath(opts: {
  internalPatientId: string;
  externalPatientId: string;
  encounterId: string | null;
}): string {
  const search = new URLSearchParams();
  search.set("ehrId", opts.externalPatientId);
  if (opts.encounterId) search.set("encounterId", opts.encounterId);
  search.set("fromLaunch", "1");
  return `/patients/${opts.internalPatientId}/notes/new?${search.toString()}`;
}
