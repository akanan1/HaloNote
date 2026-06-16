import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { z } from "@workspace/api-zod";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Vital-sign extraction.
//
// Reads a clinical note body and extracts the vital-sign values mentioned.
// Returns each as a structured number plus the verbatim source phrase so
// the provider can verify ("BP 142/88" → systolic: 142, diastolic: 88,
// source: "BP was 142/88"). Demonstrates the AI understands clinical
// content rather than just transcribing it.
//
// US units (mmHg / bpm / °F / lbs / inches) for v1 — the pilot is a US
// primary-care doctor. v2 adds a units field per vital so SI / metric
// shops can flip the rendering.
//
// Safety posture:
//   - Only extract values the note CLEARLY states. If unsure, omit.
//   - Never compute a value the note doesn't have (don't derive BMI
//     from height + weight unless the note literally says "BMI 27").
//   - Every extracted value carries its source excerpt so the provider
//     can fact-check the extractor against the note.
// ---------------------------------------------------------------------------

// Confidence aligns 1:1 with the suggester / gap analyzer pattern so the
// UI can render the same tone palette across surfaces.
const Confidence = z.enum(["low", "medium", "high"]);

const BloodPressure = z.object({
  systolic: z.number().int().min(40).max(300),
  diastolic: z.number().int().min(20).max(200),
  // Free-text site if specified ("right arm", "supine"). null when not stated.
  position: z.string().max(60).nullable().optional(),
  source: z.string().min(1).max(300),
  confidence: Confidence,
});

const NumericVital = z.object({
  value: z.number(),
  source: z.string().min(1).max(300),
  confidence: Confidence,
});

// Pain is an integer 0-10 most of the time, but the field is sometimes
// described qualitatively. Numeric column handles the common case;
// the source preserves the original phrasing.
const Pain = z.object({
  // 0-10 numeric rating scale when stated. null when only qualitative
  // ("mild aching pain" with no scale).
  score: z.number().min(0).max(10).nullable(),
  source: z.string().min(1).max(300),
  confidence: Confidence,
});

const VitalsOutput = z.object({
  // All fields optional — the extractor returns only what the note
  // actually documents. A missing field means 'not mentioned', NOT
  // 'normal'.
  bp: BloodPressure.optional(),
  heartRate: NumericVital.optional(),
  respiratoryRate: NumericVital.optional(),
  temperatureF: NumericVital.optional(),
  spo2Percent: NumericVital.optional(),
  weightLbs: NumericVital.optional(),
  heightIn: NumericVital.optional(),
  bmi: NumericVital.optional(),
  pain: Pain.optional(),
  // Free-text catch-all for vitals not in the explicit list (e.g.
  // glucose, peak flow). Each entry: { label, valueText, source }.
  other: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        valueText: z.string().min(1).max(120),
        source: z.string().min(1).max(300),
      }),
    )
    .max(10),
});

export type VitalsResult = z.infer<typeof VitalsOutput>;

export interface VitalExtractorInput {
  noteId: string;
  noteBody: string;
}

// ---------------------------------------------------------------------------
// Stub — returns no extracted vitals (other: []) with an honest 'AI
// offline' label. Vital extraction without AI would have to be regex-
// based and that has too many false-negative modes for a safety-
// critical surface; better to surface nothing than to confidently miss.
// ---------------------------------------------------------------------------

function stubExtract(): VitalsResult {
  return {
    other: [],
  };
}

// ---------------------------------------------------------------------------
// Real path — Anthropic with forced tool_use.
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "You are a clinical-data extraction assistant. Given a clinical note,",
    "extract the vital signs the note documents and return them as",
    "structured values. Each extracted value MUST include the verbatim",
    "source excerpt that justifies it.",
    "",
    "Rules:",
    "  1. ONLY extract values the note clearly states. If a value is",
    "     ambiguous or absent, omit the field. A missing field means",
    "     'not mentioned' to downstream consumers — never extract a",
    "     normal placeholder.",
    "  2. NEVER compute or infer values the note doesn't have. If",
    "     height and weight are documented but BMI is not, do NOT",
    "     calculate the BMI yourself — leave it out.",
    "  3. Units: assume US units for v1.",
    "       BP: mmHg (e.g. 142/88)",
    "       HR: bpm",
    "       RR: breaths per minute",
    "       Temp: degrees Fahrenheit",
    "       SpO2: percent",
    "       Weight: pounds",
    "       Height: inches",
    "     If the note states a value in metric (e.g. 'temp 37 C'),",
    "     CONVERT to US units and put the original metric value in the",
    "     source excerpt so the provider can verify the conversion.",
    "  4. The `source` field on every extracted value MUST be a verbatim",
    "     quote from the note. Do not paraphrase. The provider uses it",
    "     to fact-check the extraction.",
    "  5. Confidence:",
    "       high  — value explicitly stated in standard form ('BP 142/88')",
    "       medium— stated but in non-standard form ('blood pressure",
    "               was one forty-two over eighty-eight')",
    "       low   — derived from context ('hypertensive at 150'),",
    "               only one value visible, or any ambiguity",
    "  6. For BP, populate position only when the note states it",
    "     ('right arm seated', 'supine').",
    "  7. For pain, populate score with the 0-10 number when stated",
    "     ('pain 5/10' → 5). Leave score null for qualitative descriptions",
    "     ('mild', 'severe') and put the qualitative phrase in source.",
    "  8. `other`: catch-all for vitals not in the explicit list (glucose,",
    "     peak flow, head circumference, FEV1, etc.). label = short name,",
    "     valueText = the number-and-unit string from the note,",
    "     source = verbatim excerpt.",
  ].join("\n");
}

function buildUserPrompt(input: VitalExtractorInput): string {
  return [
    "Note body:",
    "```",
    input.noteBody,
    "```",
    "",
    "Extract the vital signs now.",
  ].join("\n");
}

const TOOL_SCHEMA: Tool = {
  name: "submit_extracted_vitals",
  description:
    "Submit the vital signs extracted from the note. Omit fields the note doesn't document.",
  input_schema: {
    type: "object",
    properties: {
      bp: {
        type: "object",
        properties: {
          systolic: { type: "number" },
          diastolic: { type: "number" },
          position: { type: "string" },
          source: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["systolic", "diastolic", "source", "confidence"],
      },
      heartRate: numericSchema(),
      respiratoryRate: numericSchema(),
      temperatureF: numericSchema(),
      spo2Percent: numericSchema(),
      weightLbs: numericSchema(),
      heightIn: numericSchema(),
      bmi: numericSchema(),
      pain: {
        type: "object",
        properties: {
          score: { type: "number" },
          source: { type: "string" },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
        },
        required: ["source", "confidence"],
      },
      other: {
        type: "array",
        items: {
          type: "object",
          properties: {
            label: { type: "string" },
            valueText: { type: "string" },
            source: { type: "string" },
          },
          required: ["label", "valueText", "source"],
        },
      },
    },
    required: ["other"],
  },
};

function numericSchema(): {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
} {
  return {
    type: "object",
    properties: {
      value: { type: "number" },
      source: { type: "string" },
      confidence: { type: "string", enum: ["low", "medium", "high"] },
    },
    required: ["value", "source", "confidence"],
  };
}

async function realExtract(input: VitalExtractorInput): Promise<VitalsResult> {
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
      "vital-extractor: model returned no tool_use block (got " +
        response.content.map((b) => b.type).join(",") +
        ")",
    );
  }
  const parsed = VitalsOutput.safeParse(block.input);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues, noteId: input.noteId },
      "vital-extractor: tool_use output failed Zod validation",
    );
    throw new Error("vital-extractor: malformed tool output");
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------

export async function extractVitals(
  input: VitalExtractorInput,
): Promise<{ result: VitalsResult; source: "ai" | "stub" }> {
  const forceMode = process.env["VITAL_EXTRACTOR"];
  const hasKey = !!process.env["ANTHROPIC_API_KEY"];
  const useReal =
    forceMode === "ai" ||
    (forceMode !== "stub" && forceMode !== "off" && hasKey);
  if (!useReal) return { result: stubExtract(), source: "stub" };
  try {
    return { result: await realExtract(input), source: "ai" };
  } catch (err) {
    logger.warn(
      { err, noteId: input.noteId },
      "vital-extractor: real AI call failed, degrading to stub",
    );
    return { result: stubExtract(), source: "stub" };
  }
}
