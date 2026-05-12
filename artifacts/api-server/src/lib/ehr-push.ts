import { FhirError } from "@workspace/ehr";
import { getAthenahealthClient } from "./athena";
import { logger } from "./logger";
import type { Patient } from "./patients";

export interface EhrPushParams {
  note: { id: string; body: string };
  patient: Patient;
}

export interface EhrPushOutcome {
  provider: "athenahealth" | "epic" | "mock";
  ehrDocumentRef: string;
  pushedAt: Date;
  mock: boolean;
}

export class EhrPushError extends Error {
  override readonly name = "EhrPushError";
  readonly status: number;
  readonly upstream: unknown;

  constructor(message: string, status: number, upstream?: unknown) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.status = status;
    this.upstream = upstream;
  }
}

// Opt-in: only hit a real EHR when EHR_MODE is set to a provider name.
// Otherwise mock — keeps dev safe from stale Replit creds + accidental
// PHI leaks into vendor sandboxes.
function resolveProvider(): "athenahealth" | "epic" | "mock" {
  const mode = process.env["EHR_MODE"]?.trim().toLowerCase();
  if (mode === "athenahealth") return "athenahealth";
  if (mode === "epic") return "epic";
  return "mock";
}

export async function pushNoteToEhr(
  params: EhrPushParams,
): Promise<EhrPushOutcome> {
  const baseInput = {
    patient: `Patient/${params.patient.id}`,
    content: {
      text: params.note.body,
      contentType: "text/plain",
      title: `Clinical note ${params.note.id}`,
    },
    description: `${params.patient.lastName}, ${params.patient.firstName} — note ${params.note.id}`,
  };

  const provider = resolveProvider();

  if (provider === "mock") {
    const syntheticId = `mock-${params.note.id}`;
    logger.info(
      { docRef: baseInput, syntheticId },
      "EHR push (mock) — EHR_MODE not set to a real provider; not posting upstream",
    );
    return {
      provider: "mock",
      ehrDocumentRef: `DocumentReference/${syntheticId}`,
      pushedAt: new Date(),
      mock: true,
    };
  }

  if (provider === "epic") {
    // Epic SMART-backend-services client isn't wired in the api-server yet;
    // surface explicitly rather than silently misrouting.
    throw new EhrPushError(
      "EHR_MODE=epic is not yet implemented in the api-server.",
      501,
    );
  }

  try {
    const client = getAthenahealthClient();
    const created = await client.documentReference.push(baseInput);
    const id = created.id ?? "unknown";
    return {
      provider: "athenahealth",
      ehrDocumentRef: `DocumentReference/${id}`,
      pushedAt: new Date(),
      mock: false,
    };
  } catch (err) {
    if (err instanceof FhirError) {
      throw new EhrPushError(err.message, 502, err);
    }
    throw err;
  }
}
