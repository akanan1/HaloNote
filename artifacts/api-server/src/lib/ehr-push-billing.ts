import { EhrPushError, type EhrPushOutcome } from "./ehr-push";
import { logger } from "./logger";
import { getAthenaChartClient } from "./athena-chart-api";

// Billing code shape the pusher needs. Caller maps DB row → this.
export interface PushableBillingCode {
  id: string;
  codeSystem: "icd10" | "cpt" | "em" | "modifier";
  code: string;
  description: string;
}

export interface PushBillingParams {
  billingCode: PushableBillingCode;
  /** Encounter the code is tied to (FHIR Encounter.id). */
  encounterEhrRef: string | null;
  /** When the author has a SMART connection, push via their per-user
   *  client so the resource carries their identity. */
  userId?: string;
}

function resolveProvider(): "athenahealth" | "epic" | "mock" {
  const mode = process.env["EHR_MODE"]?.trim().toLowerCase();
  if (mode === "athenahealth") return "athenahealth";
  if (mode === "epic") return "epic";
  return "mock";
}

/**
 * Push an approved billing code to the EHR / charge system. Same
 * mock-vs-real split as pushOrderToEhr; real path is per-provider
 * follow-up wiring. In FHIR R4 the code would land as a Claim row
 * line item (or via the vendor's charge entry endpoint when FHIR
 * write isn't available, e.g. Athena's REST charges API).
 */
export async function pushBillingCodeToEhr(
  params: PushBillingParams,
): Promise<EhrPushOutcome> {
  const provider = resolveProvider();

  if (provider === "mock") {
    const syntheticId = `mock-${params.billingCode.id}`;
    logger.info(
      {
        billingCodeId: params.billingCode.id,
        codeSystem: params.billingCode.codeSystem,
        // The code itself isn't PHI but logging it makes audit log
        // joins (encounter → code) much easier in dev.
        code: params.billingCode.code,
        encounterRef: params.encounterEhrRef,
        syntheticId,
      },
      "EHR billing push (mock) — EHR_MODE not set to a real provider; not posting upstream",
    );
    return {
      provider: "mock",
      ehrDocumentRef: `Claim/${syntheticId}`,
      pushedAt: new Date(),
      mock: true,
    };
  }

  // Real-mode Athena push via the chart REST API. SANDBOX-VERIFY the
  // request param names before flipping EHR_MODE — see the header of
  // lib/athena-chart-api.ts for the verification checklist.
  if (provider === "athenahealth") {
    const client = getAthenaChartClient();
    // Idempotency key keyed on (billing code id) — same row pushed
    // twice (auto-retry or user-pressed) reuses the same key, so
    // Athena dedupes within its retention window.
    const idempotencyKey = `bc_${params.billingCode.id}`;
    try {
      if (
        params.billingCode.codeSystem === "icd10"
      ) {
        if (!params.encounterEhrRef) {
          throw new EhrPushError(
            "Encounter is not linked to Athena and cannot be pushed yet. Link the encounter to its Athena chart entry, then retry.",
            409,
          );
        }
        const out = await client.pushDiagnosis({
          encounterId: stripFhirPrefix(params.encounterEhrRef),
          icd10: params.billingCode.code,
          description: params.billingCode.description,
          idempotencyKey,
        });
        return {
          provider: "athenahealth",
          ehrDocumentRef: out.resourceRef,
          pushedAt: new Date(),
          mock: false,
        };
      }
      // CPT, E&M, and modifiers all flow as procedure / service lines.
      // Modifiers strictly attach to a parent CPT line; pushing a
      // modifier in isolation is a no-op upstream — accept it locally
      // (the row is approved, after all) but emit a warning.
      if (params.billingCode.codeSystem === "modifier") {
        logger.warn(
          { code: params.billingCode.code },
          "athena chart push: modifier pushed in isolation — Athena ignores it; modifier must attach to a parent service line",
        );
      }
      if (!params.encounterEhrRef) {
        throw new EhrPushError(
          "Encounter is not linked to Athena and cannot be pushed yet. Link the encounter to its Athena chart entry, then retry.",
          409,
        );
      }
      const out = await client.pushProcedure({
        encounterId: stripFhirPrefix(params.encounterEhrRef),
        cpt: params.billingCode.code,
        description: params.billingCode.description,
        idempotencyKey,
      });
      return {
        provider: "athenahealth",
        ehrDocumentRef: out.resourceRef,
        pushedAt: new Date(),
        mock: false,
      };
    } catch (err) {
      if (err instanceof EhrPushError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new EhrPushError(`athena_billing_push_failed: ${message}`, 502);
    }
  }

  logger.warn(
    {
      billingCodeId: params.billingCode.id,
      provider,
      userId: params.userId,
    },
    "EHR billing push: real-mode wiring not yet implemented for this provider",
  );
  throw new EhrPushError(
    `ehr_billing_push_not_implemented_for_${provider}`,
    501,
  );
}

// "Encounter/12345" → "12345". Athena's REST endpoints take raw ids,
// not FHIR-style "ResourceType/id" references.
function stripFhirPrefix(ref: string): string {
  const slash = ref.indexOf("/");
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}
