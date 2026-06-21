import { randomUUID } from "node:crypto";
import { EhrPushError } from "./ehr-push";
import {
  resolveEhrOrderAdapter,
  type EhrOrderPushContext,
  type EhrOrderPushOutcome,
} from "./ehr-order-adapter";
import type { Patient } from "./patients";

// Order shape the pusher needs. Kept narrow on purpose — the
// approved_orders row carries ~30 columns, most of which aren't
// needed to emit a FHIR resource. Caller maps DB row → this.
export interface PushableOrder {
  id: string;
  orderType:
    | "lab"
    | "imaging"
    | "referral"
    | "medication"
    | "procedure"
    | "followup"
    | "instruction"
    | "dme"
    | "therapy"
    | "nursing";
  name: string;
  indication: string | null;
  indicationDiagnosisCode: string | null;
  priority: "routine" | "urgent" | "stat";
  instructions: string | null;
  frequency: string | null;
  duration: string | null;
  medicationName: string | null;
  medicationDose: string | null;
  medicationRoute: string | null;
  medicationFrequency: string | null;
  medicationDuration: string | null;
  medicationQuantity: number | null;
  medicationRefills: number | null;
}

export interface PushOrderParams {
  order: PushableOrder;
  patient: Patient;
  /** Encounter the order is tied to (FHIR Encounter.id). */
  encounterEhrRef: string | null;
  /** When the author has a SMART connection, push via their per-user
   *  client so the resource carries their identity. */
  userId?: string;
  /** When true, dispatch via the dry-run adapter — payload is built
   *  but never sent upstream. Defaults to false. */
  dryRun?: boolean;
  /** Stable Idempotency-Key the caller persisted on the order row.
   *  Reused across retries so the upstream can dedupe. If absent, a
   *  fresh UUID is generated — but the caller should persist it on the
   *  row before retrying, otherwise each retry looks like a new POST
   *  to the EHR. */
  idempotencyKey?: string;
}

/** Generated server-side; persist on the order row before the first
 *  push so retries reuse it. */
export function generateOrderIdempotencyKey(): string {
  return `ord-${randomUUID()}`;
}

/**
 * Push an approved order to the EHR. Internally dispatches through an
 * EhrOrderAdapter (see ehr-order-adapter.ts) so providers are swappable
 * and dry-run is a first-class mode. External signature is unchanged from
 * the pre-adapter version so existing callers (coding-approval bulk path)
 * keep working without edits.
 *
 * Outcomes:
 *
 *   - mock (default in dev / when EHR_MODE is unset): synthetic refs,
 *     no upstream call.
 *
 *   - dry_run (params.dryRun=true): builds the FHIR-ish payload preview
 *     but does NOT dispatch. Outcome carries dryRun=true so the caller
 *     can avoid persisting status="exported".
 *
 *   - real (athenahealth / epic): NOT YET WIRED — throws 501 with a
 *     pointer to what's needed. The mock and dry-run paths exercise the
 *     full DB + audit + retry plumbing today; flipping real-mode on is
 *     a per-vendor sandbox-verification job.
 *
 * Throws EhrPushError on failure so the caller can persist the error
 * string + map to an HTTP status.
 */
export async function pushOrderToEhr(
  params: PushOrderParams,
): Promise<EhrOrderPushOutcome> {
  const adapter = resolveEhrOrderAdapter({ dryRun: params.dryRun === true });

  // Real-mode pre-check: missing encounter link surfaces the same
  // human-readable message the billing path uses. Mock + dry-run skip
  // this gate since neither actually dispatches upstream. The
  // force-fail test adapter also skips so failure-path tests can
  // exercise the failure code path independently of the link gate.
  if (
    adapter.name !== "mock" &&
    !adapter.name.endsWith("_dry_run") &&
    adapter.name !== "force_fail" &&
    !params.encounterEhrRef
  ) {
    throw new EhrPushError(
      "Encounter is not linked to the EHR and cannot be pushed yet. Link the encounter to its chart entry, then retry.",
      409,
    );
  }

  const idempotencyKey = params.idempotencyKey ?? generateOrderIdempotencyKey();
  const ctx: EhrOrderPushContext = {
    patient: params.patient,
    encounterEhrRef: params.encounterEhrRef,
    idempotencyKey,
    ...(params.userId ? { userId: params.userId } : {}),
  };

  return await adapter.push(params.order, ctx);
}
