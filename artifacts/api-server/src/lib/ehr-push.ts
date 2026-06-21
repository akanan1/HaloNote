import { FhirError } from "@workspace/ehr";
import { getAthenahealthClient } from "./athena";
import { getEpicClient } from "./epic";
import { getAthenahealthClientForUser } from "./ehr-user-client";
import { logger } from "./logger";
import type { Patient } from "./patients";

export interface EhrPushParams {
  note: { id: string; body: string };
  patient: Patient;
  /**
   * When set, the new DocumentReference carries
   * relatesTo[{ code: "replaces", target: { reference: <ref> }}].
   * Use the predecessor note's persisted ehrDocumentRef as the target.
   */
  replacesEhrRef?: string;
  /**
   * Author of the note. When the user has a SMART OAuth connection to
   * the EHR, we push the DocumentReference through their per-user
   * client so the resource carries their identity. Falls back to the
   * org-level client_credentials (EHR_MODE) when there's no connection.
   */
  userId?: string;
  /**
   * Stable Idempotency-Key for this note's push. The caller persists
   * the key on the note row before the push so any retry — automatic
   * (transport-level on 429/503) or manual (user clicks "send again"
   * after a timeout) — reuses the same value. The EHR server is
   * expected to dedupe duplicate POSTs sharing a key.
   */
  idempotencyKey: string;
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
// Otherwise mock — keeps dev safe from stale credentials + accidental
// PHI leaks into vendor sandboxes.
//
// Unknown non-empty values throw at boot rather than silently mocking,
// so a typo like EHR_MODE=athena (missing "health") fails loudly in any
// env instead of pretending to push notes upstream while really discarding
// them. Empty/unset is treated as explicit opt-out.
const VALID_EHR_MODES = ["athenahealth", "epic", "mock"] as const;
type EhrProvider = (typeof VALID_EHR_MODES)[number];

function resolveProvider(): EhrProvider {
  const raw = process.env["EHR_MODE"]?.trim().toLowerCase();
  if (!raw) return "mock";
  if ((VALID_EHR_MODES as readonly string[]).includes(raw)) {
    return raw as EhrProvider;
  }
  throw new Error(
    `Invalid EHR_MODE=${JSON.stringify(process.env["EHR_MODE"])}. ` +
      `Expected one of: ${VALID_EHR_MODES.join(", ")}, or unset for mock.`,
  );
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
    ...(params.replacesEhrRef
      ? {
          relatesTo: [{ code: "replaces" as const, target: params.replacesEhrRef }],
        }
      : {}),
  };

  // Prefer the user's SMART connection if they've completed OAuth.
  if (params.userId) {
    const userClient = await getAthenahealthClientForUser(params.userId);
    if (userClient) {
      try {
        const created = await userClient.documentReference.push(baseInput, {
          idempotencyKey: params.idempotencyKey,
        });
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
  }

  const provider = resolveProvider();

  if (provider === "mock") {
    const syntheticId = `mock-${params.note.id}`;
    // Log structural facts only — no note body, no patient name. The
    // logger redacts `content.text` / `description` defensively too,
    // but it's cheaper to just not pass them in.
    logger.info(
      {
        noteId: params.note.id,
        bodyLength: params.note.body.length,
        patientRef: baseInput.patient,
        replaces: params.replacesEhrRef ?? null,
        syntheticId,
      },
      "EHR push (mock) — EHR_MODE not set to a real provider; not posting upstream",
    );
    return {
      provider: "mock",
      ehrDocumentRef: `DocumentReference/${syntheticId}`,
      pushedAt: new Date(),
      mock: true,
    };
  }

  try {
    const client =
      provider === "athenahealth"
        ? getAthenahealthClient()
        : getEpicClient();
    const created = await client.documentReference.push(baseInput, {
      idempotencyKey: params.idempotencyKey,
    });
    const id = created.id ?? "unknown";
    return {
      provider,
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
