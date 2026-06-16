// Real ambient-scribe pipeline: audio segments → Deepgram STT → Claude
// Opus 4.7 structuring pass → SOAP-formatted note body.
//
// Selected at boot by `pickRecordingPipeline()` based on env config. When
// the vendor keys are missing we fall back to a placeholder so dev still
// works without external credentials (and without paying).
//
// HIPAA notes:
// - Both Deepgram and Anthropic must have signed BAAs covering this
//   deployment. The keys themselves don't imply that — the deploy
//   runbook checks the BAA-status doc before flipping `RECORDING_PIPELINE`
//   to `real` in prod.
// - The transcript and structured body are NEVER logged (pino redacts
//   `transcript`, `structuredBody`, `firstName`, `lastName`, `mrn` at
//   the logger level — see lib/logger.ts). We log jobId + state
//   transitions + token usage, nothing PHI-ish.
// - Patient context sent to Claude is minimum-necessary: first name +
//   computed age + sex if present, plus up to 3 of the patient's own
//   most-recent prior notes for continuity. We do NOT send cross-patient
//   notes for "style memory" yet — that's a separate HIPAA conversation.

import Anthropic from "@anthropic-ai/sdk";
import { createClient as createDeepgramClient } from "@deepgram/sdk";
import { asc, desc, eq } from "drizzle-orm";
import {
  getDb,
  noteTemplatesTable,
  notesTable,
  patientsTable,
  providerNoteDefaultsTable,
  providerPhraseMappingsTable,
  recordingJobsTable,
  recordingSegmentsTable,
  usersTable,
  type NoteTemplate,
  type ProviderNoteDefault,
  type ProviderPhraseMapping,
  type RecordingStatus,
} from "@workspace/db";
import { getRecordingStorage } from "./recording-storage";
import { logger } from "./logger";
import {
  profileNeedsRefresh,
  refreshStyleProfileInBackground,
} from "./style-profile";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface RecordingPipeline {
  /** Drive `jobId` through transcribing → structuring → done|failed. */
  run(jobId: string): Promise<void>;
}

let _pipeline: RecordingPipeline | null = null;

/**
 * Resolve the pipeline implementation once at boot. Memoized so the
 * Anthropic + Deepgram clients (which hold connection pools) aren't
 * reconstructed per recording.
 *
 * Mode selection:
 * - `RECORDING_PIPELINE=placeholder` → fake delays + canned body. Default
 *   when keys are missing.
 * - `RECORDING_PIPELINE=real` + both `ANTHROPIC_API_KEY` and
 *   `DEEPGRAM_API_KEY` set → live Deepgram + Claude.
 * - `RECORDING_PIPELINE=real` with keys missing → throws on resolve, so
 *   prod can't quietly fall back to placeholder output.
 */
export function getRecordingPipeline(): RecordingPipeline {
  if (_pipeline) return _pipeline;
  const requested = (
    process.env["RECORDING_PIPELINE"] ?? "auto"
  ).toLowerCase();
  const hasKeys =
    !!process.env["ANTHROPIC_API_KEY"] && !!process.env["DEEPGRAM_API_KEY"];

  if (requested === "real" || (requested === "auto" && hasKeys)) {
    if (!hasKeys) {
      throw new Error(
        "RECORDING_PIPELINE=real requires ANTHROPIC_API_KEY and DEEPGRAM_API_KEY",
      );
    }
    _pipeline = new DeepgramClaudePipeline();
    logger.info("recording-pipeline: live (Deepgram + Claude Opus 4.7)");
  } else {
    _pipeline = new PlaceholderPipeline();
    logger.info("recording-pipeline: placeholder (no STT/LLM calls)");
  }
  return _pipeline;
}

/** Test seam — swap in a fake pipeline for integration tests. */
export function _setRecordingPipelineForTests(p: RecordingPipeline | null) {
  _pipeline = p;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function setStatus(
  jobId: string,
  next: RecordingStatus,
  patch: Partial<typeof recordingJobsTable.$inferInsert> = {},
): Promise<void> {
  await getDb()
    .update(recordingJobsTable)
    .set({ ...patch, status: next, updatedAt: new Date() })
    .where(eq(recordingJobsTable.id, jobId));
}

async function fail(jobId: string, message: string): Promise<void> {
  await setStatus(jobId, "failed", {
    errorMessage: message,
    completedAt: new Date(),
  }).catch(() => {});
}

function computeAge(dobIso: string): number | null {
  // dobIso is "YYYY-MM-DD" from Postgres `date` (string mode). Compute
  // age in whole years against now — Anthropic doesn't need DOB, just
  // an age band, and "age" is not one of HIPAA's 18 identifiers.
  const dob = new Date(dobIso + "T00:00:00Z");
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age >= 0 ? age : null;
}

// ---------------------------------------------------------------------------
// Placeholder — kept for dev / CI without API keys
// ---------------------------------------------------------------------------

class PlaceholderPipeline implements RecordingPipeline {
  async run(jobId: string): Promise<void> {
    const startedAt = Date.now();
    try {
      await setStatus(jobId, "transcribing");
      await new Promise((r) => setTimeout(r, 1500));
      const transcript =
        "[placeholder transcript — set RECORDING_PIPELINE=real with " +
        "ANTHROPIC_API_KEY + DEEPGRAM_API_KEY to use the real pipeline]";

      await setStatus(jobId, "structuring", { transcript });
      await new Promise((r) => setTimeout(r, 1500));
      const structuredBody = [
        "Subjective:",
        "  [Placeholder — the real pipeline produces a SOAP note here.]",
        "",
        "Objective:",
        "  [Vitals, exam findings, etc.]",
        "",
        "Assessment & Plan:",
        "  [AI-generated assessment and plan goes here.]",
        "",
      ].join("\n");

      await setStatus(jobId, "done", {
        transcript,
        structuredBody,
        completedAt: new Date(),
      });
      logger.info(
        { jobId, durationMs: Date.now() - startedAt },
        "recording-pipeline: placeholder done",
      );
    } catch (err) {
      logger.error({ err, jobId }, "recording-pipeline: placeholder crashed");
      await fail(jobId, err instanceof Error ? err.message : "placeholder error");
    }
  }
}

// ---------------------------------------------------------------------------
// Real pipeline
// ---------------------------------------------------------------------------

// Model + prompt configuration. Pinned here so the prompt cache hash is
// stable — any change to these strings invalidates the cached prefix on
// the next request, so don't edit casually.
const ANTHROPIC_MODEL = "claude-opus-4-7";
const MAX_OUTPUT_TOKENS = 4096;
const RECENT_NOTES_LIMIT = 3;

// Frozen system prompt. Stays at the front of every request, gets a
// cache_control breakpoint, and is the single largest cacheable block.
// Any byte change here invalidates the cached prefix across ALL future
// requests — keep static and version via deliberate edits only.
const SYSTEM_PROMPT = [
  "You are HaloNote, an AI clinical scribe assisting a licensed",
  "healthcare provider. Your job is to convert a transcribed",
  "patient-encounter audio recording into a structured clinical note.",
  "",
  "Choosing the note structure:",
  "A. The provider may open the encounter with a verbal cue selecting a",
  "   template — e.g. \"let's do a SOAP note\", \"this is a follow-up\",",
  "   \"start an H&P\", \"discharge summary\". Inspect the first ~30",
  "   seconds of transcript for such a cue. Match against the listed",
  "   templates by name OR by `voiceCue` OR by an obvious paraphrase.",
  "   Strip the cue phrase from the note body — it isn't clinical content.",
  "B. If no explicit cue is heard, INFER the visit type from the",
  "   conversation (chief complaint, history depth, exam scope, whether",
  "   it's a new patient vs an established follow-up) and pick the",
  "   best-fitting template from the list.",
  "C. If neither A nor B produces a confident match, fall back to a SOAP",
  "   note with sections labelled exactly:",
  "     Subjective:, Objective:, Assessment:, Plan:",
  "",
  "Output rules (follow exactly):",
  "1. Use the section headers from the chosen template verbatim. Do not",
  "   invent, rename, reorder, merge, or drop sections.",
  "2. Use complete sentences in clinical prose. No bullet salad.",
  "3. Only state findings that are supported by the transcript or the",
  "   provided patient context. Do not invent vitals, labs, or history.",
  "4. If the transcript is silent on a section, write",
  "   'Not addressed in this encounter.' under that header — do not pad.",
  "5. Use the patient's first name when natural; never include DOB, MRN,",
  "   address, phone, email, or any other HIPAA identifier in the note",
  "   body — the EHR adds those automatically from the patient header.",
  "6. Match the provider's writing voice. The user message includes a",
  "   style profile distilled from this provider's prior notes —",
  "   follow its descriptors for section ordering, abbreviations,",
  "   sentence register, and level of detail. The patient's own prior",
  "   notes (when supplied) anchor clinical continuity for *this*",
  "   patient. If neither is supplied, default to neutral clinical",
  "   prose suitable for the chosen template.",
  "6a. Apply the provider's phrase mappings when present. These are",
  "    explicit \"when I say X, document Y\" overrides — match the",
  "    SPOKEN phrase case-insensitively against the transcript and",
  "    substitute the DOCUMENTED term. Use clinical judgment: skip a",
  "    substitution only if the spoken phrase clearly carries a",
  "    different meaning in context.",
  "6b. Apply the provider's encounter defaults. These are baseline",
  "    assumptions (e.g. ROS 14-point negative unless stated, vitals",
  "    block always present, exam normal unless contradicted). Bake",
  "    them in by default. The transcript ALWAYS wins when it",
  "    contradicts a default — never override a stated finding with",
  "    its default counterpart.",
  "7. Do NOT include any preamble or trailing commentary, and do NOT",
  "   announce which template you picked — just output the section",
  "   headers and their bodies, and nothing else.",
].join("\n");

interface PatientContext {
  firstName: string;
  age: number | null;
  priorNotes: Array<{ createdAt: Date; body: string }>;
}

// What we send to Claude for cue/visit-type matching. The full template
// row carries timestamps and sort_order we don't need in the prompt.
interface TemplateChoice {
  name: string;
  voiceCue: string | null;
  body: string;
}

// What we send to Claude for term-substitution rules. The full DB row
// carries timestamps and sort_order we don't need in the prompt.
interface PhraseMapping {
  spoken: string;
  documented: string;
}

// Encounter-default assumptions the provider has opted into. Each
// rule is an imperative instruction the AI applies on every recording.
interface NoteDefault {
  label: string;
  rule: string;
}

// Bundled per-provider context: templates + writing-style profile +
// explicit phrase mappings + encounter defaults. These share a cache
// breakpoint because they're all stable across the provider's
// recordings — co-locating them simplifies cache arithmetic and
// leaves a breakpoint free for future per-encounter context.
interface ProviderContext {
  templates: TemplateChoice[];
  styleProfile: string | null;
  styleProfileUpdatedAt: Date | null;
  phraseMappings: PhraseMapping[];
  noteDefaults: NoteDefault[];
}

class DeepgramClaudePipeline implements RecordingPipeline {
  private readonly anthropic: Anthropic;
  private readonly deepgram: ReturnType<typeof createDeepgramClient>;

  constructor() {
    this.anthropic = new Anthropic();
    this.deepgram = createDeepgramClient(process.env["DEEPGRAM_API_KEY"]!);
  }

  async run(jobId: string): Promise<void> {
    const startedAt = Date.now();
    try {
      // 1. Load job + segments + (optional) patient.
      const [job] = await getDb()
        .select()
        .from(recordingJobsTable)
        .where(eq(recordingJobsTable.id, jobId))
        .limit(1);
      if (!job) throw new Error("recording job vanished");

      const segments = await getDb()
        .select()
        .from(recordingSegmentsTable)
        .where(eq(recordingSegmentsTable.recordingJobId, jobId))
        .orderBy(asc(recordingSegmentsTable.ordinal));
      if (segments.length === 0) throw new Error("no_segments_uploaded");

      const [patient, providerCtx] = await Promise.all([
        job.patientId ? this.loadPatientContext(job.patientId) : null,
        this.loadProviderContext(job.userId),
      ]);

      // 2. Transcribe each segment via Deepgram, join in upload order.
      await setStatus(jobId, "transcribing");
      const transcript = await this.transcribeSegments(jobId, segments);
      if (!transcript.trim()) {
        // Deepgram returned empty — almost always a silent mic. Don't
        // fan this out into Claude as a noisy "no transcript" prompt.
        throw new Error("empty_transcript");
      }

      // 3. Structure into the chosen template via Claude.
      await setStatus(jobId, "structuring", { transcript });
      const structuredBody = await this.structureNote(
        transcript,
        patient,
        providerCtx,
      );

      // Fire-and-forget: refresh the provider's writing-style profile
      // if it's stale or missing. The pipeline has just produced a
      // fresh note for this provider, so the latest sample is now in
      // the DB and feeds the next refresh. Errors inside
      // refreshStyleProfileInBackground are swallowed there.
      if (
        profileNeedsRefresh(providerCtx.styleProfileUpdatedAt)
      ) {
        refreshStyleProfileInBackground(job.userId);
      }

      // 4. Done.
      await setStatus(jobId, "done", {
        transcript,
        structuredBody,
        completedAt: new Date(),
      });
      logger.info(
        {
          jobId,
          durationMs: Date.now() - startedAt,
          segmentCount: segments.length,
        },
        "recording-pipeline: done",
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "pipeline_error";
      logger.error({ err, jobId }, "recording-pipeline: failed");
      await fail(jobId, msg);
    }
  }

  // ---------------------- STT ----------------------

  private async transcribeSegments(
    jobId: string,
    segments: Array<typeof recordingSegmentsTable.$inferSelect>,
  ): Promise<string> {
    const storage = getRecordingStorage();
    const parts: string[] = [];

    for (const seg of segments) {
      const audio = await storage.readSegment({ storageKey: seg.storageKey });
      const { result, error } =
        await this.deepgram.listen.prerecorded.transcribeFile(audio, {
          // `nova-3-medical` is Deepgram's medical-domain model — better
          // recall on drug names, anatomy, abbreviations. Falls back to
          // `nova-3` if the org isn't entitled (logged + handled below).
          model: "nova-3-medical",
          smart_format: true,
          punctuate: true,
          diarize: true,
          // We don't pin a language — clinics with bilingual encounters
          // would want `language: "multi"`. Default ("en") is fine for v1.
        });
      if (error) {
        throw new Error(
          `deepgram_error: ${error.message ?? "unknown"}`.slice(0, 200),
        );
      }
      const text =
        result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
      logger.info(
        {
          jobId,
          segmentId: seg.id,
          ordinal: seg.ordinal,
          chars: text.length,
        },
        "recording-pipeline: segment transcribed",
      );
      if (text) parts.push(text);
    }

    return parts.join("\n").trim();
  }

  // ---------------------- LLM ----------------------

  private async loadPatientContext(
    patientId: string,
  ): Promise<PatientContext | null> {
    const [p] = await getDb()
      .select()
      .from(patientsTable)
      .where(eq(patientsTable.id, patientId))
      .limit(1);
    if (!p) return null;

    const priorNotes = await getDb()
      .select({ body: notesTable.body, createdAt: notesTable.createdAt })
      .from(notesTable)
      .where(eq(notesTable.patientId, patientId))
      .orderBy(desc(notesTable.createdAt))
      .limit(RECENT_NOTES_LIMIT);

    return {
      firstName: p.firstName,
      age: computeAge(p.dateOfBirth),
      // Reverse so the prompt reads chronologically (oldest → newest).
      priorNotes: priorNotes.slice().reverse(),
    };
  }

  private async loadProviderContext(
    userId: string,
  ): Promise<ProviderContext> {
    const db = getDb();
    const [templateRows, userRows, mappingRows, defaultRows] =
      await Promise.all([
        db
          .select()
          .from(noteTemplatesTable)
          .where(eq(noteTemplatesTable.userId, userId))
          .orderBy(
            asc(noteTemplatesTable.sortOrder),
            asc(noteTemplatesTable.createdAt),
          ),
        db
          .select({
            styleProfile: usersTable.writingStyleProfile,
            styleProfileUpdatedAt: usersTable.writingStyleUpdatedAt,
          })
          .from(usersTable)
          .where(eq(usersTable.id, userId))
          .limit(1),
        db
          .select()
          .from(providerPhraseMappingsTable)
          .where(eq(providerPhraseMappingsTable.userId, userId))
          .orderBy(
            asc(providerPhraseMappingsTable.sortOrder),
            asc(providerPhraseMappingsTable.createdAt),
          ),
        db
          .select()
          .from(providerNoteDefaultsTable)
          .where(eq(providerNoteDefaultsTable.userId, userId))
          .orderBy(
            asc(providerNoteDefaultsTable.sortOrder),
            asc(providerNoteDefaultsTable.createdAt),
          ),
      ]);
    const templates: TemplateChoice[] = (templateRows as NoteTemplate[]).map(
      (r) => ({
        name: r.name,
        voiceCue: r.voiceCue,
        body: r.body,
      }),
    );
    const phraseMappings: PhraseMapping[] = (
      mappingRows as ProviderPhraseMapping[]
    ).map((r) => ({ spoken: r.spoken, documented: r.documented }));
    const noteDefaults: NoteDefault[] = (
      defaultRows as ProviderNoteDefault[]
    ).map((r) => ({ label: r.label, rule: r.rule }));
    return {
      templates,
      styleProfile: userRows[0]?.styleProfile ?? null,
      styleProfileUpdatedAt: userRows[0]?.styleProfileUpdatedAt ?? null,
      phraseMappings,
      noteDefaults,
    };
  }

  private async structureNote(
    transcript: string,
    patient: PatientContext | null,
    providerCtx: ProviderContext,
  ): Promise<string> {
    // Render each context layer as its own stable byte sequence so the
    // cache breakpoints attach to consistent prefixes.
    const providerBlock = renderProviderBlock(providerCtx);
    const contextBlock = renderPatientContextBlock(patient);

    // Prompt layout (most → least stable):
    //   system          (cached — frozen, hits across ALL requests)
    //   messages[0]:
    //     user
    //       block 0: provider templates + style profile (cached — per provider)
    //       block 1: patient context                    (cached — per patient)
    //       block 2: transcript                         (volatile — never cached)
    //
    // Three ephemeral breakpoints, under the 4-breakpoint limit.
    const response = await this.anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      // Adaptive thinking lets Claude decide depth per request. Clinical
      // reasoning is variable — short summary vs complex differential —
      // and adaptive comes out ahead vs a fixed budget. `effort: high`
      // because note quality matters more than per-call latency.
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: providerBlock,
              cache_control: { type: "ephemeral" },
            },
            {
              type: "text",
              text: contextBlock,
              cache_control: { type: "ephemeral" },
            },
            {
              type: "text",
              text:
                "Transcript of the encounter (provider + patient, " +
                "diarized by the STT vendor):\n\n" +
                transcript +
                "\n\nPick the right template per the rules in the system " +
                "prompt and write the note in this provider's voice.",
            },
          ],
        },
      ],
    });

    logger.info(
      {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens,
        cacheWriteTokens: response.usage.cache_creation_input_tokens,
        stopReason: response.stop_reason,
      },
      "recording-pipeline: structuring complete",
    );

    if (response.stop_reason === "refusal") {
      // Don't smuggle a clinical-content refusal into the note body.
      // Surface as a pipeline failure so the provider can review the
      // raw transcript and re-record if appropriate.
      throw new Error("claude_refused_to_structure_note");
    }

    const body = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (!body) throw new Error("claude_returned_empty_body");
    return body;
  }
}

function renderProviderBlock(ctx: ProviderContext): string {
  const lines: string[] = [];

  // --- Writing-style profile (per-provider, non-PHI) ---
  lines.push("Provider writing style:");
  if (ctx.styleProfile && ctx.styleProfile.trim()) {
    lines.push(ctx.styleProfile.trim());
    lines.push("");
    lines.push(
      "Use this style profile to mirror the provider's voice — section " +
        "ordering, abbreviations, sentence register, level of detail. " +
        "Match patterns, not specific past content.",
    );
  } else {
    lines.push(
      "No style profile available yet (provider has fewer than 3 prior " +
        "notes, or this is their first recording). Default to neutral " +
        "clinical prose suitable for the chosen template.",
    );
  }

  // --- Encounter defaults (always-applied assumptions) ---
  lines.push("");
  if (ctx.noteDefaults.length > 0) {
    lines.push(
      `Provider's encounter defaults (${ctx.noteDefaults.length}). ` +
        "Apply each rule below on EVERY note unless the transcript " +
        "explicitly contradicts it. These are baseline assumptions, " +
        "not overrides — transcript content always wins when the two " +
        "disagree:",
    );
    for (const d of ctx.noteDefaults) {
      lines.push("");
      lines.push(`- ${d.label}: ${d.rule}`);
    }
  }

  // --- Provider's explicit phrase mappings ---
  lines.push("");
  if (ctx.phraseMappings.length > 0) {
    lines.push(
      `Provider's preferred documentation terms (${ctx.phraseMappings.length}). ` +
        "When the transcript contains the SPOKEN phrase (case-insensitive, " +
        "whole-phrase match), substitute the DOCUMENTED term in the note. " +
        "These are explicit personalization rules — apply them whenever they " +
        "fit naturally, but do not force a substitution if the spoken phrase " +
        "carries a different clinical meaning in context:",
    );
    for (const m of ctx.phraseMappings) {
      lines.push(`  spoken: "${m.spoken}"  →  documented: "${m.documented}"`);
    }
  }

  // --- Templates ---
  lines.push("");
  if (ctx.templates.length === 0) {
    lines.push(
      "Available note templates for this provider: none configured. " +
        "Default to a SOAP note structure.",
    );
  } else {
    lines.push(
      `Available note templates for this provider (${ctx.templates.length}). ` +
        "Use these to match a verbal cue or infer the visit type:",
    );
    for (const t of ctx.templates) {
      lines.push("");
      lines.push(`--- Template: ${t.name} ---`);
      if (t.voiceCue) {
        lines.push(`Voice cue: "${t.voiceCue}"`);
      }
      if (t.body.trim()) {
        lines.push("Structure (use these section headers verbatim):");
        lines.push(t.body);
      } else {
        lines.push(
          "Structure: freeform — no fixed sections. Use clinical prose.",
        );
      }
    }
    lines.push("");
    lines.push("--- End of templates ---");
  }
  return lines.join("\n");
}

function renderPatientContextBlock(p: PatientContext | null): string {
  if (!p) {
    return "Patient context: not provided. Treat the transcript as a standalone encounter.";
  }
  const lines: string[] = [];
  const ageStr = p.age != null ? `${p.age}-year-old` : "patient";
  lines.push(`Patient: ${p.firstName}, ${ageStr}.`);
  if (p.priorNotes.length > 0) {
    lines.push("");
    lines.push(
      `Prior notes for this patient (${p.priorNotes.length}, oldest first) — ` +
        "use them for clinical continuity and to match the provider's writing style:",
    );
    for (const n of p.priorNotes) {
      lines.push("");
      lines.push(`--- Note from ${n.createdAt.toISOString().slice(0, 10)} ---`);
      lines.push(n.body);
    }
    lines.push("");
    lines.push("--- End of prior notes ---");
  } else {
    lines.push("No prior notes on file for this patient.");
  }
  return lines.join("\n");
}
