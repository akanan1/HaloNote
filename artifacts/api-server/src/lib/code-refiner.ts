// Per-code refinement pass. Given a single coding suggestion + the
// note's parsed sections, asks Claude for 1-3 alternative codes that
// are MORE SPECIFIC than the original.
//
// HaloNote's twist (vs CarePilot's plain refine):
//   1. HCC delta — every alternative is labeled with whether it
//      UNLOCKS an HCC bucket the original didn't capture. The UI
//      surfaces this prominently so the provider sees the revenue
//      lever, not just a longer ICD-10 code.
//   2. Documentation-gap mode — when a more specific code exists but
//      the note doesn't currently support it, the refiner still
//      returns it, with `evidenceMode='documentation_gap'` and a
//      one-sentence `suggestedNoteLanguage` the provider could add
//      to support the code. Turns refinement into a doc-quality
//      coaching loop instead of a quiet code swap.
//
// Falls back to a deterministic stub when ANTHROPIC_API_KEY is unset
// or CODING_SUGGESTER=stub. The stub returns no refinements — better
// to surface nothing than to fabricate a more-specific code.

import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { z } from "@workspace/api-zod";
import { logger } from "./logger";
import type { ParsedNoteSections } from "./note-section-parser";

const SupportingExcerpt = z.object({
  text: z.string().min(1).max(2000),
  locationHint: z.string().max(60).optional(),
});

// One refinement option. The shape covers both modes:
//   evidenceMode='supported'         — the note text justifies this
//                                      more-specific code; supportingExcerpts
//                                      quotes the supporting passage.
//   evidenceMode='documentation_gap' — note doesn't currently support it;
//                                      suggestedNoteLanguage carries the
//                                      one-sentence addition that would.
const RefinementOption = z.object({
  code: z.string().min(1).max(20),
  description: z.string().min(1).max(300),
  // Always present so the UI can render a single ranked list.
  evidenceMode: z.enum(["supported", "documentation_gap"]),
  // Required when evidenceMode='supported'. Empty array allowed when
  // doc-gap, since the whole point is the note doesn't say it (yet).
  supportingExcerpts: z.array(SupportingExcerpt).max(6).default([]),
  // Required when evidenceMode='documentation_gap'. One short
  // sentence the provider could paste into their note to justify
  // the code. Phrased as clinical documentation, not advice.
  suggestedNoteLanguage: z.string().max(500).optional(),
  // Free-text rationale: why this code is more specific, and what
  // clinical signal it captures that the original didn't.
  rationale: z.string().min(1).max(1500),
  // HCC bucket if the refined code maps to one. Empty string when
  // the refined code is HCC-neutral.
  hccCategory: z.string().max(200).optional(),
  // True when this refinement CAPTURES an HCC bucket the ORIGINAL
  // code did not. Drives the "Unlocks HCC X" badge in the UI.
  hccUnlocked: z.boolean(),
  // Confidence in the clinical accuracy of THIS specific refinement
  // (separate from whether documentation supports it — see evidenceMode).
  confidence: z.enum(["low", "medium", "high"]),
});

const RefinerOutput = z.object({
  options: z.array(RefinementOption).max(5),
});

export type RefinementOption = z.infer<typeof RefinementOption>;
export type RefinerResult = z.infer<typeof RefinerOutput>;

export interface CodeRefinerInput {
  originalCode: string;
  originalDescription: string;
  originalHccCategory: string | null;
  // Which code system the suggestion belongs to. Only icd10 + cpt
  // refine meaningfully (modifiers don't refine; E&M has its own
  // 5-level surface). The orchestrator pre-filters.
  codeSystem: "icd10" | "cpt";
  sections: ParsedNoteSections;
}

// ---------------------------------------------------------------------------
// Stub path — emit nothing. NEVER fabricate a more-specific code; an
// incorrect refinement that a tired provider click-accepts is a real
// patient-billing harm vector.
// ---------------------------------------------------------------------------

function stubRefine(): RefinerResult {
  return { options: [] };
}

// ---------------------------------------------------------------------------
// Real path — Anthropic with forced tool_use.
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "You are a clinical coding specificity refiner. Given a single ICD-10",
    "or CPT code suggestion plus the source note's parsed sections, your job",
    "is to propose alternative codes that are MORE SPECIFIC than the original,",
    "ranked by clinical value.",
    "",
    "Two modes of evidence — set evidenceMode on every option:",
    "",
    "  supported           — the note text already justifies the more-specific",
    "                        code. supportingExcerpts MUST quote the note",
    "                        passage(s) that justify it, verbatim.",
    "",
    "  documentation_gap   — the more-specific code is clinically plausible",
    "                        from context, but the note doesn't currently",
    "                        document the necessary detail. Set",
    "                        suggestedNoteLanguage to ONE short clinical",
    "                        sentence the provider could add to justify",
    "                        the code (e.g. \"A1c 8.3 with documented",
    "                        polyneuropathy on exam\"). DO NOT phrase it as",
    "                        advice; phrase it as a clinical finding so the",
    "                        provider can paste it.",
    "",
    "HCC awareness — set hccUnlocked=true ONLY when the refined code maps to",
    "an HCC bucket the original code did NOT capture. Set hccCategory to the",
    "bucket label (e.g. \"HCC 18 — Diabetes with Chronic Complications\").",
    "When the refinement is HCC-neutral, hccUnlocked=false and hccCategory",
    "can be omitted.",
    "",
    "Hard rules:",
    "  1. NEVER propose a refinement less specific than the original.",
    "  2. NEVER propose the same code as the original.",
    "  3. NEVER fabricate clinical findings. For supported mode, the excerpt",
    "     must actually appear in the note. For doc-gap mode, the suggested",
    "     language must reflect plausible clinical reality, not invented",
    "     details to justify upcoding.",
    "  4. Rank options by: HCC unlock first (if any), then specificity gain,",
    "     then evidence strength (supported > documentation_gap).",
    "  5. Return 0-3 options. If no plausible refinement exists, return an",
    "     empty list — don't pad.",
    "  6. You are a SUGGESTION engine. The provider has final authority.",
  ].join("\n");
}

function buildUserPrompt(input: CodeRefinerInput): string {
  const sectionBlocks: string[] = [];
  const s = input.sections;
  const pushIf = (label: string, text: string | undefined) => {
    if (text && text.trim()) sectionBlocks.push(`### ${label}\n${text.trim()}`);
  };
  pushIf("Assessment", s.assessment);
  pushIf("Plan", s.plan);
  pushIf("HPI", s.hpi);
  pushIf("ROS", s.ros);
  pushIf("Physical Exam", s.physicalExam);
  pushIf("MDM", s.mdm);
  pushIf("Other / Unstructured", s.other);

  const originalHcc = input.originalHccCategory
    ? `HCC: ${input.originalHccCategory}`
    : "HCC: none (no HCC capture today)";

  return [
    "Current code (the one to refine):",
    `  Code system: ${input.codeSystem}`,
    `  Code: ${input.originalCode}`,
    `  Description: ${input.originalDescription}`,
    `  ${originalHcc}`,
    "",
    "Note sections:",
    "```",
    sectionBlocks.length > 0
      ? sectionBlocks.join("\n\n")
      : "(no parsed sections available)",
    "```",
    "",
    "Produce up to 3 ranked refinement options now. Empty list if none.",
  ].join("\n");
}

const TOOL_SCHEMA: Tool = {
  name: "submit_code_refinements",
  description:
    "Submit ranked refinement options for the given code, or an empty list if no plausible refinement exists.",
  input_schema: {
    type: "object",
    properties: {
      options: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: { type: "string" },
            description: { type: "string" },
            evidenceMode: {
              type: "string",
              enum: ["supported", "documentation_gap"],
            },
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
            suggestedNoteLanguage: { type: "string" },
            rationale: { type: "string" },
            hccCategory: { type: "string" },
            hccUnlocked: { type: "boolean" },
            confidence: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: [
            "code",
            "description",
            "evidenceMode",
            "rationale",
            "hccUnlocked",
            "confidence",
          ],
        },
      },
    },
    required: ["options"],
  },
};

async function realRefine(input: CodeRefinerInput): Promise<RefinerResult> {
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
    throw new Error("code-refiner: model returned no tool_use block");
  }
  const parsed = RefinerOutput.safeParse(block.input);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues },
      "code-refiner: tool output failed Zod validation",
    );
    throw new Error("code-refiner: malformed tool output");
  }
  return parsed.data;
}

export async function refineCode(
  input: CodeRefinerInput,
): Promise<{ result: RefinerResult; source: "ai" | "stub" }> {
  // Shares the same CODING_SUGGESTER env switch as the other Coder AI
  // surfaces — one dial controls the whole feature in dev.
  const forceMode = process.env["CODING_SUGGESTER"];
  const hasKey = !!process.env["ANTHROPIC_API_KEY"];
  const useReal =
    forceMode === "ai" ||
    (forceMode !== "stub" && forceMode !== "off" && hasKey);

  if (!useReal) return { result: stubRefine(), source: "stub" };

  try {
    const result = await realRefine(input);
    return { result, source: "ai" };
  } catch (err) {
    logger.warn(
      { err, originalCode: input.originalCode },
      "code-refiner: AI call failed, returning empty refinements",
    );
    return { result: stubRefine(), source: "stub" };
  }
}
