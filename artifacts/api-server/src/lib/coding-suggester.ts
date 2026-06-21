import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { z } from "@workspace/api-zod";
import type { CodeSystem, Encounter, Patient } from "@workspace/db";
import { logger } from "./logger";
import type { ParsedNoteSections } from "./note-section-parser";

// Coder-tier suggester. Differs from billing-suggester in three ways:
//
//   1. Section-aware. Receives the note as parsed sections so the
//      prompt can tell the model "ICDs should come from Assessment;
//      CPT/E&M from Procedures + MDM + Time" instead of dumping the
//      raw note and hoping.
//
//   2. Emits sourceSection per code so the Coder Review UI can show
//      "ICD-10 E11.65 — found in Assessment" with a click-through to
//      the highlighted block.
//
//   3. Emits HCC / RAF metadata for ICD-10 codes when applicable. The
//      live-billing path doesn't need this; the Coder dashboard does.
//
// We keep the existing billing-suggester untouched — it powers the
// always-on /billing/suggest path and the in-encounter live billing
// panel, both of which don't need the heavier output schema.

// ---------------------------------------------------------------------------
// Output schema — wider than billing-suggester's, with section + HCC fields.
// ---------------------------------------------------------------------------

const SupportingExcerpt = z.object({
  text: z.string().min(1).max(2000),
  locationHint: z.string().max(60).optional(),
});

const DocumentationGap = z.object({
  field: z.string().min(1).max(80),
  message: z.string().min(1).max(500),
  severity: z.enum(["info", "warn", "block"]),
});

// Canonical section keys that line up with ParsedNoteSections. Free-
// form on the wire so the AI can also say "other" or fall back to a
// hint string we didn't anticipate; the orchestrator normalizes
// anything outside this set to "other" before persisting.
const SECTION_KEYS = [
  "assessment",
  "plan",
  "hpi",
  "ros",
  "physical_exam",
  "procedures",
  "orders",
  "mdm",
  "time",
  "other",
] as const;
export type SectionKey = (typeof SECTION_KEYS)[number];

const CodingCode = z.object({
  codeSystem: z.enum(["icd10", "cpt", "em", "modifier"]),
  code: z.string().min(1).max(20),
  description: z.string().min(1).max(300),
  rationale: z.string().min(1).max(2000),
  supportingExcerpts: z.array(SupportingExcerpt).max(8).default([]),
  documentationGaps: z.array(DocumentationGap).max(8).default([]),
  confidence: z.enum(["low", "medium", "high"]),
  // Which note section the model cites for this code. Required —
  // we want every code to be traceable to a section.
  sourceSection: z.string().min(1).max(40),
  // HCC bucket for ICD-10 codes the model believes are risk-
  // adjustment-relevant. e.g. "HCC 18 — Diabetes with Chronic
  // Complications". Null/absent for non-diagnosis codes or for
  // diagnoses outside the HCC universe.
  hccCategory: z.string().max(200).optional(),
  // True when the model believes this diagnosis is actively
  // contributing to risk adjustment for the current visit (not
  // merely a historical mention). Drives the "RAF opportunity"
  // dashboard badge.
  rafRelevant: z.boolean().optional(),
});

const CodingOutput = z.object({
  codes: z.array(CodingCode).max(40),
});

export type CodingSuggestedCode = z.infer<typeof CodingCode>;
export type CodingSuggesterResult = z.infer<typeof CodingOutput>;

export interface CodingSuggesterInput {
  encounter: Pick<
    Encounter,
    "id" | "visitType" | "customLabel" | "isTelehealth" | "scheduledAt"
  >;
  patient: Pick<Patient, "id" | "dateOfBirth">;
  // Parsed sections — the orchestrator runs note-section-parser
  // before calling here. If the note had no recognizable headers
  // the orchestrator passes `{ other: <whole note> }`; the prompt
  // tells the model to degrade gracefully in that case.
  sections: ParsedNoteSections;
}

// Deterministic mapping from code system → Athena (or other EHR)
// discrete field destination. The writeback adapter consumes this to
// route each approved code to the right discrete-field API. Stored
// alongside the suggestion so the Coder Review UI can show the
// destination before the provider approves ("ICD-10 E11.65 → Athena
// encounter diagnosis").
export function destinationFieldFor(codeSystem: CodeSystem): string {
  switch (codeSystem) {
    case "icd10":
      return "athena.encounter_diagnosis";
    case "cpt":
      return "athena.encounter_procedure";
    case "em":
      return "athena.em_level";
    case "modifier":
      return "athena.cpt_modifier";
  }
}

// Normalize a free-form sourceSection from the model to one of the
// canonical SECTION_KEYS. Anything we don't recognize becomes "other"
// — the UI still renders, just without section-specific highlight.
export function normalizeSectionKey(raw: string | undefined | null): SectionKey {
  if (!raw) return "other";
  const cleaned = raw
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z_]/g, "");
  if ((SECTION_KEYS as readonly string[]).includes(cleaned)) {
    return cleaned as SectionKey;
  }
  // Common synonyms.
  if (cleaned === "exam" || cleaned === "pe") return "physical_exam";
  if (cleaned === "ap" || cleaned === "assessment_and_plan") return "assessment";
  if (cleaned === "subjective") return "hpi";
  if (cleaned === "objective") return "physical_exam";
  if (cleaned === "impression") return "assessment";
  return "other";
}

// ---------------------------------------------------------------------------
// Stub path — runs when ANTHROPIC_API_KEY is unset. CRITICAL: never
// hallucinates clinical codes; emits one wellness placeholder + a
// loud doc-gap so the provider sees that the real coder is offline.
// ---------------------------------------------------------------------------

function stubSuggest(input: CodingSuggesterInput): CodingSuggesterResult {
  const isNew = input.encounter.visitType === "new_patient";
  const codes: CodingSuggestedCode[] = [
    {
      codeSystem: "em",
      code: isNew ? "99203" : "99213",
      description: isNew
        ? "Office visit, new patient, moderate complexity"
        : "Office visit, established patient, moderate complexity",
      rationale:
        "Stub: AI coder offline. Level guessed from visit type. Provider " +
        "must reset to the documented level.",
      supportingExcerpts: [],
      documentationGaps: [
        {
          field: "ai_unavailable",
          message:
            "Real coder is offline. Code suggestions are placeholders only.",
          severity: "warn",
        },
      ],
      confidence: "low",
      sourceSection: "other",
    },
    {
      codeSystem: "icd10",
      code: "Z00.00",
      description:
        "Encounter for general adult medical examination without abnormal findings",
      rationale:
        "Stub: no AI extraction. Defaulting to a non-billable wellness " +
        "placeholder.",
      supportingExcerpts: [],
      documentationGaps: [
        {
          field: "primary_diagnosis",
          message: "Real coder unavailable; provider must add diagnoses.",
          severity: "warn",
        },
      ],
      confidence: "low",
      sourceSection: "assessment",
      rafRelevant: false,
    },
  ];
  if (input.encounter.isTelehealth) {
    codes.push({
      codeSystem: "modifier",
      code: "95",
      description: "Synchronous telehealth via real-time interactive A/V",
      rationale: "Stub: encounter flagged isTelehealth=true.",
      supportingExcerpts: [],
      documentationGaps: [],
      confidence: "high",
      sourceSection: "other",
    });
  }
  return { codes };
}

// ---------------------------------------------------------------------------
// Real path — Anthropic with forced tool_use. Wider system prompt than
// billing-suggester to cover HCC + section attribution.
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "You are a clinical coder. Given a finalized outpatient encounter note",
    "parsed into sections, produce ICD-10, CPT, E&M-level, and modifier code",
    "suggestions well-supported by the note text.",
    "",
    "Section-to-code-system bias (apply unless the documentation says otherwise):",
    "  - ICD-10 diagnoses → Assessment (primary) and Plan. Pull each",
    "    diagnosis line item separately; do NOT collapse co-morbidities.",
    "  - CPT procedure codes → Procedures section, with confirmation from MDM.",
    "  - E&M level → Driven by MDM (data reviewed, risk, complexity) OR Time",
    "    if time documentation is present.",
    "  - Modifiers → Only when the note documents the modifier's predicate",
    "    (telehealth, separately identifiable E&M, bilateral, etc.).",
    "",
    "Rules:",
    "  1. Only suggest codes the note clearly supports. If unsure, lower the",
    "     confidence rather than omitting — but never fabricate.",
    "  2. For E&M, suggest exactly ONE level per encounter (99202-99205 for",
    "     new, 99212-99215 for established). Use codeSystem='em', not 'cpt'.",
    "  3. supportingExcerpts must quote the note verbatim — never paraphrase.",
    "  4. sourceSection must be one of: assessment, plan, hpi, ros,",
    "     physical_exam, procedures, orders, mdm, time, other.",
    "  5. For ICD-10 diagnoses, set hccCategory when the diagnosis maps to a",
    "     known HCC bucket (e.g. 'HCC 18 — Diabetes with Chronic Complications').",
    "     Set rafRelevant=true ONLY when the note documents the diagnosis as",
    "     active/current for this visit (not merely past history). Never",
    "     upcode and never assume severity beyond what is documented.",
    "  6. For uncertain or rule-out diagnoses, do NOT code as confirmed —",
    "     either omit, or emit with confidence='low' and a documentationGap",
    "     describing the uncertainty.",
    "  7. Do NOT code procedures that are merely planned. Procedures must",
    "     have evidence in the Procedures section that they were performed.",
    "  8. documentationGaps with severity='block' prevents provider approval",
    "     of that code — reserve for true compliance issues (missing time on",
    "     time-based E&M, missing severity needed for HCC capture, etc.).",
    "  9. You are a SUGGESTION engine. The provider has final authority on",
    "     every code. NEVER silently auto-code.",
  ].join("\n");
}

function buildUserPrompt(input: CodingSuggesterInput): string {
  const visitLabel =
    input.encounter.visitType === "custom"
      ? `custom (${input.encounter.customLabel ?? "unspecified"})`
      : input.encounter.visitType;

  const sectionBlocks: string[] = [];
  const s = input.sections;
  const pushIf = (label: string, text: string | undefined) => {
    if (text && text.trim()) {
      sectionBlocks.push(`### ${label}\n${text.trim()}`);
    }
  };
  pushIf("Assessment", s.assessment);
  pushIf("Plan", s.plan);
  pushIf("HPI", s.hpi);
  pushIf("ROS", s.ros);
  pushIf("Physical Exam", s.physicalExam);
  pushIf("Procedures", s.procedures);
  pushIf("Orders", s.orders);
  pushIf("MDM", s.mdm);
  pushIf("Time", s.time);
  pushIf("Other / Unstructured", s.other);

  if (sectionBlocks.length === 0) {
    sectionBlocks.push(
      "### Other / Unstructured\n(empty note — no codable content)",
    );
  }

  return [
    `Visit type: ${visitLabel}`,
    `Telehealth: ${input.encounter.isTelehealth ? "yes" : "no"}`,
    `Patient DOB: ${input.patient.dateOfBirth}`,
    "",
    "Parsed note sections:",
    "```",
    sectionBlocks.join("\n\n"),
    "```",
    "",
    "Produce the code suggestions now.",
  ].join("\n");
}

const TOOL_SCHEMA: Tool = {
  name: "submit_coding_suggestions",
  description: "Submit the full set of coding suggestions for this encounter.",
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
            confidence: { type: "string", enum: ["low", "medium", "high"] },
            sourceSection: {
              type: "string",
              description:
                "One of: assessment, plan, hpi, ros, physical_exam, procedures, orders, mdm, time, other.",
            },
            hccCategory: { type: "string" },
            rafRelevant: { type: "boolean" },
          },
          required: [
            "codeSystem",
            "code",
            "description",
            "rationale",
            "confidence",
            "sourceSection",
          ],
        },
      },
    },
    required: ["codes"],
  },
};

async function realSuggest(
  input: CodingSuggesterInput,
): Promise<CodingSuggesterResult> {
  const client = new Anthropic();
  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    // Wider output schema → wider token budget. Empirically the coder
    // can emit 15–25 codes for a complex multi-problem visit.
    max_tokens: 4096,
    system: buildSystemPrompt(),
    tools: [TOOL_SCHEMA],
    tool_choice: { type: "tool", name: TOOL_SCHEMA.name },
    messages: [{ role: "user", content: buildUserPrompt(input) }],
  });

  const block = response.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") {
    throw new Error(
      "coding-suggester: model returned no tool_use block (got " +
        response.content.map((b) => b.type).join(",") +
        ")",
    );
  }
  const parsed = CodingOutput.safeParse(block.input);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues },
      "coding-suggester: tool_use output failed Zod validation",
    );
    throw new Error("coding-suggester: malformed tool output");
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Public surface. Mirrors billing-suggester's source flag and degradation.
// ---------------------------------------------------------------------------

export async function suggestCoding(
  input: CodingSuggesterInput,
): Promise<{ result: CodingSuggesterResult; source: "ai" | "stub" }> {
  const forceMode = process.env["CODING_SUGGESTER"];
  const hasKey = !!process.env["ANTHROPIC_API_KEY"];

  const useReal =
    forceMode === "ai" ||
    (forceMode !== "stub" && forceMode !== "off" && hasKey);

  if (!useReal) {
    return { result: stubSuggest(input), source: "stub" };
  }

  try {
    const result = await realSuggest(input);
    return { result, source: "ai" };
  } catch (err) {
    logger.warn(
      { err, encounterId: input.encounter.id },
      "coding-suggester: real AI call failed, degrading to stub",
    );
    return { result: stubSuggest(input), source: "stub" };
  }
}
