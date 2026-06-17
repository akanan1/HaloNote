import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources";
import { z } from "@workspace/api-zod";
import { logger } from "./logger";

// Live documentation-completeness nudges. Runs alongside Phase 26's
// billing pass over the same transcript snapshot. Returns short
// reminders about what hasn't been documented yet — encourages the
// provider to cover the unsaid before the visit ends, rather than
// learning about gaps after the structured note generates.
//
// Heuristic categories the prompt is biased toward:
//   - SOAP sections the transcript hasn't reached (e.g. plan not yet
//     discussed, no ROS, no medication reconciliation)
//   - Common chronic-disease modifiers (severity not specified,
//     time of onset not asked, etc.)
//   - Items the provider mentioned would happen ("I'll order labs")
//     but never specified
//
// The list is short on purpose. A long list of nudges mid-visit reads
// as nagging; 1-3 actionable items is the target.

export const LiveNudge = z.object({
  category: z.enum([
    "hpi",
    "ros",
    "exam",
    "assessment",
    "plan",
    "meds",
    "allergies",
    "social",
    "other",
  ]),
  message: z.string().min(1).max(200),
});
export type LiveNudge = z.infer<typeof LiveNudge>;

const LiveNudgesOutput = z.object({
  nudges: z.array(LiveNudge).max(3),
});

const SYSTEM_PROMPT = [
  "You are a clinical documentation assistant listening to an",
  "outpatient encounter as it happens. Identify items that the",
  "provider has NOT covered yet but typically would by this point in",
  "a visit of this kind. Return at most 3 nudges per call — pick the",
  "highest-yield gaps, not every conceivable one.",
  "",
  "Rules:",
  "  1. Only flag genuinely missing items. If the transcript already",
  "     covers a topic (even briefly), do not nudge about it.",
  "  2. Avoid repeating the caller's prior nudges — they're listed in",
  "     the user message under 'Already nudged'.",
  "  3. Each message must be one sentence, imperative, ≤25 words.",
  "  4. Choose 'category' that best matches; use 'other' sparingly.",
  "  5. Don't speculate about findings — only flag missing structure.",
].join("\n");

const TOOL_SCHEMA: Tool = {
  name: "submit_live_nudges",
  description:
    "Submit at most 3 documentation-completeness nudges for the visit-so-far.",
  input_schema: {
    type: "object",
    properties: {
      nudges: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: {
              type: "string",
              enum: [
                "hpi",
                "ros",
                "exam",
                "assessment",
                "plan",
                "meds",
                "allergies",
                "social",
                "other",
              ],
            },
            message: { type: "string" },
          },
          required: ["category", "message"],
        },
      },
    },
    required: ["nudges"],
  },
};

export interface LiveNudgesInput {
  transcript: string;
  alreadyNudged: { category: string; message: string }[];
}

/**
 * Single nudge pass. Returns [] on failure; the streaming pipeline
 * keeps flowing if the model is wedged. Caller debounces.
 */
export async function suggestLiveNudges(
  input: LiveNudgesInput,
): Promise<LiveNudge[]> {
  if (!process.env["ANTHROPIC_API_KEY"]) return [];
  if (input.transcript.trim().length < 150) return [];

  const already = input.alreadyNudged
    .map((n) => `  - [${n.category}] ${n.message}`)
    .join("\n");
  const userPrompt = [
    "Visit-so-far transcript:",
    "```",
    input.transcript,
    "```",
    "",
    already
      ? `Already nudged (do not repeat):\n${already}`
      : "Already nudged: (none yet)",
    "",
    "Return the most useful 0-3 new nudges. Empty array is fine if",
    "the visit's documentation looks complete so far.",
  ].join("\n");

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      tools: [TOOL_SCHEMA],
      tool_choice: { type: "tool", name: TOOL_SCHEMA.name },
      messages: [{ role: "user", content: userPrompt }],
    });
    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") return [];
    const parsed = LiveNudgesOutput.safeParse(block.input);
    if (!parsed.success) {
      logger.warn(
        { issues: parsed.error.issues },
        "live-nudges: malformed tool output, dropping",
      );
      return [];
    }
    return parsed.data.nudges;
  } catch (err) {
    logger.warn({ err }, "live-nudges: call failed");
    return [];
  }
}
