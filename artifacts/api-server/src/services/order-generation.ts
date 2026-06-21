// generateOrdersForEncounter — the order-suggester pipeline as a service.
//
// Pulled out of POST /encounters/:id/orders/suggest so two callers can
// reach it:
//
//   1. The route handler — explicit "click Generate orders" from the
//      desktop encounter-review page, fully synchronous.
//   2. lib/auto-push.ts — fires after a transcribed note auto-pushes,
//      so the mobile "record + walk away" flow gets order suggestions
//      (and auto-approve-push for non-meds) without the client having
//      to stay on the screen to trigger them.
//
// Both code paths share the same approve-non-meds + hold-meds policy
// so the mobile and desktop flows can't drift. The route still owns
// authorization / response shaping; this service is just the work.

import { and, desc, eq } from "drizzle-orm";
import {
  approvedBillingCodesTable,
  encountersTable,
  getDb,
  notesTable,
  orderSuggestionsTable,
  patientsTable,
  type OrderSuggestion,
} from "@workspace/db";
import { suggestOrders } from "../lib/order-suggester";
import {
  autoApproveAndPushNonMedOrders,
  type AutoApproveResult,
} from "./order-auto-approve";

export type GenerateOrdersResult =
  | { kind: "encounter_not_found" }
  | { kind: "patient_not_found" }
  | { kind: "no_note_to_order_from" }
  | {
      kind: "ok";
      inserted: OrderSuggestion[];
      source: "ai" | "stub";
      autoApproved: AutoApproveResult | null;
    };

export interface GenerateOrdersArgs {
  encounterId: string;
  orgId: string;
  /** When provided AND the user has autoApproveNonMedOrders=true, the
   *  non-medication suggestions auto-approve and push immediately. The
   *  service does NOT check the user flag itself — the caller is
   *  responsible for that (the route reads req.user; the auto-push
   *  hook reads the user row directly). */
  autoApproveNonMedFor?: { userId: string; enabled: boolean };
}

export async function generateOrdersForEncounter(
  args: GenerateOrdersArgs,
): Promise<GenerateOrdersResult> {
  const db = getDb();

  const [encounter] = await db
    .select()
    .from(encountersTable)
    .where(
      and(
        eq(encountersTable.id, args.encounterId),
        eq(encountersTable.organizationId, args.orgId),
      ),
    )
    .limit(1);
  if (!encounter) return { kind: "encounter_not_found" };

  const [patient] = await db
    .select({ id: patientsTable.id, dateOfBirth: patientsTable.dateOfBirth })
    .from(patientsTable)
    .where(
      and(
        eq(patientsTable.id, encounter.patientId),
        eq(patientsTable.organizationId, args.orgId),
      ),
    )
    .limit(1);
  if (!patient) return { kind: "patient_not_found" };

  const [note] = await db
    .select({ body: notesTable.body })
    .from(notesTable)
    .where(
      and(
        eq(notesTable.encounterId, args.encounterId),
        eq(notesTable.organizationId, args.orgId),
      ),
    )
    .orderBy(desc(notesTable.updatedAt))
    .limit(1);
  if (!note) return { kind: "no_note_to_order_from" };

  // Approved diagnoses on the encounter — passed to the suggester so
  // it can link orders to ICD-10s without making the provider re-type.
  const approvedDx = await db
    .select({
      code: approvedBillingCodesTable.code,
      description: approvedBillingCodesTable.description,
    })
    .from(approvedBillingCodesTable)
    .where(
      and(
        eq(approvedBillingCodesTable.encounterId, args.encounterId),
        eq(approvedBillingCodesTable.organizationId, args.orgId),
        eq(approvedBillingCodesTable.codeSystem, "icd10"),
      ),
    );

  const { result, source } = await suggestOrders({
    encounter: {
      id: encounter.id,
      visitType: encounter.visitType,
      customLabel: encounter.customLabel,
      isTelehealth: encounter.isTelehealth,
      scheduledAt: encounter.scheduledAt,
    },
    patient,
    noteBody: note.body,
    approvedDiagnoses: approvedDx,
  });

  if (result.orders.length === 0) {
    return { kind: "ok", inserted: [], source, autoApproved: null };
  }

  const inserted = await db
    .insert(orderSuggestionsTable)
    .values(
      result.orders.map((n) => ({
        organizationId: args.orgId,
        encounterId: args.encounterId,
        orderType: n.raw.orderType,
        name: n.raw.name,
        indication: n.raw.indication,
        indicationDiagnosisCode: n.raw.indicationDiagnosisCode ?? null,
        priority: n.raw.priority,
        instructions: n.raw.instructions ?? null,
        frequency: n.raw.frequency ?? null,
        duration: n.raw.duration ?? null,
        medicationName: n.raw.medication?.name ?? null,
        medicationDose: n.raw.medication?.dose ?? null,
        medicationRoute: n.raw.medication?.route ?? null,
        medicationFrequency: n.raw.medication?.frequency ?? null,
        medicationDuration: n.raw.medication?.duration ?? null,
        medicationQuantity: n.raw.medication?.quantity ?? null,
        medicationRefills: n.raw.medication?.refills ?? null,
        isComplete: n.isComplete,
        safetyWarnings: n.safetyWarnings,
        rationale: n.raw.rationale,
        supportingExcerpts: n.raw.supportingExcerpts,
        createdByAi: true,
      })),
    )
    .returning();

  let autoApproved: AutoApproveResult | null = null;
  if (args.autoApproveNonMedFor?.enabled) {
    try {
      autoApproved = await autoApproveAndPushNonMedOrders({
        encounterId: args.encounterId,
        orgId: args.orgId,
        initiatingUserId: args.autoApproveNonMedFor.userId,
      });
    } catch {
      // Don't let a downstream push failure mask the successful
      // generation. Suggestions still land; the doctor can review on
      // desktop. Logged at the caller layer.
      autoApproved = null;
    }
  }

  return { kind: "ok", inserted, source, autoApproved };
}
