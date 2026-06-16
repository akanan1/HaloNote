import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { z } from "@workspace/api-zod";
import type { Encounter, OrderType, Patient } from "@workspace/db";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Output schema. Locked here (not in OpenAPI) because the suggester is a
// private surface — only persisted order_suggestions rows are user-facing.
// ---------------------------------------------------------------------------

const SupportingExcerpt = z.object({
  text: z.string().min(1).max(2000),
  locationHint: z.string().max(60).optional(),
});

const SafetyWarning = z.object({
  kind: z.string().min(1).max(80),
  message: z.string().min(1).max(500),
  severity: z.enum(["info", "warn", "block"]),
});

// Medication block. Only meaningful when orderType='medication'; the
// schema requires it on med suggestions and forbids it on others. The
// AI prompt is explicit about not filling med fields for non-med
// orders — this is a defense layer in case it slips.
const MedicationDetails = z.object({
  name: z.string().min(1).max(200),
  // Free-text dose preserves the units doctors actually write
  // ("500 mg", "1 g", "5 mL"). Structured units would force a
  // dictionary lookup that doesn't survive specialty differences.
  dose: z.string().min(1).max(100),
  route: z.string().min(1).max(40),
  frequency: z.string().min(1).max(80),
  duration: z.string().min(1).max(80),
  // Integer quantity / refills as on a prescription pad.
  quantity: z.number().int().min(1).max(10000).optional(),
  refills: z.number().int().min(0).max(12).optional(),
});

const SuggestedOrder = z.object({
  orderType: z.enum([
    "lab",
    "imaging",
    "referral",
    "medication",
    "procedure",
    "followup",
    "instruction",
    "dme",
    "therapy",
    "nursing",
  ]),
  name: z.string().min(1).max(300),
  indication: z.string().min(1).max(500),
  indicationDiagnosisCode: z.string().max(20).optional(),
  priority: z.enum(["routine", "urgent", "stat"]).default("routine"),
  instructions: z.string().max(2000).optional(),
  // Non-med frequency / duration (e.g. "twice weekly", "x 4 weeks").
  // Med orders use the medication.frequency / medication.duration inside
  // the medication block, not these.
  frequency: z.string().max(80).optional(),
  duration: z.string().max(80).optional(),
  medication: MedicationDetails.optional(),
  rationale: z.string().min(1).max(2000),
  supportingExcerpts: z.array(SupportingExcerpt).max(8).default([]),
  safetyWarnings: z.array(SafetyWarning).max(8).default([]),
});

const SuggesterOutput = z.object({
  orders: z.array(SuggestedOrder).max(30),
});

export type SuggestedOrderRow = z.infer<typeof SuggestedOrder>;
export type OrderSuggesterResult = z.infer<typeof SuggesterOutput>;

export interface OrderSuggesterInput {
  encounter: Pick<
    Encounter,
    "id" | "visitType" | "customLabel" | "isTelehealth" | "scheduledAt"
  >;
  patient: Pick<Patient, "id" | "dateOfBirth">;
  noteBody: string;
  // Optional list of approved billing codes for this encounter. Used by
  // the AI to link orders to the diagnosis being treated (the
  // indicationDiagnosisCode) without making the provider re-type ICD-10s.
  approvedDiagnoses?: Array<{ code: string; description: string }>;
}

// ---------------------------------------------------------------------------
// Server-side completeness check + safety augmentation. Runs over the
// AI / stub output before persisting. The route layer uses isComplete to
// gate the export_ready transition for medications.
// ---------------------------------------------------------------------------

interface NormalizedOrder {
  raw: SuggestedOrderRow;
  isComplete: boolean;
  safetyWarnings: Array<{
    kind: string;
    message: string;
    severity: "info" | "warn" | "block";
  }>;
}

export function normalizeOrder(o: SuggestedOrderRow): NormalizedOrder {
  const warnings = [...o.safetyWarnings];
  let complete = true;

  if (o.orderType === "medication") {
    const med = o.medication;
    if (!med) {
      warnings.push({
        kind: "missing_medication_block",
        message:
          "Order type is medication but no structured medication details " +
          "were provided. Provider must fill in name/dose/route/frequency/duration " +
          "before this order can be marked export-ready.",
        severity: "block",
      });
      complete = false;
    } else {
      // Each required med field gets its own warning so the provider
      // sees exactly what's missing rather than one opaque error.
      const required: Array<[keyof typeof med, string]> = [
        ["name", "medication name"],
        ["dose", "dose"],
        ["route", "route"],
        ["frequency", "frequency"],
        ["duration", "duration"],
      ];
      for (const [field, label] of required) {
        if (!med[field] || String(med[field]).trim() === "") {
          warnings.push({
            kind: "missing_field",
            message: `Missing ${label}; required before this medication can be export-ready.`,
            severity: "block",
          });
          complete = false;
        }
      }
      if (med.quantity == null) {
        warnings.push({
          kind: "missing_quantity",
          message:
            "Dispense quantity not specified. Required by most pharmacies; defaults to a single fill.",
          severity: "warn",
        });
      }
      if (med.refills == null) {
        warnings.push({
          kind: "missing_refills",
          message:
            "Refills not specified. Defaulting to 0 — confirm before sending if a longer course is intended.",
          severity: "info",
        });
      }
    }
  } else {
    // Non-med orders forbid the medication block. If the AI emitted one
    // for a non-med order_type, downgrade with a warning rather than
    // discarding silently.
    if (o.medication) {
      warnings.push({
        kind: "medication_on_non_medication",
        message:
          `Medication details supplied on a ${o.orderType} order; ignored. ` +
          "This is an AI consistency bug, not a clinical concern.",
        severity: "info",
      });
    }
    if (!o.name || o.name.trim().length === 0) {
      complete = false;
    }
  }

  // Any block-severity warning forces incomplete, even if all required
  // fields were present.
  if (warnings.some((w) => w.severity === "block")) {
    complete = false;
  }

  return { raw: o, isComplete: complete, safetyWarnings: warnings };
}

// ---------------------------------------------------------------------------
// Stub path. CRITICAL: never emits medication orders. Stub mode is for
// dev without an Anthropic key; hallucinating a medication name into a
// suggestion that a tired provider might click-through-approve is a
// patient-harm vector. Real meds require real AI.
// ---------------------------------------------------------------------------

function stubSuggest(input: OrderSuggesterInput): OrderSuggesterResult {
  const orders: SuggestedOrderRow[] = [];

  // Always emit a follow-up — every visit needs one, easy to verify
  // against the note in the UI.
  orders.push({
    orderType: "followup",
    name: "Follow-up visit",
    indication: "Routine follow-up; review progress and labs.",
    priority: "routine",
    frequency: "once",
    duration: "in 4 weeks",
    rationale:
      "Stub suggestion: AI suggester is offline. Follow-up cadence " +
      "should be set by the provider based on the actual encounter.",
    supportingExcerpts: [],
    safetyWarnings: [
      {
        kind: "ai_unavailable",
        message:
          "Real order suggester is offline. Provider must add lab / imaging / " +
          "medication orders manually.",
        severity: "warn",
      },
    ],
  });

  // For new-patient visits, also suggest baseline labs — non-prescriptive
  // and low-harm if the provider rejects it.
  if (input.encounter.visitType === "new_patient") {
    orders.push({
      orderType: "lab",
      name: "Baseline labs (CBC, CMP)",
      indication: "New patient baseline workup.",
      priority: "routine",
      rationale:
        "Stub: standard new-patient screen. Real suggester would tailor to " +
        "documented history.",
      supportingExcerpts: [],
      safetyWarnings: [],
    });
  }

  return { orders };
}

// ---------------------------------------------------------------------------
// Real path — Anthropic with forced tool_use.
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "You are a clinical order-entry assistant. Given an outpatient encounter",
    "note, suggest orders that the note clearly indicates are needed.",
    "",
    "Rules:",
    "  1. Only suggest orders the note clearly supports. If unsure, omit.",
    "  2. For MEDICATION orders, you MUST fill in the structured medication",
    "     block (name, dose, route, frequency, duration). Quantity and refills",
    "     are optional but strongly recommended. If you cannot determine any",
    "     of name/dose/route/frequency/duration from the note, do not emit",
    "     the order — the provider will add it manually.",
    "  3. NEVER suggest a medication the note does not document. Hallucinating",
    "     a prescription is a patient-harm scenario.",
    "  4. NEVER fabricate dosing. If the dose is unclear from the note, set",
    "     a safetyWarnings entry with severity='block' and emit the order",
    "     anyway so the provider sees what you saw — but they will be unable",
    "     to mark it export-ready until they fix the dose.",
    "  5. For non-medication orders, leave the medication field empty. Use",
    "     the top-level frequency / duration fields for cadence on labs,",
    "     imaging, PT, etc.",
    "  6. supportingExcerpts must quote the note verbatim. The provider will",
    "     grep on these.",
    "  7. You are a SUGGESTION engine. The provider has final authority on",
    "     every order. Especially for medications.",
  ].join("\n");
}

function buildUserPrompt(input: OrderSuggesterInput): string {
  const visitLabel =
    input.encounter.visitType === "custom"
      ? `custom (${input.encounter.customLabel ?? "unspecified"})`
      : input.encounter.visitType;
  const dxBlock =
    input.approvedDiagnoses && input.approvedDiagnoses.length > 0
      ? [
          "",
          "Already-approved diagnoses for this encounter (you may set",
          "indicationDiagnosisCode to any of these when relevant):",
          ...input.approvedDiagnoses.map(
            (d) => `  - ${d.code}: ${d.description}`,
          ),
        ].join("\n")
      : "";
  return [
    `Visit type: ${visitLabel}`,
    `Telehealth: ${input.encounter.isTelehealth ? "yes" : "no"}`,
    `Patient DOB: ${input.patient.dateOfBirth}`,
    dxBlock,
    "",
    "Note body:",
    "```",
    input.noteBody,
    "```",
    "",
    "Produce the order suggestions now.",
  ].join("\n");
}

const TOOL_SCHEMA: Tool = {
  name: "submit_order_suggestions",
  description:
    "Submit the final list of order suggestions for this encounter.",
  input_schema: {
    type: "object",
    properties: {
      orders: {
        type: "array",
        items: {
          type: "object",
          properties: {
            orderType: {
              type: "string",
              enum: [
                "lab",
                "imaging",
                "referral",
                "medication",
                "procedure",
                "followup",
                "instruction",
                "dme",
                "therapy",
                "nursing",
              ],
            },
            name: { type: "string" },
            indication: { type: "string" },
            indicationDiagnosisCode: { type: "string" },
            priority: { type: "string", enum: ["routine", "urgent", "stat"] },
            instructions: { type: "string" },
            frequency: { type: "string" },
            duration: { type: "string" },
            medication: {
              type: "object",
              properties: {
                name: { type: "string" },
                dose: { type: "string" },
                route: { type: "string" },
                frequency: { type: "string" },
                duration: { type: "string" },
                quantity: { type: "integer" },
                refills: { type: "integer" },
              },
              required: ["name", "dose", "route", "frequency", "duration"],
            },
            rationale: { type: "string" },
            supportingExcerpts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  text: { type: "string" },
                  locationHint: { type: "string" },
                },
                required: ["text"],
              },
            },
            safetyWarnings: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  kind: { type: "string" },
                  message: { type: "string" },
                  severity: {
                    type: "string",
                    enum: ["info", "warn", "block"],
                  },
                },
                required: ["kind", "message", "severity"],
              },
            },
          },
          required: ["orderType", "name", "indication", "rationale"],
        },
      },
    },
    required: ["orders"],
  },
};

async function realSuggest(
  input: OrderSuggesterInput,
): Promise<OrderSuggesterResult> {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 3072,
    system: buildSystemPrompt(),
    tools: [TOOL_SCHEMA],
    tool_choice: { type: "tool", name: TOOL_SCHEMA.name },
    messages: [{ role: "user", content: buildUserPrompt(input) }],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error(
      "order-suggester: model returned no tool_use block (got " +
        response.content.map((b) => b.type).join(",") +
        ")",
    );
  }
  const parsed = SuggesterOutput.safeParse(block.input);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues },
      "order-suggester: tool_use output failed Zod validation",
    );
    throw new Error("order-suggester: malformed tool output");
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Public surface. Returns the normalized list with isComplete + augmented
// safetyWarnings pre-computed by the server.
// ---------------------------------------------------------------------------

export async function suggestOrders(
  input: OrderSuggesterInput,
): Promise<{
  result: { orders: NormalizedOrder[] };
  source: "ai" | "stub";
}> {
  const forceMode = process.env["ORDER_SUGGESTER"];
  const hasKey = !!process.env["ANTHROPIC_API_KEY"];
  const useReal =
    forceMode === "ai" ||
    (forceMode !== "stub" && forceMode !== "off" && hasKey);

  const raw = !useReal
    ? { result: stubSuggest(input), source: "stub" as const }
    : await realSuggest(input)
        .then((result) => ({ result, source: "ai" as const }))
        .catch((err) => {
          logger.warn(
            { err, encounterId: input.encounter.id },
            "order-suggester: real AI call failed, degrading to stub",
          );
          return { result: stubSuggest(input), source: "stub" as const };
        });

  const normalized = raw.result.orders.map((o) => normalizeOrder(o));
  return { result: { orders: normalized }, source: raw.source };
}

export type { OrderType };
