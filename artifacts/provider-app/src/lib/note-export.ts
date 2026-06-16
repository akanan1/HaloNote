// Note export utilities — pure functions only.
//
// Halo Note bodies are free-form text. Many clinicians type SOAP
// headers ("Subjective:", "Assessment:", etc.) inline; many don't.
// This module heuristically parses those headers so the Note page can
// offer "Copy SOAP" / "Copy A&P" / "Copy patient instructions" without
// promising sections that aren't there.
//
// HIPAA posture (enforced by callers, documented here for reference):
//   - We never log any output of these functions.
//   - These run only in the browser; no value crosses the network.
//   - clipboard.writeText / window.print are the only sinks.

const SECTION_REGEXES = {
  // Anchored to start-of-line. Allow leading/trailing whitespace, an
  // optional colon, and the common shorthand single-letter form.
  // Multiline flag is set when these are constructed below.
  subjective:
    /^(?:[\t ]*)(?:subjective|s)[\t ]*:[\t ]*$/i,
  objective:
    /^(?:[\t ]*)(?:objective|o)[\t ]*:[\t ]*$/i,
  assessment:
    /^(?:[\t ]*)(?:assessment|a)[\t ]*:[\t ]*$/i,
  plan: /^(?:[\t ]*)(?:plan|p)[\t ]*:[\t ]*$/i,
  // Combined Assessment & Plan — common in many EHR templates.
  assessmentAndPlan:
    /^(?:[\t ]*)(?:a\s*[/&]\s*p|assessment\s*(?:and|&)\s*plan)[\t ]*:[\t ]*$/i,
  patientInstructions:
    /^(?:[\t ]*)(?:patient\s+instructions?|instructions?\s+for\s+patient|discharge\s+instructions?|return\s+precautions?)[\t ]*:[\t ]*$/i,
} as const;

type SectionKey = keyof typeof SECTION_REGEXES;

export interface ParsedNote {
  /** Verbatim body, unchanged. */
  full: string;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  /** Set ONLY when the note uses the combined header. Separate
   *  Assessment + Plan use the two fields above. */
  assessmentAndPlan: string | null;
  patientInstructions: string | null;
}

interface HeaderMatch {
  key: SectionKey;
  /** Line index in the body's split-by-newline array. */
  lineIndex: number;
}

export function parseNoteSections(body: string): ParsedNote {
  const lines = body.split(/\r?\n/);
  const matches: HeaderMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const [key, re] of Object.entries(SECTION_REGEXES) as [
      SectionKey,
      RegExp,
    ][]) {
      if (re.test(line)) {
        matches.push({ key, lineIndex: i });
        break; // each line matches at most one header
      }
    }
  }

  const sections: Partial<Record<SectionKey, string>> = {};
  for (let m = 0; m < matches.length; m++) {
    const current = matches[m]!;
    const next = matches[m + 1];
    const start = current.lineIndex + 1;
    const end = next ? next.lineIndex : lines.length;
    const content = lines.slice(start, end).join("\n").trim();
    if (content.length > 0) sections[current.key] = content;
  }

  return {
    full: body,
    subjective: sections.subjective ?? null,
    objective: sections.objective ?? null,
    assessment: sections.assessment ?? null,
    plan: sections.plan ?? null,
    assessmentAndPlan: sections.assessmentAndPlan ?? null,
    patientInstructions: sections.patientInstructions ?? null,
  };
}

export interface NoteExportMeta {
  patientName?: string;
  /** Already-formatted date string (we never compute DOB ourselves —
   *  caller passes only what's already visible on screen, per spec). */
  dateOfBirth?: string;
  /** ISO 8601 created-at. */
  createdAt: string;
  providerName?: string;
}

function formatHeader(meta: NoteExportMeta): string {
  const lines: string[] = ["CLINICAL NOTE"];
  if (meta.patientName) lines.push(`Patient: ${meta.patientName}`);
  if (meta.dateOfBirth) lines.push(`DOB: ${meta.dateOfBirth}`);
  const created = new Date(meta.createdAt);
  if (!Number.isNaN(created.getTime())) {
    lines.push(`Date: ${created.toLocaleString()}`);
  }
  if (meta.providerName) lines.push(`Provider: ${meta.providerName}`);
  return lines.join("\n");
}

/** Plain-text full note with a brief header. Goes to the clipboard. */
export function formatFullForCopy(
  parsed: ParsedNote,
  meta: NoteExportMeta,
): string {
  return `${formatHeader(meta)}\n\n${parsed.full.trim()}\n`;
}

/** S/O/A/P only. If neither separate S/O/A/P nor combined A&P were
 *  detected, returns null — callers must disable the action. */
export function formatSoapForCopy(
  parsed: ParsedNote,
  meta: NoteExportMeta,
): string | null {
  const blocks: string[] = [];
  if (parsed.subjective) blocks.push(`SUBJECTIVE\n${parsed.subjective}`);
  if (parsed.objective) blocks.push(`OBJECTIVE\n${parsed.objective}`);
  if (parsed.assessment) blocks.push(`ASSESSMENT\n${parsed.assessment}`);
  if (parsed.plan) blocks.push(`PLAN\n${parsed.plan}`);
  if (
    blocks.length === 0 &&
    parsed.assessmentAndPlan === null
  ) {
    return null;
  }
  // Fall back to the combined block when only A&P was used.
  if (blocks.length === 0 && parsed.assessmentAndPlan) {
    blocks.push(`ASSESSMENT & PLAN\n${parsed.assessmentAndPlan}`);
  }
  return `${formatHeader(meta)}\n\n${blocks.join("\n\n")}\n`;
}

/** Assessment + Plan ONLY (either as separate sections or the combined
 *  block). Returns null when nothing was detected. */
export function formatAssessmentAndPlanForCopy(
  parsed: ParsedNote,
  meta: NoteExportMeta,
): string | null {
  if (parsed.assessmentAndPlan) {
    return `${formatHeader(meta)}\n\nASSESSMENT & PLAN\n${parsed.assessmentAndPlan}\n`;
  }
  if (parsed.assessment || parsed.plan) {
    const blocks: string[] = [];
    if (parsed.assessment) blocks.push(`ASSESSMENT\n${parsed.assessment}`);
    if (parsed.plan) blocks.push(`PLAN\n${parsed.plan}`);
    return `${formatHeader(meta)}\n\n${blocks.join("\n\n")}\n`;
  }
  return null;
}

/** Patient instructions only. Null when the section is absent. */
export function formatPatientInstructionsForCopy(
  parsed: ParsedNote,
  meta: NoteExportMeta,
): string | null {
  if (!parsed.patientInstructions) return null;
  return `${formatHeader(meta)}\n\nPATIENT INSTRUCTIONS\n${parsed.patientInstructions}\n`;
}

/** Which copy buttons should be enabled for this note. */
export interface CopyAvailability {
  full: true;
  soap: boolean;
  assessmentAndPlan: boolean;
  patientInstructions: boolean;
}

export function copyAvailability(parsed: ParsedNote): CopyAvailability {
  const hasSoap =
    !!parsed.subjective ||
    !!parsed.objective ||
    !!parsed.assessment ||
    !!parsed.plan ||
    !!parsed.assessmentAndPlan;
  const hasAp =
    !!parsed.assessment || !!parsed.plan || !!parsed.assessmentAndPlan;
  return {
    full: true,
    soap: hasSoap,
    assessmentAndPlan: hasAp,
    patientInstructions: !!parsed.patientInstructions,
  };
}

/** Build a sensible filename for the browser's "Save as PDF" dialog.
 *  Sanitizes the patient name to avoid filesystem-unfriendly chars.
 *  Example: "halo-note-Aguirre-Marisol-2026-05-17.pdf" */
export function buildPdfFilename(
  patientName: string | undefined,
  createdAt: string,
): string {
  const safe = (patientName ?? "patient")
    .replace(/[^A-Za-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "patient";
  const date = new Date(createdAt);
  const dateStr = Number.isNaN(date.getTime())
    ? "note"
    : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `halo-note-${safe}-${dateStr}.pdf`;
}

/**
 * Copy `text` to the clipboard. Returns true on success. Throws no
 * error to the caller — clipboard failures are surfaced via the
 * returned boolean so callers can show a precise UI message.
 *
 * Uses navigator.clipboard.writeText, which requires HTTPS or
 * localhost. We don't fall back to the legacy execCommand path: the
 * dev server runs on localhost (secure context per spec) and prod is
 * HTTPS, so the modern API is always available.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function"
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // permission denied, document not focused, etc.
  }
  return false;
}
