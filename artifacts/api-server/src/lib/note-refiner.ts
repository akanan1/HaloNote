import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { z } from "@workspace/api-zod";
import type { Encounter } from "@workspace/db";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Conversational note refinement.
//
// Provider issues a natural-language instruction; the AI rewrites the
// note body. This is the surface other AI scribes ship as a premium
// "polish your note" feature: 'make the assessment shorter', 'add a
// ROS as negative except as noted', 'soften the tone in the HPI'.
//
// Safety posture:
//   - Only runs on DRAFT notes. The route gates on this.
//   - The system prompt forbids adding clinical content the provider
//     didn't speak / type. Refinement is STYLISTIC + STRUCTURAL —
//     reordering, shortening, expanding given content. It is NOT a
//     replacement for the provider's clinical judgment.
//   - The AI returns the full new body PLUS a one-line summary of
//     what changed. The summary is what the toast / audit log shows.
// ---------------------------------------------------------------------------

const RefinerOutput = z.object({
  // Full replacement body. The route persists this verbatim.
  newBody: z.string().min(1).max(50_000),
  // One-line description of what changed. Phrased as completed action
  // ('Tightened the assessment from 6 to 3 sentences.' not 'Will tighten…').
  // Shown to the provider as a toast and recorded in audit.
  changeSummary: z.string().min(1).max(300),
});

export type RefinerResult = z.infer<typeof RefinerOutput>;

export interface RefinerInput {
  noteId: string;
  body: string;
  instruction: string;
  encounter: Pick<Encounter, "visitType" | "customLabel" | "isTelehealth">;
}

// ---------------------------------------------------------------------------
// Stub — surface the instruction in a marker block at the top of the
// body so the round-trip is verifiable without an Anthropic key. Does
// NOT attempt to actually refine; clinical content stays intact.
// ---------------------------------------------------------------------------

function stubRefine(input: RefinerInput): RefinerResult {
  const marker =
    `[Stub note-refiner: AI is offline. Instruction was: "${input.instruction.slice(0, 200)}". ` +
    "Body returned unchanged below.]\n\n";
  return {
    newBody: marker + input.body,
    changeSummary:
      "Stub refiner — no changes made. Set ANTHROPIC_API_KEY for real refinement.",
  };
}

// ---------------------------------------------------------------------------
// Real path — Anthropic with forced tool_use.
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "You are a clinical documentation editor. Given a provider's clinical",
    "note and a natural-language instruction, return the revised full",
    "note body that satisfies the instruction.",
    "",
    "CRITICAL — DO NOT ADD CLINICAL CONTENT THE PROVIDER DID NOT SPEAK OR TYPE.",
    "You may reorder, reword, shorten, expand existing content, or change",
    "structure (section headings, bullet style). You may NOT invent",
    "symptoms, diagnoses, exam findings, treatment plans, dosing, follow-up",
    "timing, or labs. If the instruction asks for content that isn't in",
    "the original ('add a ROS' when no ROS was discussed), return the note",
    "unchanged and explain in changeSummary that the requested content",
    "isn't supported by the visit and the provider should add it themselves.",
    "",
    "Rules:",
    "  1. Return the FULL new body, not just the changed sections. The",
    "     route replaces the note body verbatim.",
    "  2. Preserve clinical accuracy. Never paraphrase in a way that",
    "     changes meaning.",
    "  3. Preserve standard SOAP / HPI / Assessment / Plan section names",
    "     when present. Don't rename them unless the instruction asks.",
    "  4. Preserve numbers and dosages exactly as written ('500 mg' stays",
    "     '500 mg', not '500mg' or 'half a gram').",
    "  5. Preserve drug names exactly. Don't translate brand to generic",
    "     or vice versa.",
    "  6. Plain text. Don't add markdown unless the original used it.",
    "  7. changeSummary: one sentence, past tense, naming what changed.",
    "     'Shortened the assessment from 6 sentences to 3.' is good.",
    "     'Refined.' is not.",
    "  8. If the instruction is unclear or harmful, return the body",
    "     unchanged with a changeSummary explaining why.",
  ].join("\n");
}

function buildUserPrompt(input: RefinerInput): string {
  const visitLabel =
    input.encounter.visitType === "custom"
      ? `custom (${input.encounter.customLabel ?? "unspecified"})`
      : input.encounter.visitType;
  return [
    `Visit type: ${visitLabel}`,
    `Telehealth: ${input.encounter.isTelehealth ? "yes" : "no"}`,
    "",
    "Original note body:",
    "```",
    input.body,
    "```",
    "",
    `Provider's instruction: ${input.instruction}`,
    "",
    "Return the revised body now.",
  ].join("\n");
}

const TOOL_SCHEMA: Tool = {
  name: "submit_refined_note",
  description: "Submit the revised note body and a one-line change summary.",
  input_schema: {
    type: "object",
    properties: {
      newBody: { type: "string" },
      changeSummary: { type: "string" },
    },
    required: ["newBody", "changeSummary"],
  },
};

async function realRefine(input: RefinerInput): Promise<RefinerResult> {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: buildSystemPrompt(),
    tools: [TOOL_SCHEMA],
    tool_choice: { type: "tool", name: TOOL_SCHEMA.name },
    messages: [{ role: "user", content: buildUserPrompt(input) }],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error(
      "note-refiner: model returned no tool_use block (got " +
        response.content.map((b) => b.type).join(",") +
        ")",
    );
  }
  const parsed = RefinerOutput.safeParse(block.input);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues, noteId: input.noteId },
      "note-refiner: tool_use output failed Zod validation",
    );
    throw new Error("note-refiner: malformed tool output");
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------

export async function refineNote(
  input: RefinerInput,
): Promise<{ result: RefinerResult; source: "ai" | "stub" }> {
  const forceMode = process.env["NOTE_REFINER"];
  const hasKey = !!process.env["ANTHROPIC_API_KEY"];
  const useReal =
    forceMode === "ai" ||
    (forceMode !== "stub" && forceMode !== "off" && hasKey);
  if (!useReal) return { result: stubRefine(input), source: "stub" };
  try {
    return { result: await realRefine(input), source: "ai" };
  } catch (err) {
    logger.warn(
      { err, noteId: input.noteId },
      "note-refiner: real AI call failed, degrading to stub",
    );
    return { result: stubRefine(input), source: "stub" };
  }
}
