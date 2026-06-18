import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { z } from "@workspace/api-zod";
import type {
  CodeSystem,
  Encounter,
  Patient,
  SuggestionConfidence,
} from "@workspace/db";
import { logger } from "./logger";

// One AI-emitted suggestion. Shape locked here (not in the wire-spec)
// because the suggester is a private surface — only billing-suggestions
// rows are user-facing.
const SupportingExcerpt = z.object({
  text: z.string().min(1).max(2000),
  // Optional location hint: "HPI", "Assessment", "Plan", "ROS", etc.
  // Free-form so the AI can use a label that maps to the actual note
  // structure rather than a fixed taxonomy.
  locationHint: z.string().max(60).optional(),
});

const DocumentationGap = z.object({
  // The aspect of documentation that's missing or unclear. E.g.
  // "time_spent", "diabetes_severity", "ros_count".
  field: z.string().min(1).max(80),
  // Human-readable description of what's missing and why it matters.
  message: z.string().min(1).max(500),
  // "info"  — nice to have; provider can ignore
  // "warn"  — should address before approving; shows a yellow flag
  // "block" — refuses approval until addressed (route enforces this)
  severity: z.enum(["info", "warn", "block"]),
});

const SuggestedCode = z.object({
  codeSystem: z.enum(["icd10", "cpt", "em", "modifier"]),
  code: z.string().min(1).max(20),
  description: z.string().min(1).max(300),
  rationale: z.string().min(1).max(2000),
  supportingExcerpts: z.array(SupportingExcerpt).max(8).default([]),
  documentationGaps: z.array(DocumentationGap).max(8).default([]),
  confidence: z.enum(["low", "medium", "high"]),
});

const SuggesterOutput = z.object({
  // The model returns codes grouped only by the array — frontend
  // pivots by codeSystem itself. Keeps the prompt simple.
  codes: z.array(SuggestedCode).max(30),
});

export type SuggestedBillingCode = z.infer<typeof SuggestedCode>;
export type SuggesterResult = z.infer<typeof SuggesterOutput>;

export interface SuggesterInput {
  encounter: Pick<
    Encounter,
    "id" | "visitType" | "customLabel" | "isTelehealth" | "scheduledAt"
  >;
  patient: Pick<Patient, "id" | "dateOfBirth">;
  // Approved note body (or the latest draft if no approval yet). The
  // suggester only sees the note text — never the raw transcript, to
  // avoid encoding ASR errors into billing rationale.
  noteBody: string;
}

// ----------------------------------------------------------------------
// Stub path — deterministic suggestions when ANTHROPIC_API_KEY isn't
// set. Used in dev and tests so the route layer can be exercised
// without burning real API calls.
// ----------------------------------------------------------------------

function stubSuggest(input: SuggesterInput): SuggesterResult {
  const isNew = input.encounter.visitType === "new_patient";
  const tele = input.encounter.isTelehealth;
  const codes: SuggestedBillingCode[] = [];

  // Stub E&M: split by new vs established, mid-level by default.
  codes.push({
    codeSystem: "em",
    code: isNew ? "99203" : "99213",
    description: isNew
      ? "Office visit, new patient, moderate complexity"
      : "Office visit, established patient, moderate complexity",
    rationale:
      "Stub suggestion: visit type and MDM not parsed by AI " +
      "(ANTHROPIC_API_KEY not configured). Level guessed from " +
      "visit type. Provider should reset to the correct level.",
    supportingExcerpts: [],
    documentationGaps: [
      {
        field: "ai_unavailable",
        message:
          "Real AI suggester is offline. Codes shown are placeholders " +
          "and should not be relied on for billing.",
        severity: "warn",
      },
    ],
    confidence: "low",
  });

  if (tele) {
    codes.push({
      codeSystem: "modifier",
      code: "95",
      description: "Synchronous telehealth via real-time interactive A/V",
      rationale:
        "Stub: encounter flagged isTelehealth=true. Modifier 95 is the " +
        "standard telehealth indicator for commercial payers.",
      supportingExcerpts: [],
      documentationGaps: [],
      confidence: "high",
    });
  }

  // One placeholder ICD-10 so the UI has multiple code systems to render.
  codes.push({
    codeSystem: "icd10",
    code: "Z00.00",
    description: "Encounter for general adult medical examination without abnormal findings",
    rationale:
      "Stub: no diagnosis extracted from note body. Defaulting to a " +
      "non-billable wellness placeholder so provider gets a starting " +
      "point.",
    supportingExcerpts: [],
    documentationGaps: [
      {
        field: "primary_diagnosis",
        message: "No primary diagnosis identified in the note.",
        severity: "warn",
      },
    ],
    confidence: "low",
  });

  return { codes };
}

// ----------------------------------------------------------------------
// Real path — Anthropic messages.create with tool_use for structured
// output. Tool-use gives strict JSON the SDK validates against the
// declared schema before returning to us; we still Zod-validate to
// catch shape drift between SDK versions.
// ----------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "You are a clinical billing assistant. Given an outpatient encounter",
    "note, produce ICD-10, CPT, E&M-level, and modifier code suggestions",
    "that are well-supported by the note text.",
    "",
    "Rules:",
    "  1. Only suggest codes the note clearly supports. If unsure, lower",
    "     the confidence rather than omitting the code entirely.",
    "  2. For E&M (codeSystem='em'), suggest exactly one level per",
    "     encounter — the level you believe best matches the documented",
    "     work. Pick from 99202-99205 (new) or 99212-99215 (established).",
    "  3. Use codeSystem='em' for E&M levels (not 'cpt'), even though",
    "     E&M codes are technically CPT.",
    "  4. supportingExcerpts must quote the note verbatim — do not",
    "     paraphrase. The provider needs to be able to grep the note.",
    "  5. documentationGaps with severity='block' will prevent the",
    "     provider from approving the code. Reserve 'block' for true",
    "     compliance issues (missing time on time-based codes, etc.).",
    "  6. NEVER fabricate clinical findings to support a code. If the",
    "     note doesn't document it, do not code it.",
    "  7. You are a SUGGESTION engine. The provider has final authority.",
  ].join("\n");
}

function buildUserPrompt(input: SuggesterInput): string {
  const visitLabel =
    input.encounter.visitType === "custom"
      ? `custom (${input.encounter.customLabel ?? "unspecified"})`
      : input.encounter.visitType;
  return [
    `Visit type: ${visitLabel}`,
    `Telehealth: ${input.encounter.isTelehealth ? "yes" : "no"}`,
    `Patient DOB: ${input.patient.dateOfBirth}`,
    "",
    "Note body:",
    "```",
    input.noteBody,
    "```",
    "",
    "Produce the code suggestions now.",
  ].join("\n");
}

// Tool schema — Anthropic uses this to constrain the output JSON.
// Kept aligned with SuggesterOutput; if it drifts, Zod will catch it.
const TOOL_SCHEMA: Tool = {
  name: "submit_billing_suggestions",
  description:
    "Submit the final list of billing code suggestions for this encounter.",
  input_schema: {
    type: "object",
    properties: {
      codes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            codeSystem: {
              type: "string",
              enum: ["icd10", "cpt", "em", "modifier"],
            },
            code: { type: "string" },
            description: { type: "string" },
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
            documentationGaps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  field: { type: "string" },
                  message: { type: "string" },
                  severity: {
                    type: "string",
                    enum: ["info", "warn", "block"],
                  },
                },
                required: ["field", "message", "severity"],
              },
            },
            confidence: {
              type: "string",
              enum: ["low", "medium", "high"],
            },
          },
          required: [
            "codeSystem",
            "code",
            "description",
            "rationale",
            "confidence",
          ],
        },
      },
    },
    required: ["codes"],
  },
};

async function realSuggest(input: SuggesterInput): Promise<SuggesterResult> {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: buildSystemPrompt(),
    tools: [TOOL_SCHEMA],
    tool_choice: { type: "tool", name: TOOL_SCHEMA.name },
    messages: [{ role: "user", content: buildUserPrompt(input) }],
  });

  // The forced tool call lives in the response.content stream. With
  // tool_choice fixed, the model returns exactly one tool_use block
  // whose .input matches TOOL_SCHEMA.input_schema.
  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error(
      "billing-suggester: model returned no tool_use block (got " +
        response.content.map((b) => b.type).join(",") +
        ")",
    );
  }

  const parsed = SuggesterOutput.safeParse(block.input);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues },
      "billing-suggester: tool_use output failed Zod validation",
    );
    throw new Error("billing-suggester: malformed tool output");
  }
  return parsed.data;
}

// ----------------------------------------------------------------------
// Public surface — picks the path based on env. Mirrors the
// recording-pipeline.ts `RECORDING_PIPELINE` flag pattern so dev
// without keys remains functional.
// ----------------------------------------------------------------------

export async function suggestBillingCodes(
  input: SuggesterInput,
): Promise<{ result: SuggesterResult; source: "ai" | "stub" }> {
  const forceMode = process.env["BILLING_SUGGESTER"];
  const hasKey = !!process.env["ANTHROPIC_API_KEY"];

  const useReal =
    forceMode === "ai" || (forceMode !== "stub" && forceMode !== "off" && hasKey);

  if (!useReal) {
    return { result: stubSuggest(input), source: "stub" };
  }

  try {
    const result = await realSuggest(input);
    return { result, source: "ai" };
  } catch (err) {
    // Failing closed on AI error would block the billing flow entirely.
    // Prefer to degrade to stub + a warn log so the provider can still
    // hand-enter codes — same fallback posture the rest of the AI
    // pipeline uses.
    logger.warn(
      { err, encounterId: input.encounter.id },
      "billing-suggester: real AI call failed, degrading to stub",
    );
    return { result: stubSuggest(input), source: "stub" };
  }
}

// Re-exports for the route layer.
export { SuggesterOutput };
export type {
  CodeSystem,
  SuggestionConfidence,
};
