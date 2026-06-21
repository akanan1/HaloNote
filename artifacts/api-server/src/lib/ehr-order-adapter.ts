// EHR order push adapter — the swappable boundary between the
// pushApprovedOrder service (orchestration: gates, idempotency, audit)
// and the wire format for whichever EHR is configured.
//
// Adding a new EHR provider = implement EhrOrderAdapter + wire it into
// resolveEhrOrderAdapter(). The service layer is untouched.
//
// Three production-time adapters today:
//
//   MockEhrOrderAdapter        — returns synthetic FHIR-shape refs.
//                                Default in dev + tests; never reaches
//                                the network.
//   DryRunEhrOrderAdapter      — builds the FHIR-ish payload preview
//                                that *would* have been sent, returns
//                                without dispatching. Lets a clinician
//                                inspect what's about to leave the
//                                building before flipping real-mode on.
//   AthenahealthOrderAdapter   — real Athena chart-API. NOT YET WIRED;
//                                throws 501 with a pointer to what's
//                                needed. Per-order-type endpoints
//                                (/medications, /labs, /imaging,
//                                /referrals) differ enough that
//                                shipping without sandbox verification
//                                would be a patient-safety call.
//   EpicOrderAdapter           — same shape; same TODO.
//
// Test-only "force-fail" adapter (controlled by the EHR_ORDER_PUSH_FORCE
// env, see resolveEhrOrderAdapter) lets integration tests exercise the
// failure + retry paths without standing up a real upstream.

import { EhrPushError } from "./ehr-push";
import { logger } from "./logger";
import type { Patient } from "./patients";
import type { PushableOrder } from "./ehr-push-order";

export interface EhrOrderPushContext {
  patient: Patient;
  /** Encounter FHIR Encounter.id the order links to. Required by every
   *  real-mode adapter; the mock adapter ignores it. */
  encounterEhrRef: string | null;
  /** Stable Idempotency-Key the caller persisted on the order row.
   *  Reused across retries so the upstream can dedupe. */
  idempotencyKey: string;
  /** When the author has a per-user SMART connection, real-mode
   *  adapters should push via their client so the resource carries
   *  the provider's identity rather than the org client_credentials. */
  userId?: string;
}

export interface EhrOrderPushOutcome {
  /** "mock" | "athenahealth_dry_run" | "athenahealth" | "epic" etc. */
  provider: string;
  /** FHIR resource reference (MedicationRequest/<id> for meds,
   *  ServiceRequest/<id> for everything else). */
  ehrDocumentRef: string;
  pushedAt: Date;
  mock: boolean;
  /** True when this outcome was produced by the dry-run adapter — the
   *  service uses this to avoid stamping exportedAt + status="exported"
   *  on the DB row. */
  dryRun?: boolean;
  /** Dry-run only: the payload that *would* have been sent. Shape is
   *  intentionally adapter-specific; just useful as a human-readable
   *  preview. NEVER persisted (could carry PHI structurally). */
  payloadPreview?: Record<string, unknown>;
}

export interface EhrOrderAdapter {
  /** Display name for logs + outcome.provider field. */
  readonly name: string;
  push(
    order: PushableOrder,
    ctx: EhrOrderPushContext,
  ): Promise<EhrOrderPushOutcome>;
}

// ---------------------------------------------------------------------------
// Mock — synthetic refs, no upstream.
// ---------------------------------------------------------------------------

class MockEhrOrderAdapter implements EhrOrderAdapter {
  readonly name = "mock";
  async push(
    order: PushableOrder,
    ctx: EhrOrderPushContext,
  ): Promise<EhrOrderPushOutcome> {
    const syntheticId = `mock-${order.id}`;
    const resourceType =
      order.orderType === "medication"
        ? "MedicationRequest"
        : "ServiceRequest";
    logger.info(
      {
        orderId: order.id,
        orderType: order.orderType,
        priority: order.priority,
        patientRef: `Patient/${ctx.patient.id}`,
        encounterRef: ctx.encounterEhrRef,
        idempotencyKey: ctx.idempotencyKey,
        syntheticId,
      },
      "EHR order push (mock) — EHR_MODE not set to a real provider; not posting upstream",
    );
    return {
      provider: "mock",
      ehrDocumentRef: `${resourceType}/${syntheticId}`,
      pushedAt: new Date(),
      mock: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Dry-run — build payload preview but never dispatch. Wraps an
// underlying-adapter NAME (for the outcome.provider label) without
// constructing it, so a dry-run never accidentally touches the network.
// ---------------------------------------------------------------------------

function buildPayloadPreview(
  order: PushableOrder,
  ctx: EhrOrderPushContext,
): Record<string, unknown> {
  const isMed = order.orderType === "medication";
  // Shape matches FHIR R4 for human readability — exact field names will
  // be remapped to vendor-specific form params by the real adapter; this
  // preview is for clinician inspection only, NOT the wire format.
  const base = {
    resourceType: isMed ? "MedicationRequest" : "ServiceRequest",
    status: "active",
    intent: "order",
    subject: { reference: `Patient/${ctx.patient.id}` },
    encounter: ctx.encounterEhrRef
      ? { reference: ctx.encounterEhrRef }
      : null,
    priority: order.priority,
    note: order.indication ? [{ text: order.indication }] : [],
  };
  if (isMed) {
    return {
      ...base,
      medicationCodeableConcept: { text: order.medicationName ?? order.name },
      dosageInstruction: [
        {
          text: [
            order.medicationDose,
            order.medicationRoute,
            order.medicationFrequency,
            order.medicationDuration,
          ]
            .filter(Boolean)
            .join(" "),
        },
      ],
      dispenseRequest: {
        quantity: order.medicationQuantity,
        numberOfRepeatsAllowed: order.medicationRefills,
      },
    };
  }
  return {
    ...base,
    code: { text: order.name },
    occurrenceTiming: order.frequency
      ? { code: { text: order.frequency } }
      : null,
  };
}

class DryRunEhrOrderAdapter implements EhrOrderAdapter {
  readonly name: string;
  constructor(private readonly underlyingName: string) {
    this.name = `${underlyingName}_dry_run`;
  }
  async push(
    order: PushableOrder,
    ctx: EhrOrderPushContext,
  ): Promise<EhrOrderPushOutcome> {
    const payload = buildPayloadPreview(order, ctx);
    logger.info(
      {
        orderId: order.id,
        orderType: order.orderType,
        underlying: this.underlyingName,
        idempotencyKey: ctx.idempotencyKey,
      },
      "EHR order push (dry-run) — payload built, NOT dispatched",
    );
    return {
      provider: this.name,
      // No real ref since nothing was created upstream; use a synthetic
      // shape the UI can render as "dry run — not exported".
      ehrDocumentRef: `DryRun/${order.id}`,
      pushedAt: new Date(),
      mock: false,
      dryRun: true,
      payloadPreview: payload,
    };
  }
}

// ---------------------------------------------------------------------------
// Real-mode adapters — NOT YET WIRED. They throw 501 with a precise
// pointer to what's still missing. The service catches EhrPushError and
// persists the message verbatim on the order row.
//
// Wiring each requires:
//   1. FHIR resource builder (MedicationRequest / ServiceRequest) per
//      vendor's expected JSON shape. Look at
//      lib/integrations/ehr/src/document-reference/pusher.ts for the
//      DocumentReference template — orders follow the same factor-out.
//   2. Vendor-specific chart-API endpoint mapping per orderType. Athena
//      uses distinct paths: /chart/encounter/<id>/medications,
//      /lab-orders, /imaging, /referrals. Param names per practice setup
//      must be sandbox-verified (see athena-chart-api.ts header).
//   3. Mapping of upstream error shapes → EhrPushError so the service
//      can distinguish retryable (429/502/503/504) from permanent
//      (400/422) failures.
// ---------------------------------------------------------------------------

class NotImplementedOrderAdapter implements EhrOrderAdapter {
  constructor(readonly name: string) {}
  async push(): Promise<EhrOrderPushOutcome> {
    throw new EhrPushError(
      `Real-mode ${this.name} order push not yet implemented. ` +
        "Wire the per-order-type FHIR builder + vendor endpoint mapping, " +
        "sandbox-verify, then return an adapter instance instead of this stub. " +
        "See ehr-order-adapter.ts for the seam.",
      501,
    );
  }
}

// ---------------------------------------------------------------------------
// Test-only adapter — controlled by EHR_ORDER_PUSH_FORCE so integration
// tests can exercise failure + retry paths without standing up a real
// upstream. Two modes:
//
//   EHR_ORDER_PUSH_FORCE=fail        → every push throws a 502
//                                      EhrPushError (retryable).
//   EHR_ORDER_PUSH_FORCE=fail_once   → first push throws, subsequent
//                                      pushes succeed. State is held in
//                                      this module's scope so it
//                                      survives across calls within a
//                                      test process.
//
// Never use this in prod — resolveEhrOrderAdapter only consults the env
// var when NODE_ENV !== "production".
// ---------------------------------------------------------------------------

let forceFailOnceConsumed = false;

class ForceFailEhrOrderAdapter implements EhrOrderAdapter {
  readonly name = "force_fail";
  constructor(private readonly mode: "fail" | "fail_once") {}
  async push(
    order: PushableOrder,
    ctx: EhrOrderPushContext,
  ): Promise<EhrOrderPushOutcome> {
    if (this.mode === "fail_once" && forceFailOnceConsumed) {
      // Falls through to mock-shape success so retry tests can verify
      // ehrError is cleared + status flips to exported after the first
      // failure. Re-using the real mock adapter keeps the success shape
      // consistent with happy-path tests.
      return new MockEhrOrderAdapter().push(order, ctx);
    }
    if (this.mode === "fail_once") forceFailOnceConsumed = true;
    throw new EhrPushError(
      "Forced failure (EHR_ORDER_PUSH_FORCE=" + this.mode + ")",
      502,
    );
  }
}

/** Test-only: reset the fail-once latch between cases. */
export function __resetForceFailOnceLatchForTesting(): void {
  forceFailOnceConsumed = false;
}

// ---------------------------------------------------------------------------
// Resolver. dryRun=true wins over everything else — we never want a
// dry-run flag to silently hit a real upstream.
// ---------------------------------------------------------------------------

function resolveProviderName(): "athenahealth" | "epic" | "mock" {
  const raw = process.env["EHR_MODE"]?.trim().toLowerCase();
  if (raw === "athenahealth") return "athenahealth";
  if (raw === "epic") return "epic";
  return "mock";
}

export function resolveEhrOrderAdapter(opts: {
  dryRun: boolean;
}): EhrOrderAdapter {
  if (opts.dryRun) {
    return new DryRunEhrOrderAdapter(resolveProviderName());
  }
  // Test-only escape hatch — only honored outside production.
  if (process.env["NODE_ENV"] !== "production") {
    const force = process.env["EHR_ORDER_PUSH_FORCE"]?.trim().toLowerCase();
    if (force === "fail" || force === "fail_once") {
      return new ForceFailEhrOrderAdapter(force);
    }
  }
  const provider = resolveProviderName();
  if (provider === "mock") return new MockEhrOrderAdapter();
  return new NotImplementedOrderAdapter(provider);
}
