import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { z } from "@workspace/api-zod";
import type { Encounter, Patient } from "@workspace/db";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Patient visit summary generator.
//
// Different audience than every other AI surface in HaloNote: this one
// speaks to PATIENTS, not providers. So the prompt is explicit about
// reading level, tone, and forbidden vocabulary.
//
// The output is structured so the frontend can render it as a
// formatted handout (or paste-ready text). Sections:
//   - overview: one paragraph, "here's what we talked about today"
//   - diagnoses: each diagnosis explained in plain language ("what this
//     means" rather than ICD-10)
//   - medications: each med with WHEN / HOW / WHY in patient terms
//   - selfCare: instructions for at-home care
//   - followUp: when and why to come back
//   - whenToCall: warning signs that should prompt an earlier call
//                 (or ER visit)
// ---------------------------------------------------------------------------

const Diagnosis = z.object({
  // Plain-language name. "Type 2 diabetes" not "E11.9".
  name: z.string().min(1).max(200),
  // 1-2 sentence "what this means to you" explanation.
  explanation: z.string().min(1).max(500),
});

const Medication = z.object({
  // Drug name as the patient should know it. Use the brand or generic
  // they're most likely to recognize on the bottle.
  name: z.string().min(1).max(200),
  // "Take 1 pill by mouth twice a day with food" — full sentence the
  // patient can read at the pharmacy.
  howToTake: z.string().min(1).max(500),
  // "To help control your blood sugar." — one-line patient-facing
  // rationale.
  why: z.string().min(1).max(300),
});

const FollowUp = z.object({
  // "In 4 weeks", "In 3 months", "Tomorrow"
  when: z.string().min(1).max(100),
  // "We'll check on how the new medicine is working."
  why: z.string().min(1).max(300),
});

const SummaryOutput = z.object({
  overview: z.string().min(1).max(800),
  diagnoses: z.array(Diagnosis).max(10),
  medications: z.array(Medication).max(20),
  selfCare: z.array(z.string().min(1).max(500)).max(10),
  followUp: FollowUp.optional(),
  whenToCall: z.array(z.string().min(1).max(400)).max(10),
});

export type PatientSummaryResult = z.infer<typeof SummaryOutput>;

export interface SummaryGeneratorInput {
  noteId: string;
  noteBody: string;
  patient: Pick<Patient, "firstName" | "dateOfBirth">;
  encounter: Pick<Encounter, "visitType" | "customLabel" | "isTelehealth">;
}

// ---------------------------------------------------------------------------
// Stub — deterministic placeholder. Avoids generating fake clinical
// content; instead emits a clearly-marked placeholder so the provider
// sees the panel rendering correctly without trusting any of it.
// Mirrors the orders-stub posture: low-risk surfaces (workflow tasks)
// generate aggressively in stub mode; clinical content does not.
// ---------------------------------------------------------------------------

function stubGenerate(input: SummaryGeneratorInput): PatientSummaryResult {
  const name = input.patient.firstName;
  return {
    overview:
      `Hi ${name}, this is a placeholder visit summary. The real AI ` +
      "summary generator is offline (ANTHROPIC_API_KEY not configured). " +
      "Your provider will write a real summary before this is shared.",
    diagnoses: [],
    medications: [],
    selfCare: [
      "Drink plenty of water.",
      "Get a full night of sleep.",
      "Call our office if you have questions.",
    ],
    followUp: undefined,
    whenToCall: [
      "Call our office if anything from today's visit feels worse or unclear.",
    ],
  };
}

// ---------------------------------------------------------------------------
// Real path — Anthropic with forced tool_use. Prompt is explicit about
// reading level, jargon, and what NOT to fabricate.
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "You are a clinical communication assistant. Given a provider's",
    "clinical note from a visit, generate a patient-facing visit summary.",
    "",
    "Audience: patients, not clinicians. Many patients read at a 6th-grade",
    "level. Some have limited health literacy.",
    "",
    "Rules:",
    "  1. Write at a 6th-grade reading level. Short sentences. Common words.",
    "  2. NO medical jargon without explanation. If you must use a term,",
    "     define it inline in parentheses ('hypertension (high blood",
    "     pressure)').",
    "  3. NO codes (ICD-10, CPT, E&M). Patients don't know what those are.",
    "  4. Tone: warm, direct, respectful. Address the patient by first",
    "     name in the overview. Avoid 'the patient was...' phrasing.",
    "  5. Medications: write the instructions in the same form the patient",
    "     will see at the pharmacy ('Take 1 pill by mouth twice a day').",
    "     Always state WHY — patients are far more likely to take a",
    "     medicine they understand the purpose of.",
    "  6. NEVER invent diagnoses, dosing, or follow-up timing the note",
    "     doesn't support. If the note doesn't say what dose, omit the",
    "     medication entry rather than guess.",
    "  7. whenToCall: prioritize clear, action-oriented warnings ('Call",
    "     us if you feel short of breath' or 'Go to the emergency room",
    "     if you have chest pain'). These are the most important sentences",
    "     in the summary.",
    "  8. selfCare: concrete, day-to-day instructions. 'Eat a low-salt",
    "     diet.' not 'Make dietary modifications.'",
    "  9. overview should be 2-4 sentences. Save details for the structured",
    "     sections.",
    " 10. You are NOT the prescriber. The provider has final authority on",
    "     every clinical word. Stay within what the note documents.",
  ].join("\n");
}

function buildUserPrompt(input: SummaryGeneratorInput): string {
  const visitLabel =
    input.encounter.visitType === "custom"
      ? `custom (${input.encounter.customLabel ?? "unspecified"})`
      : input.encounter.visitType;
  return [
    `Patient first name: ${input.patient.firstName}`,
    `Visit type: ${visitLabel}`,
    `Telehealth: ${input.encounter.isTelehealth ? "yes" : "no"}`,
    "",
    "Note body:",
    "```",
    input.noteBody,
    "```",
    "",
    "Generate the patient summary now.",
  ].join("\n");
}

const TOOL_SCHEMA: Tool = {
  name: "submit_patient_summary",
  description: "Submit the final patient-facing visit summary.",
  input_schema: {
    type: "object",
    properties: {
      overview: { type: "string" },
      diagnoses: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            explanation: { type: "string" },
          },
          required: ["name", "explanation"],
        },
      },
      medications: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            howToTake: { type: "string" },
            why: { type: "string" },
          },
          required: ["name", "howToTake", "why"],
        },
      },
      selfCare: { type: "array", items: { type: "string" } },
      followUp: {
        type: "object",
        properties: {
          when: { type: "string" },
          why: { type: "string" },
        },
        required: ["when", "why"],
      },
      whenToCall: { type: "array", items: { type: "string" } },
    },
    required: ["overview", "diagnoses", "medications", "selfCare", "whenToCall"],
  },
};

async function realGenerate(
  input: SummaryGeneratorInput,
): Promise<PatientSummaryResult> {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: buildSystemPrompt(),
    tools: [TOOL_SCHEMA],
    tool_choice: { type: "tool", name: TOOL_SCHEMA.name },
    messages: [{ role: "user", content: buildUserPrompt(input) }],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error(
      "patient-summary: model returned no tool_use block (got " +
        response.content.map((b) => b.type).join(",") +
        ")",
    );
  }
  const parsed = SummaryOutput.safeParse(block.input);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues, noteId: input.noteId },
      "patient-summary: tool_use output failed Zod validation",
    );
    throw new Error("patient-summary: malformed tool output");
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------

export async function generatePatientSummary(
  input: SummaryGeneratorInput,
): Promise<{ result: PatientSummaryResult; source: "ai" | "stub" }> {
  const forceMode = process.env["PATIENT_SUMMARY"];
  const hasKey = !!process.env["ANTHROPIC_API_KEY"];
  const useReal =
    forceMode === "ai" ||
    (forceMode !== "stub" && forceMode !== "off" && hasKey);
  if (!useReal) return { result: stubGenerate(input), source: "stub" };
  try {
    return { result: await realGenerate(input), source: "ai" };
  } catch (err) {
    logger.warn(
      { err, noteId: input.noteId },
      "patient-summary: real AI call failed, degrading to stub",
    );
    return { result: stubGenerate(input), source: "stub" };
  }
}
