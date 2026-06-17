import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources";
import { z } from "@workspace/api-zod";
import { logger } from "./logger";

// Live clinical decision support (CDS). Runs alongside Phase 26's
// billing pass and Phase 27's nudges over the same growing transcript.
// Job: flag drug-allergy interactions, duplicate therapy, drug-drug
// interactions, and dose/route concerns against the patient's active
// chart — surfaced to the provider WHILE the visit is in progress so
// a problem catches at the point of decision rather than after the
// note structures.
//
// Patient-safety code. The model can hallucinate; the system prompt is
// deliberately strict about only flagging what's clearly proposed in
// the transcript, and the bridge dedupes on (kind, message) so alarm
// fatigue doesn't undermine real warnings.

export const LiveCdsWarning = z.object({
  kind: z.enum([
    "allergy_interaction",
    "drug_drug_interaction",
    "duplicate_therapy",
    "dose_warning",
    "other",
  ]),
  severity: z.enum(["info", "warn", "block"]),
  message: z.string().min(1).max(280),
  focus: z.string().max(120).optional(),
});
export type LiveCdsWarning = z.infer<typeof LiveCdsWarning>;

const LiveCdsOutput = z.object({
  warnings: z.array(LiveCdsWarning),
});

const SYSTEM_PROMPT = [
  "You are a clinical decision support assistant listening to an",
  "outpatient encounter as it happens. You receive the visit-so-far",
  "transcript plus the patient's current chart context (active",
  "medications, allergies, active conditions).",
  "",
  "Job: flag drug-allergy interactions, drug-drug interactions,",
  "duplicate therapy, and dose / route concerns — but ONLY when the",
  "provider is clearly proposing a medication, dose change, or",
  "specific clinical action in the transcript. Do not warn about",
  "hypothetical or already-stable regimens.",
  "",
  "Rules:",
  "  1. Only flag if the transcript clearly proposes a medication or",
  "     action. Don't fabricate findings. If unsure, omit.",
  "  2. Use severity='block' ONLY for life-threatening contraindications",
  "     (e.g. anaphylaxis-risk allergy, contraindicated drug-drug",
  "     combination). 'warn' for moderate concerns. 'info' for nudges.",
  "  3. Avoid re-firing warnings the caller has already received —",
  "     they're listed in the user message under 'Already fired'.",
  "  4. Keep each message to one sentence, ≤40 words, actionable.",
  "  5. 'focus' is an optional short label naming the offending drug,",
  "     allergen, or interaction (e.g. 'amoxicillin + penicillin allergy').",
  "  6. You are an advisor — the provider has final clinical authority.",
].join("\n");

const TOOL_SCHEMA: Tool = {
  name: "submit_live_cds_warnings",
  description:
    "Submit clinical decision support warnings for the visit-so-far transcript and chart.",
  input_schema: {
    type: "object",
    properties: {
      warnings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: {
              type: "string",
              enum: [
                "allergy_interaction",
                "drug_drug_interaction",
                "duplicate_therapy",
                "dose_warning",
                "other",
              ],
            },
            severity: {
              type: "string",
              enum: ["info", "warn", "block"],
            },
            message: { type: "string" },
            focus: { type: "string" },
          },
          required: ["kind", "severity", "message"],
        },
      },
    },
    required: ["warnings"],
  },
};

export interface LiveCdsChart {
  /** Short med strings, e.g. "Lisinopril 20 mg tablet — 1 tab PO daily". */
  activeMeds: string[];
  /** Short allergy strings, e.g. "Penicillin (moderate, hives)". */
  allergies: string[];
  /** Short condition strings, e.g. "Essential hypertension". */
  conditions: string[];
}

export interface LiveCdsInput {
  transcript: string;
  chart: LiveCdsChart;
  alreadyFired: { kind: string; message: string }[];
}

function chartIsEmpty(chart: LiveCdsChart): boolean {
  return (
    chart.activeMeds.length === 0 &&
    chart.allergies.length === 0 &&
    chart.conditions.length === 0
  );
}

/**
 * Filter a fresh batch of warnings against the already-fired list.
 * Exported for unit testing — the bridge also calls this shape via
 * inline filtering, but the algorithm lives here so it's covered.
 */
export function filterAlreadyFired(
  warnings: LiveCdsWarning[],
  alreadyFired: { kind: string; message: string }[],
): LiveCdsWarning[] {
  if (alreadyFired.length === 0) return warnings;
  return warnings.filter(
    (w) =>
      !alreadyFired.some(
        (k) => k.kind === w.kind && k.message === w.message,
      ),
  );
}

/**
 * Single CDS pass. Returns [] on any failure — the streaming pipeline
 * must keep flowing even if the model is wedged. The caller debounces.
 *
 * Skips the model call when the transcript is too short to contain a
 * proposal OR when the chart is empty (nothing to check against). This
 * makes CDS opt-out by data shape: a patient with no fetched chart
 * never triggers an LLM call.
 */
export async function suggestLiveCdsWarnings(
  input: LiveCdsInput,
): Promise<LiveCdsWarning[]> {
  if (!process.env["ANTHROPIC_API_KEY"]) return [];
  if (input.transcript.trim().length < 150) return [];
  if (chartIsEmpty(input.chart)) return [];

  const fmtList = (label: string, items: string[]): string => {
    if (items.length === 0) return `${label}: (none on file)`;
    return [`${label}:`, ...items.map((s) => `  - ${s}`)].join("\n");
  };

  const already = input.alreadyFired
    .map((w) => `  - [${w.kind}] ${w.message}`)
    .join("\n");
  const userPrompt = [
    "Patient chart context:",
    fmtList("Active medications", input.chart.activeMeds),
    fmtList("Allergies", input.chart.allergies),
    fmtList("Active conditions", input.chart.conditions),
    "",
    "Visit-so-far transcript:",
    "```",
    input.transcript,
    "```",
    "",
    already
      ? `Already fired (do not repeat):\n${already}`
      : "Already fired: (none yet)",
    "",
    "Return 0+ warnings now. Empty array is fine if the transcript",
    "doesn't clearly propose anything that conflicts with the chart.",
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
    const parsed = LiveCdsOutput.safeParse(block.input);
    if (!parsed.success) {
      logger.warn(
        { issues: parsed.error.issues },
        "live-cds: malformed tool output, dropping",
      );
      return [];
    }
    return parsed.data.warnings;
  } catch (err) {
    logger.warn({ err }, "live-cds: suggestion call failed");
    return [];
  }
}
