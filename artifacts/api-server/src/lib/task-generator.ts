import Anthropic from "@anthropic-ai/sdk";
import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { z } from "@workspace/api-zod";
import type { Encounter, TaskCategory } from "@workspace/db";
import { logger } from "./logger";

// Mirror of the schema's TaskCategory union — kept inline so the Zod
// validator + the Anthropic tool schema both compile against the same
// list without importing the runtime enum.
const TASK_CATEGORIES = [
  "call_patient",
  "schedule_followup",
  "send_referral",
  "prior_auth",
  "obtain_records",
  "repeat_labs",
  "nursing_instruction",
  "billing_followup",
  "patient_instruction",
  "other",
] as const satisfies readonly TaskCategory[];

const SupportingExcerpt = z.object({
  text: z.string().min(1).max(2000),
  locationHint: z.string().max(60).optional(),
});

const GeneratedTask = z.object({
  category: z.enum(TASK_CATEGORIES),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  priority: z.enum(["low", "normal", "high"]).default("normal"),
  // dueOffsetDays: how many days from the encounter the task is due.
  // Lets the AI emit "follow up in 2 weeks" without knowing the exact
  // date, which is brittle in prompts. Server resolves to an absolute
  // dueAt timestamp.
  dueOffsetDays: z.number().int().min(0).max(365).optional(),
  rationale: z.string().min(1).max(1000),
  supportingExcerpts: z.array(SupportingExcerpt).max(5).default([]),
});

const GeneratorOutput = z.object({
  tasks: z.array(GeneratedTask).max(20),
});

export type GeneratedTaskRow = z.infer<typeof GeneratedTask>;
export type TaskGeneratorResult = z.infer<typeof GeneratorOutput>;

export interface TaskGeneratorInput {
  encounter: Pick<Encounter, "id" | "visitType" | "customLabel" | "scheduledAt">;
  noteBody: string;
}

// ---------------------------------------------------------------------------
// Stub. Emits one schedule-followup task so the dashboard has at least
// one row to render in dev. Lower-stakes than the order suggester —
// hallucinating a task is a wasted minute, not a patient-harm event —
// so the stub is more generous than the orders stub.
// ---------------------------------------------------------------------------

function stubGenerate(input: TaskGeneratorInput): TaskGeneratorResult {
  const tasks: GeneratedTaskRow[] = [
    {
      category: "schedule_followup",
      title: "Schedule follow-up visit",
      description:
        "Reach out to the patient to schedule the follow-up cadence agreed in the visit.",
      priority: "normal",
      dueOffsetDays: 7,
      rationale:
        "Stub generator: AI is offline. Default follow-up scheduling task " +
        "so the dashboard has at least one work item.",
      supportingExcerpts: [],
    },
  ];
  // For new-patient visits, also flag a records-pull — common need
  // and low-noise as a placeholder.
  if (input.encounter.visitType === "new_patient") {
    tasks.push({
      category: "obtain_records",
      title: "Request prior records",
      description:
        "Send a release-of-information request to the patient's prior provider for new-patient handoff.",
      priority: "normal",
      dueOffsetDays: 3,
      rationale: "Stub: standard new-patient records request.",
      supportingExcerpts: [],
    });
  }
  return { tasks };
}

// ---------------------------------------------------------------------------
// Real path — Anthropic with forced tool_use.
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return [
    "You are a clinical workflow assistant. Given an encounter note,",
    "extract the follow-up TASKS the care team needs to do — not orders,",
    "not codes, just work items.",
    "",
    "Rules:",
    "  1. Only emit tasks the note explicitly mentions or strongly implies",
    "     (e.g. 'will call patient with biopsy results' → call_patient).",
    "  2. Pick the closest-fitting category. Use 'other' only when nothing",
    "     else applies — don't try to invent categories.",
    "  3. dueOffsetDays is days from the encounter date, optional. Use it",
    "     when the note implies a timeframe ('f/u in 2 weeks' → 14).",
    "     Omit when no timeframe is implied.",
    "  4. priority='high' is for time-sensitive items (urgent referrals,",
    "     critical labs to chase). Don't escalate routine tasks.",
    "  5. supportingExcerpts must quote the note verbatim.",
    "  6. Do NOT emit tasks that duplicate billing codes, order entries,",
    "     or the assessment/plan in the note. Tasks are work items, not",
    "     clinical documentation.",
  ].join("\n");
}

function buildUserPrompt(input: TaskGeneratorInput): string {
  const visitLabel =
    input.encounter.visitType === "custom"
      ? `custom (${input.encounter.customLabel ?? "unspecified"})`
      : input.encounter.visitType;
  return [
    `Visit type: ${visitLabel}`,
    "",
    "Note body:",
    "```",
    input.noteBody,
    "```",
    "",
    "Generate the task list now.",
  ].join("\n");
}

const TOOL_SCHEMA: Tool = {
  name: "submit_generated_tasks",
  description:
    "Submit the final list of follow-up tasks extracted from the encounter note.",
  input_schema: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            category: { type: "string", enum: [...TASK_CATEGORIES] },
            title: { type: "string" },
            description: { type: "string" },
            priority: { type: "string", enum: ["low", "normal", "high"] },
            dueOffsetDays: { type: "integer" },
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
          },
          required: ["category", "title", "rationale"],
        },
      },
    },
    required: ["tasks"],
  },
};

async function realGenerate(
  input: TaskGeneratorInput,
): Promise<TaskGeneratorResult> {
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
      "task-generator: model returned no tool_use block (got " +
        response.content.map((b) => b.type).join(",") +
        ")",
    );
  }
  const parsed = GeneratorOutput.safeParse(block.input);
  if (!parsed.success) {
    logger.error(
      { issues: parsed.error.issues },
      "task-generator: tool_use output failed Zod validation",
    );
    throw new Error("task-generator: malformed tool output");
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------

export async function generateTasks(
  input: TaskGeneratorInput,
): Promise<{ result: TaskGeneratorResult; source: "ai" | "stub" }> {
  const forceMode = process.env["TASK_GENERATOR"];
  const hasKey = !!process.env["ANTHROPIC_API_KEY"];
  const useReal =
    forceMode === "ai" ||
    (forceMode !== "stub" && forceMode !== "off" && hasKey);
  if (!useReal) return { result: stubGenerate(input), source: "stub" };
  try {
    return { result: await realGenerate(input), source: "ai" };
  } catch (err) {
    logger.warn(
      { err, encounterId: input.encounter.id },
      "task-generator: real AI call failed, degrading to stub",
    );
    return { result: stubGenerate(input), source: "stub" };
  }
}
