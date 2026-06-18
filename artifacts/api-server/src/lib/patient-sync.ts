import { FhirError, mapFhirPatient, type Patient as FhirPatient } from "@workspace/ehr";
import { getAthenahealthClient } from "./athena";
import { getEpicClient } from "./epic";
import { getAthenahealthClientForUser } from "./ehr-user-client";
import { logger } from "./logger";

export interface SyncedPatientFields {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  mrn: string;
  /** The EHR-side Patient.id the caller passed in. Persisted on the
   *  local row so downstream features (Phase 33 chart-note fetch,
   *  the existing chart-context panel) can address the patient in
   *  the EHR without re-deriving the id from FHIR Bundle entries. */
  ehrPatientId: string;
  provider: "athenahealth" | "epic" | "mock";
}

export class PatientSyncError extends Error {
  override readonly name = "PatientSyncError";
  readonly status: number;
  readonly upstream: unknown;

  constructor(message: string, status: number, upstream?: unknown) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.status = status;
    this.upstream = upstream;
  }
}

function resolveProvider(): "athenahealth" | "epic" | "mock" {
  const mode = process.env["EHR_MODE"]?.trim().toLowerCase();
  if (mode === "athenahealth") return "athenahealth";
  if (mode === "epic") return "epic";
  return "mock";
}

/**
 * Read a Patient by external id from the configured EHR and reduce it
 * to the four fields HaloNote stores. EHR_MODE picks the upstream:
 *
 *   - "athenahealth" → real Athena FHIR read
 *   - "epic"         → real Epic FHIR read
 *   - unset / mock   → synthesize a deterministic patient from the id
 *
 * Mock mode keeps the upsert path testable without an EHR sandbox.
 */
export async function syncPatientFromEhr(
  externalId: string,
  userId?: string,
): Promise<SyncedPatientFields> {
  // If the caller has connected Athena via SMART OAuth, prefer their
  // per-user client — that's the production-shaped read path. The
  // EHR_MODE fallback is only used when no OAuth connection exists,
  // so dev and shared sandboxes still work.
  if (userId) {
    const userClient = await getAthenahealthClientForUser(userId);
    if (userClient) {
      try {
        const fhirPatient = await userClient.fhir.read<FhirPatient>(
          "Patient",
          externalId,
        );
        const mapped = mapFhirPatient(fhirPatient);
        return { ...mapped, ehrPatientId: externalId, provider: "athenahealth" };
      } catch (err) {
        if (err instanceof FhirError) {
          const status = err.status === 404 ? 404 : 502;
          throw new PatientSyncError(err.message, status, err);
        }
        throw err;
      }
    }
  }

  const provider = resolveProvider();

  if (provider === "mock") {
    logger.info({ externalId }, "patient sync (mock)");
    return {
      firstName: "Demo",
      lastName: `Patient-${externalId.slice(0, 6)}`,
      dateOfBirth: "1980-01-01",
      mrn: `MRN-${externalId}`,
      ehrPatientId: externalId,
      provider: "mock",
    };
  }

  try {
    const client =
      provider === "athenahealth" ? getAthenahealthClient() : getEpicClient();
    const fhirPatient = await client.fhir.read<FhirPatient>(
      "Patient",
      externalId,
    );
    const mapped = mapFhirPatient(fhirPatient);
    return { ...mapped, ehrPatientId: externalId, provider };
  } catch (err) {
    if (err instanceof FhirError) {
      // 404 on the EHR side → 404 to the caller; everything else is a 502.
      const status = err.status === 404 ? 404 : 502;
      throw new PatientSyncError(err.message, status, err);
    }
    throw err;
  }
}
