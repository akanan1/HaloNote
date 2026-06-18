import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { z } from "@workspace/api-zod";
import type { Encounter } from "@workspace/db";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// What is this?
//
// The gap analyzer is a second pass over an already-generated note. It is
// NOT a transcription or note-generation step — it reads the body of the
// note (and the encounter's visit-type context) and asks: "what should
// this kind of visit document that this note doesn't?"
//
// The output is a list of structured gaps with severity. The provider
// reviews them before signing the note. This is the spec's
// "Possible Missing Information" feature (§6) — the differentiator
// that separates a transcription service from a careful clinical
// assistant.
//
// Severity:
//   info  — surfacing for awareness; not a defect ("ROS not documented;
//           may be intentional for a focused follow-up.")
//   warn  — should be addressed; common compliance / quality issue
//           ("Allergy status not mentioned. Many payers require this
//            on every visit.")
//   block — clinically critical or compliance-required ("Time-based
//           E&M selected but total time not stated. Cannot bill as time-
//           based without it.")
//
// 'block' is rendered red and the UI does not let the provider mark the
// note approved until it's addressed; 'warn' shows amber but lets the
// provider acknowledge and proceed.
// ---------------------------------------------------------------------------

const Gap = z.object({
  // Short machine-stable label for the kind of gap so future cross-
  // encounter analytics can group ("allergies_not_documented happens
  // on 30% of bob's visits"). Free-form for now to avoid forcing a
  // taxonomy before we know what the AI actually surfaces.
  field: z.string().min(1).max(80),
  // Sentence shown to the provider. Should NAME what's missing rather
  // than vaguely describe completeness ("Allergy status not mentioned"
  // is better than "Documentation may be incomplete").
  message: z.string().min(1).max(500),
  // Specific suggested action. Phrased as something the provider can
  // copy-paste or speak: "No known drug allergies." not "Document allergies".
  suggestedResolution: z.string().min(1).max(500).optional(),
  // Where in the note the gap lives, so the UI can scroll the provider
  // to the relevant section. Free text matching whatever headings the
  // note actually uses ("HPI", "Assessment", "Plan", "ROS", …).
  locationHint: z.string().max(60).optional(),
  severity: z.enum(["info", "warn", "block"]),
});

const AnalyzerOutput = z.object({
  gaps: z.array(Gap).max(20),
  // Free-text one-liner the UI shows when there are no gaps — keeps the
  // "nothing wrong" state from feeling like a bug ("Note covers the
  // expected elements for a follow-up visit.").
  summary: z.string().max(500),
});

export type NoteGap = z.infer<typeof Gap>;
export type GapAnalyzerResult = z.infer<typeof AnalyzerOutput>;

export interface GapAnalyzerInput {
  noteId: string;
  noteBody: string;
  encounter: Pick<Encounter, "visitType" | "customLabel" | "isTelehealth">;
}

// ---------------------------------------------------------------------------
// Stub — deterministic gaps based on simple keyword presence. Safe for
// dev without ANTHROPIC_API_KEY: only flags things the note body
// VERIFIABLY does not mention, never invents content. The provider sees
// the same "ai_unavailable" info gap the billing stub uses, so the
// posture is "AI is offline" not "trust these flags."
// ---------------------------------------------------------------------------

function stubAnalyze(input: GapAnalyzerInput): GapAnalyzerResult {
  const body = input.noteBody.toLowerCase();
  const gaps: NoteGap[] = [
    {
      field: "ai_unavailable",
      message:
        "AI gap analyzer is offline (ANTHROPIC_API_KEY not configured). Flags below are keyword-based only.",
      severity: "info",
    },
  ];

  // The dumb checks: did the note mention allergies / vitals / plan at all?
  // Keyword-presence isn't a clinical signal but it's an honest
  // placeholder until the real analyzer lights up.
  if (!/allerg/.test(body)) {
    gaps.push({
      field: "allergies_not_mentioned",
      message: "Allergy status not mentioned in the note.",
      suggestedResolution: "No known drug allergies.",
      severity: "warn",
    });
  }
  if (!/(plan|f\/u|follow.?up|return)/.test(body)) {
    gaps.push({
      field: "follow_up_not_specified",
      message: "Follow-up cadence is not specified.",
      suggestedResolution: "Return in 4 weeks for re-evaluation.",
      locationHint: "Plan",
      severity: "warn",
    });
  }
  if (
    input.encounter.visitType === "new_patient" &&
    !/(past medical|history|pmh)/.test(body)
  ) {
    gaps.push({
      field: "pmh_not_documented",
      message:
        "New-patient visit but no past medical history block was documented.",
      severity: "warn",
      locationHint: "History",
    });
  }

  return {
    gaps,
    summary:
      gaps.length === 1
        ? "Stub analyzer found no obvious omissions on a keyword sweep."
        : "Stub analyzer flagged the items above. Real AI analysis would produce richer clinical gap detection.",
  };
}

// ---------------------------------------------------------------------------
// Real path — Anthropic with forced tool_use.
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "You are a clinical quality assistant. Given a clinical note, identify",
    "what the note is MISSING or AMBIGUOUS — information the provider",
    "should add or clarify before signing.",
    "",
    "You are NOT a transcription assistant. You do not rewrite the note.",
    "You do not generate diagnoses. You only flag gaps.",
    "",
    "Rules:",
    "  1. Only flag things the note actually doesn't say. Re-read the note",
    "     before flagging; never invent gaps.",
    "  2. Phrase the message to NAME what's missing concretely ('Allergy",
    "     status not mentioned' not 'Documentation may be incomplete').",
    "  3. Where appropriate, supply a `suggestedResolution` the provider",
    "     can paste / speak verbatim. Phrase it as content, not as an",
    "     instruction ('No known drug allergies.' not 'Document allergies.').",
    "  4. severity:",
    "       info  — surfacing for awareness; may be intentional",
    "       warn  — should be addressed; common quality / compliance issue",
    "       block — clinically or billing-critical; cannot sign without",
    "  5. Use 'block' sparingly. Reserve for: missing time on time-based",
    "     E&M, missing dose on a medication mentioned in the plan, missing",
    "     consent on a procedure, missing primary diagnosis on an A&P.",
    "  6. locationHint should match a heading actually used in the note",
    "     when possible (HPI, Assessment, Plan, ROS, etc.).",
    "  7. If the note is genuinely complete for the visit type, return",
    "     gaps: [] and a positive summary. Don't flag for the sake of",
    "     flagging.",
    "  8. You are a SUGGESTION engine. The provider has final authority on",
    "     every clinical decision and what to document.",
  ].join("\n");
}

function buildUserPrompt(input: GapAnalyzerInput): string {
  const visitLabel =
    input.encounter.visitType === "custom"
      ? `custom (${input.encounter.customLabel ?? "unspecified"})`
      : input.encounter.visitType;
  return [
    `Visit type: ${visitLabel}`,
    `Telehealth: ${input.encounter.isTelehealth ? "yes" : "no"}`,
    "",
    "Note body:",
    "```",
    input.noteBody,
    "```",
    "",
    "Analyze the note for gaps now.",
  ].join("\n");
}

const TOOL_SCHEMA: Tool = {
  name: "submit_note_gaps",
  description:
    "Submit the final list of gaps in the note. Use gaps:[] when the note is complete.",
  input_schema: {
    type: "object",
    properties: {
      gaps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string" },
            message: { type: "string" },
            suggestedResolution: { type: "string" },
            locationHint: { type: "string" },
            severity: { type: "string", enum: ["info", "warn", "block"] },
          },
          required: ["field", "message", "severity"],
        },
      },
      summary: { type: "string" },
    },
    required: ["gaps", "summary"],
  },
};

async function realAnalyze(input: GapAnalyzerInput): Promise<GapAnalyzerResult> {
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
      "note-gap-analyzer: model returned no tool_use block (got " +
        response.content.map((b) => b.type).join(",") +
        ")",
    );
  }
  const parsed = AnalyzerOutput.safeParse(block.input);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues, noteId: input.noteId },
      "note-gap-analyzer: tool_use output failed Zod validation",
    );
    throw new Error("note-gap-analyzer: malformed tool output");
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Public surface — same dispatch shape as billing/order/task suggesters.
// ---------------------------------------------------------------------------

export async function analyzeNoteGaps(
  input: GapAnalyzerInput,
): Promise<{ result: GapAnalyzerResult; source: "ai" | "stub" }> {
  const forceMode = process.env["NOTE_GAP_ANALYZER"];
  const hasKey = !!process.env["ANTHROPIC_API_KEY"];
  const useReal =
    forceMode === "ai" ||
    (forceMode !== "stub" && forceMode !== "off" && hasKey);
  if (!useReal) return { result: stubAnalyze(input), source: "stub" };
  try {
    return { result: await realAnalyze(input), source: "ai" };
  } catch (err) {
    logger.warn(
      { err, noteId: input.noteId },
      "note-gap-analyzer: real AI call failed, degrading to stub",
    );
    return { result: stubAnalyze(input), source: "stub" };
  }
}
