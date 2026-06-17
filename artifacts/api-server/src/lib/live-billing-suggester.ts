import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources";
import { z } from "@workspace/api-zod";
import { logger } from "./logger";

// Live (mid-visit) billing code suggestion. Distinct from the existing
// `billing-suggester.ts`:
//   - takes just the rolling transcript, no encounter or patient ctx
//   - returns a lean shape (no supportingExcerpts, no documentationGaps)
//     because those are chart-finalization concerns and would slow
//     the call down
//   - meant to run repeatedly during the visit, against an incomplete
//     transcript; the canonical post-visit pass over the structured
//     note remains the authority for what actually gets billed.

export const LiveCode = z.object({
  codeSystem: z.enum(["icd10", "cpt", "em", "modifier"]),
  code: z.string().min(1).max(20),
  description: z.string().min(1).max(200),
  rationale: z.string().min(1).max(500),
  confidence: z.enum(["low", "medium", "high"]),
});
export type LiveCode = z.infer<typeof LiveCode>;

const LiveSuggesterOutput = z.object({
  codes: z.array(LiveCode),
});

const SYSTEM_PROMPT = [
  "You are a clinical billing assistant listening to an outpatient",
  "encounter as it happens. The provided transcript is INCOMPLETE — it",
  "is the visit-so-far, not the final note.",
  "",
  "Suggest ICD-10, CPT, E&M-level, and modifier codes that the",
  "transcript clearly supports. Rules:",
  "  1. Only suggest codes the transcript clearly supports. If unsure,",
  "     use confidence='low' rather than omitting the code. Do not",
  "     fabricate findings.",
  "  2. For E&M (codeSystem='em'), suggest at most one code per call.",
  "     The level may shift as the visit unfolds.",
  "  3. Avoid re-suggesting codes the caller has already received —",
  "     they're listed in the user message under 'Already suggested'.",
  "  4. Keep rationale to one sentence. The provider is mid-visit and",
  "     can't read prose.",
  "  5. You are a SUGGESTION engine — the provider has final",
  "     authority over what's billed at the end of the visit.",
].join("\n");

const TOOL_SCHEMA: Tool = {
  name: "submit_live_billing_suggestions",
  description:
    "Submit billing code suggestions for the visit-so-far transcript.",
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

export interface LiveSuggestInput {
  transcript: string;
  alreadySuggested: { codeSystem: string; code: string }[];
}

/**
 * Run a single live-suggestion pass. Returns an empty array on any
 * failure — the streaming pipeline must keep flowing even if the
 * suggester is wedged. Caller is responsible for debouncing.
 */
export async function suggestLiveCodes(
  input: LiveSuggestInput,
): Promise<LiveCode[]> {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    return [];
  }
  if (input.transcript.trim().length < 100) {
    // Below ~100 chars there's almost never enough content to suggest
    // anything but a placeholder code. Skip the model call.
    return [];
  }

  const already = input.alreadySuggested
    .map((s) => `  - ${s.codeSystem}:${s.code}`)
    .join("\n");
  const userPrompt = [
    "Visit-so-far transcript:",
    "```",
    input.transcript,
    "```",
    "",
    already
      ? `Already suggested (do not repeat):\n${already}`
      : "Already suggested: (none yet)",
    "",
    "Produce new code suggestions now. Return an empty array if no",
    "additional codes are warranted yet.",
  ].join("\n");

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      tools: [TOOL_SCHEMA],
      tool_choice: { type: "tool", name: TOOL_SCHEMA.name },
      messages: [{ role: "user", content: userPrompt }],
    });
    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") return [];
    const parsed = LiveSuggesterOutput.safeParse(block.input);
    if (!parsed.success) {
      logger.warn(
        { issues: parsed.error.issues },
        "live-billing: malformed tool output, dropping",
      );
      return [];
    }
    return parsed.data.codes;
  } catch (err) {
    logger.warn({ err }, "live-billing: suggestion call failed");
    return [];
  }
}
