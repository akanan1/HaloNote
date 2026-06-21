// Problem-list reconciler. Given:
//   - the patient's current problem-list cache (post-sync),
//   - the ICD-10 codes the Coder pulled from the note's Assessment,
//   - the assessment + plan section text,
// produces a list of proposed actions: add, update_status, resolve,
// merge_duplicate, flag_uncertain.
//
// LLM-based because the status-change inference ("worsening" vs "stable")
// requires reading the assessment narrative. Deterministic stub mode
// (CODING_SUGGESTER=stub) emits naive add-only suggestions so dev/tests
// still exercise the persistence + UI plumbing.

import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { z } from "@workspace/api-zod";
import type {
  PatientProblem,
  ProblemSuggestionAction,
  ProblemStatus,
} from "@workspace/db";
import { logger } from "./logger";

const SupportingExcerpt = z.object({
  text: z.string().min(1).max(2000),
  locationHint: z.string().max(60).optional(),
});

const ReconciliationAction = z.object({
  action: z.enum([
    "add",
    "update_status",
    "resolve",
    "merge_duplicate",
    "flag_uncertain",
  ]),
  // For add: the new ICD-10 code + description.
  // For update_status / resolve: the existing code we're updating.
  // For merge_duplicate: the "keep" code; mergeFromCode is the duplicate.
  // For flag_uncertain: the code in question.
  code: z.string().max(20),
  description: z.string().max(300),
  proposedStatus: z
    .enum(["active", "stable", "worsening", "improving", "resolved"])
    .optional(),
  // Only for merge_duplicate. The duplicate ICD-10 code to retire.
  mergeFromCode: z.string().max(20).optional(),
  rationale: z.string().min(1).max(2000),
  supportingExcerpts: z.array(SupportingExcerpt).max(8).default([]),
  confidence: z.enum(["low", "medium", "high"]),
});

const ReconcilerOutput = z.object({
  actions: z.array(ReconciliationAction).max(40),
});

export type ReconcilerAction = z.infer<typeof ReconciliationAction>;
export type ReconcilerResult = z.infer<typeof ReconcilerOutput>;

export interface ReconcilerInput {
  // Current local cache (post-sync) — what the EHR thinks the patient
  // has today.
  currentProblems: Array<
    Pick<PatientProblem, "id" | "code" | "description" | "status">
  >;
  // ICD-10 codes the Coder pulled from this encounter's note.
  noteIcd10Codes: Array<{ code: string; description: string }>;
  // Assessment + plan section text. The reconciler reads this for
  // status-change inference ("worsening", "stable", "resolved").
  assessmentText: string;
  planText: string;
}

// ---------------------------------------------------------------------------
// Stub path — emits naive "add" for every note ICD that isn't already in
// the cache. No status inference. Honest and harmless.
// ---------------------------------------------------------------------------

function stubReconcile(input: ReconcilerInput): ReconcilerResult {
  const existing = new Set(input.currentProblems.map((p) => p.code));
  const actions: ReconcilerAction[] = [];
  for (const c of input.noteIcd10Codes) {
    if (existing.has(c.code)) continue;
    actions.push({
      action: "add",
      code: c.code,
      description: c.description,
      rationale:
        "Stub reconciler: ICD code present in note, not yet on the " +
        "problem list. The real reconciler would inspect the assessment " +
        "for status nuance and duplicate-merge opportunities.",
      supportingExcerpts: [],
      confidence: "low",
    });
  }
  return { actions };
}

// ---------------------------------------------------------------------------
// Real path — Anthropic with forced tool_use.
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "You are a clinical problem-list reconciler. Given a patient's current",
    "problem list and the ICD-10 codes extracted from today's encounter note,",
    "propose deltas the clinician should apply to the chart.",
    "",
    "Action rules:",
    "  - 'add' — note documents a NEW diagnosis not already on the list.",
    "    Provide the ICD-10 code + description.",
    "  - 'update_status' — existing problem; the note documents a change.",
    "    Use proposedStatus from: active, stable, worsening, improving.",
    "    Quote the note text that supports the change in supportingExcerpts.",
    "  - 'resolve' — note explicitly documents resolution (\"resolved\",",
    "    \"cured\", \"no longer present\"). proposedStatus must be 'resolved'.",
    "  - 'merge_duplicate' — two existing problems are the same condition",
    "    coded differently. 'code' is the one to KEEP; mergeFromCode is",
    "    the duplicate to retire. Only emit when you are confident the",
    "    underlying clinical entity is identical.",
    "  - 'flag_uncertain' — note hints at a status change but documentation",
    "    is ambiguous. The clinician decides; you must NOT auto-apply.",
    "",
    "Hard rules:",
    "  1. Never propose changes the documentation does not support.",
    "  2. Do NOT mark a diagnosis 'resolved' unless the note explicitly says so.",
    "  3. Past-history mentions are NOT grounds for a status change — a",
    "     diagnosis mentioned only in PMH stays as-is.",
    "  4. supportingExcerpts must quote the note verbatim.",
    "  5. Confidence: 'high' only when the note text is explicit; 'low'",
    "     when you're inferring; never fabricate.",
    "  6. You are a SUGGESTION engine. The clinician has final authority.",
  ].join("\n");
}

function buildUserPrompt(input: ReconcilerInput): string {
  const problemsBlock =
    input.currentProblems.length === 0
      ? "(empty — no problems on the chart yet)"
      : input.currentProblems
          .map((p) => `  - ${p.code} (${p.status}): ${p.description}`)
          .join("\n");

  const notesCodesBlock =
    input.noteIcd10Codes.length === 0
      ? "(none extracted from this note)"
      : input.noteIcd10Codes
          .map((c) => `  - ${c.code}: ${c.description}`)
          .join("\n");

  return [
    "Current problem list:",
    problemsBlock,
    "",
    "ICD-10 codes the coder extracted from today's note:",
    notesCodesBlock,
    "",
    "Assessment section:",
    "```",
    input.assessmentText || "(empty)",
    "```",
    "",
    "Plan section:",
    "```",
    input.planText || "(empty)",
    "```",
    "",
    "Produce the reconciliation actions now.",
  ].join("\n");
}

const TOOL_SCHEMA: Tool = {
  name: "submit_problem_list_actions",
  description:
    "Submit the reconciliation deltas against the patient's problem list.",
  input_schema: {
    type: "object",
    properties: {
      actions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [
                "add",
                "update_status",
                "resolve",
                "merge_duplicate",
                "flag_uncertain",
              ],
            },
            code: { type: "string" },
            description: { type: "string" },
            proposedStatus: {
              type: "string",
              enum: [
                "active",
                "stable",
                "worsening",
                "improving",
                "resolved",
              ],
            },
            mergeFromCode: { type: "string" },
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
            confidence: { type: "string", enum: ["low", "medium", "high"] },
          },
          required: [
            "action",
            "code",
            "description",
            "rationale",
            "confidence",
          ],
        },
      },
    },
    required: ["actions"],
  },
};

async function realReconcile(
  input: ReconcilerInput,
): Promise<ReconcilerResult> {
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
      "problem-list-reconciler: model returned no tool_use block",
    );
  }
  const parsed = ReconcilerOutput.safeParse(block.input);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues },
      "problem-list-reconciler: tool output failed Zod validation",
    );
    throw new Error("problem-list-reconciler: malformed tool output");
  }
  return parsed.data;
}

export async function reconcileProblemList(
  input: ReconcilerInput,
): Promise<{ result: ReconcilerResult; source: "ai" | "stub" }> {
  // Shares CODING_SUGGESTER flag — same dial controls the whole Coder
  // AI surface. Provider only needs to remember one env var.
  const forceMode = process.env["CODING_SUGGESTER"];
  const hasKey = !!process.env["ANTHROPIC_API_KEY"];
  const useReal =
    forceMode === "ai" ||
    (forceMode !== "stub" && forceMode !== "off" && hasKey);

  if (!useReal) {
    return { result: stubReconcile(input), source: "stub" };
  }
  try {
    const result = await realReconcile(input);
    return { result, source: "ai" };
  } catch (err) {
    logger.warn(
      { err },
      "problem-list-reconciler: AI call failed, degrading to stub",
    );
    return { result: stubReconcile(input), source: "stub" };
  }
}

// Re-export the action enum for the routes layer.
export type { ProblemSuggestionAction, ProblemStatus };
