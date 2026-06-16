// Per-provider writing-style profiler.
//
// Goal: let the recording pipeline produce notes that sound like the
// individual provider wrote them, not like a generic AI scribe.
//
// HIPAA design:
// - We never send "Provider A's notes" alongside "Patient B's transcript"
//   as raw style examples. That would be a disclosure of Provider A's
//   patients' PHI for a purpose outside their original treatment context.
// - Instead, we distil the provider's recent notes into a NON-PHI
//   *style descriptor* — a short paragraph about HOW they write, not
//   WHAT they wrote. Section ordering, abbreviations, sentence
//   register, level of detail, voice. The profile is stored on the
//   `users` row (`writingStyleProfile`) and injected into the
//   recording prompt as a per-provider cached block.
// - The extractor prompt is explicit: emit style descriptors only;
//   refuse to reproduce patient names, MRNs, DOBs, diagnoses, drug
//   names, dates, or any other identifiers. We validate the LLM
//   output post-hoc with a lightweight regex sweep before we persist
//   it; on any hit we drop the result rather than store leaked PHI.
//
// Refresh cadence: fire-and-forget from the pipeline after each
// successful recording. Bounded by STALE_AFTER_MS so a busy provider
// doesn't burn an LLM call per visit, and skipped entirely when the
// provider has fewer than MIN_NOTES_FOR_PROFILE notes (no signal to
// learn from yet).

import Anthropic from "@anthropic-ai/sdk";
import { desc, eq } from "drizzle-orm";
import { getDb, notesTable, usersTable } from "@workspace/db";
import { logger } from "./logger";

const ANTHROPIC_MODEL = "claude-opus-4-7";
const MAX_OUTPUT_TOKENS = 1024;
// How many of the provider's most recent notes feed the profile.
// Enough to capture pattern, small enough to keep token cost low.
const PROFILE_NOTES_LIMIT = 12;
// Minimum note count before we even try. Below this, the profile
// would be noise — better to leave it null and use neutral prose.
const MIN_NOTES_FOR_PROFILE = 3;
// Skip a refresh if the profile was updated within this window.
// 24 hours keeps the profile current without rebuilding it per visit.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
// Hard cap on profile size we persist. Style descriptors should be
// short; anything bigger is a sign the LLM started copying content.
const MAX_PROFILE_CHARS = 2_000;

const PROFILER_SYSTEM_PROMPT = [
  "You are analyzing a clinician's writing style for a non-PHI",
  "stylebook. Your output will be used as a prompt fragment to make a",
  "future AI-generated note sound like this specific provider wrote it.",
  "",
  "RULES — non-negotiable:",
  "1. Output ONLY style descriptors. Describe HOW the provider writes,",
  "   never WHAT they wrote about. Patterns, not content.",
  "2. Do NOT reproduce patient names, initials, MRNs, dates of birth,",
  "   specific dates, ages, addresses, phone numbers, email addresses,",
  "   or any other HIPAA identifier from the samples.",
  "3. Do NOT reproduce specific diagnoses, drug names, dosages, lab",
  "   values, or symptom descriptions verbatim. You may describe",
  "   *patterns* (e.g. 'lists medications with dose and frequency') —",
  "   never the names themselves.",
  "4. Do NOT quote sentences from the samples. Paraphrase patterns.",
  "5. Keep the output under 1500 characters total.",
  "",
  "Cover (when evidence supports it):",
  "- Preferred section structure and ordering (e.g. SOAP order, where",
  "  Assessment merges with Plan, whether HPI is paragraph or bulleted).",
  "- Sentence register (third-person past tense vs first-person,",
  "  telegraphic vs full sentences).",
  "- Abbreviation usage (which abbreviations they actually use; whether",
  "  they spell out conditions or use shorthand).",
  "- Level of detail per section (e.g. detailed ROS, terse Plan).",
  "- Formatting habits (bullet points, numbered lists, headers in caps,",
  "  indentation, use of dashes vs colons).",
  "- How they reference the patient (first name, 'the patient', initials).",
  "- Any other repeatable structural patterns.",
  "",
  "Output a single concise paragraph (or short bulleted list of",
  "patterns) suitable for inclusion in a prompt. No preamble, no",
  "trailing commentary, no markdown headers.",
].join("\n");

// Cheap regex pass: if the model accidentally echoed an identifier
// shape, drop the result. Better to lose a refresh than persist PHI.
const PHI_GUARDS: ReadonlyArray<RegExp> = [
  // MRN-like tokens (project convention: MRN-12345). Defensive,
  // covers other vendor formats too.
  /\bMRN[-\s]?[A-Z0-9]{4,}\b/i,
  // SSN.
  /\b\d{3}-\d{2}-\d{4}\b/,
  // ISO or US dates with year (style descriptors shouldn't need them).
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b(?:0?[1-9]|1[0-2])\/(?:0?[1-9]|[12]\d|3[01])\/\d{2,4}\b/,
  // Phone numbers (US).
  /\b\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/,
  // Email.
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
];

function looksLikePhiLeak(text: string): boolean {
  return PHI_GUARDS.some((re) => re.test(text));
}

// Test-only export so the regex defense layer can be exercised in
// isolation. Not part of the public API.
export const _PHI_GUARDS_FOR_TESTS: ReadonlyArray<RegExp> = PHI_GUARDS;

interface ProfilerDeps {
  /** Injection seam for tests. Defaults to a real Anthropic client. */
  anthropic?: Anthropic;
}

/**
 * True if the user's profile is missing or older than the staleness
 * window. Pure check, no side effects.
 */
export function profileNeedsRefresh(
  updatedAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (!updatedAt) return true;
  return now.getTime() - updatedAt.getTime() > STALE_AFTER_MS;
}

/**
 * Extract a fresh style profile for `userId` and persist it. Safe to
 * call from a fire-and-forget context — all errors are caught and
 * logged so a profile failure can never break the foreground
 * recording pipeline.
 */
export async function refreshStyleProfile(
  userId: string,
  deps: ProfilerDeps = {},
): Promise<void> {
  const db = getDb();
  try {
    const recent = await db
      .select({ body: notesTable.body, createdAt: notesTable.createdAt })
      .from(notesTable)
      .where(eq(notesTable.authorId, userId))
      .orderBy(desc(notesTable.createdAt))
      .limit(PROFILE_NOTES_LIMIT);

    if (recent.length < MIN_NOTES_FOR_PROFILE) {
      logger.info(
        { userId, count: recent.length, min: MIN_NOTES_FOR_PROFILE },
        "style-profile: skipping refresh — not enough notes yet",
      );
      return;
    }

    const samples = recent
      .map((n, i) => `--- Sample note ${i + 1} ---\n${n.body}`)
      .join("\n\n");

    const anthropic = deps.anthropic ?? new Anthropic();
    const response = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: PROFILER_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content:
            `You will see ${recent.length} of the provider's most recent ` +
            "notes. Analyze them and emit the style descriptor per the rules.\n\n" +
            samples +
            "\n\nWrite the style descriptor now.",
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      logger.warn(
        { userId },
        "style-profile: model refused — keeping previous profile",
      );
      return;
    }

    const profile = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();

    if (!profile) {
      logger.warn({ userId }, "style-profile: empty output, skipping");
      return;
    }
    if (profile.length > MAX_PROFILE_CHARS) {
      logger.warn(
        { userId, length: profile.length, cap: MAX_PROFILE_CHARS },
        "style-profile: output exceeded cap — likely copying content, skipping",
      );
      return;
    }
    if (looksLikePhiLeak(profile)) {
      // Defense in depth — the prompt forbids identifiers but if the
      // model emitted one shape anyway we refuse to persist it. The
      // log records that a leak was caught without echoing it.
      logger.error(
        { userId },
        "style-profile: PHI guard tripped on output — refusing to persist",
      );
      return;
    }

    await db
      .update(usersTable)
      .set({
        writingStyleProfile: profile,
        writingStyleUpdatedAt: new Date(),
      })
      .where(eq(usersTable.id, userId));

    logger.info(
      {
        userId,
        sampleCount: recent.length,
        profileChars: profile.length,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      "style-profile: refreshed",
    );
  } catch (err) {
    logger.error({ err, userId }, "style-profile: refresh failed");
  }
}

/**
 * Fire-and-forget wrapper. Returns immediately; the actual work runs
 * in the background. Errors are swallowed inside `refreshStyleProfile`
 * so they never propagate.
 */
export function refreshStyleProfileInBackground(userId: string): void {
  void refreshStyleProfile(userId);
}
