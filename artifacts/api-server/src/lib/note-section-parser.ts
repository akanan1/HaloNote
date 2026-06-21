// Splits a finalized clinical note into canonical SOAP-ish sections so
// the coding orchestrator can prompt the AI section-by-section (ICDs
// from the Assessment, CPT/E&M from Procedures + MDM + Time, etc.) and
// later cite the supporting section per suggestion.
//
// Notes in this product come from many sources — Scribe-generated
// structured templates, free-text dictation, imported Athena notes —
// so the parser is intentionally forgiving:
//
//   - Case-insensitive header matching
//   - Headers can be terminated by ":" or just a newline
//   - Common synonyms accepted (Subjective→HPI, A/P→Assessment+Plan)
//   - When no recognizable headers are found, the whole note lands in
//     `other` so the downstream coder still gets something to chew on.
//
// We do NOT try to do clinical NLP here — that's the AI's job. This is
// just a structural splitter so the prompt can give the model the
// right block for the right task.

export interface ParsedNoteSections {
  assessment?: string;
  plan?: string;
  hpi?: string;
  ros?: string;
  physicalExam?: string;
  procedures?: string;
  orders?: string;
  mdm?: string;
  time?: string;
  // Catch-all for content the parser couldn't classify. When the note
  // has zero recognized headers, the entire body goes here so the
  // coder can still run against it (degraded but non-zero quality).
  other?: string;
}

// One section's canonical key + the regexes that match its header. The
// order matters: more specific patterns (e.g. "Assessment and Plan")
// are tried before the looser ones ("Assessment").
//
// Patterns are anchored to start-of-line (with optional leading
// whitespace / bullet markers) and require either a ":" or end-of-line
// after the header word, so prose that happens to contain "plan" or
// "time" mid-sentence doesn't get treated as a header.
interface SectionDef {
  key: keyof ParsedNoteSections | "assessmentAndPlan";
  patterns: RegExp[];
}

const SECTION_DEFS: SectionDef[] = [
  {
    key: "assessmentAndPlan",
    patterns: [
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*(?:assessment(?:\s*(?:&|and|\/)\s*plan)|a\s*\/\s*p|a\s*&\s*p)\b\s*\**\s*[:\-]?\s*$/im,
    ],
  },
  {
    key: "assessment",
    patterns: [
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*assessment\b\s*\**\s*[:\-]?\s*$/im,
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*impression\b\s*\**\s*[:\-]?\s*$/im,
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*diagnoses?\b\s*\**\s*[:\-]?\s*$/im,
    ],
  },
  {
    key: "plan",
    patterns: [
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*plan\b\s*\**\s*[:\-]?\s*$/im,
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*treatment\s*plan\b\s*\**\s*[:\-]?\s*$/im,
    ],
  },
  {
    key: "hpi",
    patterns: [
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*hpi\b\s*\**\s*[:\-]?\s*$/im,
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*history\s*of\s*present\s*illness\b\s*\**\s*[:\-]?\s*$/im,
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*subjective\b\s*\**\s*[:\-]?\s*$/im,
    ],
  },
  {
    key: "ros",
    patterns: [
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*ros\b\s*\**\s*[:\-]?\s*$/im,
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*review\s*of\s*systems\b\s*\**\s*[:\-]?\s*$/im,
    ],
  },
  {
    key: "physicalExam",
    patterns: [
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*(?:physical\s*)?exam(?:ination)?\b\s*\**\s*[:\-]?\s*$/im,
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*pe\b\s*\**\s*[:\-]?\s*$/im,
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*objective\b\s*\**\s*[:\-]?\s*$/im,
    ],
  },
  {
    key: "procedures",
    patterns: [
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*procedures?\b\s*\**\s*[:\-]?\s*$/im,
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*procedure\s*note\b\s*\**\s*[:\-]?\s*$/im,
    ],
  },
  {
    key: "orders",
    patterns: [
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*orders?\b\s*\**\s*[:\-]?\s*$/im,
    ],
  },
  {
    key: "mdm",
    patterns: [
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*mdm\b\s*\**\s*[:\-]?\s*$/im,
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*medical\s*decision\s*making\b\s*\**\s*[:\-]?\s*$/im,
    ],
  },
  {
    key: "time",
    patterns: [
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*time\b\s*\**\s*[:\-]?\s*$/im,
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*time\s*spent\b\s*\**\s*[:\-]?\s*$/im,
      /^\s*(?:#+\s*)?(?:[*\-•]\s*)?\**\s*total\s*time\b\s*\**\s*[:\-]?\s*$/im,
    ],
  },
];

interface HeaderHit {
  start: number;
  end: number;
  key: keyof ParsedNoteSections | "assessmentAndPlan";
}

// Find every header occurrence in the note, regardless of order. The
// caller assigns each header's body as "text from the end of this
// header to the start of the next header (or EOF)".
function findHeaderHits(body: string): HeaderHit[] {
  const hits: HeaderHit[] = [];
  for (const def of SECTION_DEFS) {
    for (const pat of def.patterns) {
      // Global-flag clone so we can iterate every match.
      const re = new RegExp(pat.source, pat.flags.includes("g") ? pat.flags : `${pat.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = re.exec(body)) !== null) {
        // De-dupe: if a more specific pattern already matched at this
        // exact start, skip. (Assessment&Plan is tried first; if it
        // matched, don't also record Assessment for the same span.)
        if (hits.some((h) => h.start === m!.index)) continue;
        hits.push({ start: m.index, end: m.index + m[0].length, key: def.key });
      }
    }
  }
  hits.sort((a, b) => a.start - b.start);
  return hits;
}

// Splits a combined "Assessment and Plan" block. Common formats:
//   1. <line> Plan: <text>   — explicit Plan sub-header → split there.
//   2. <numbered diagnoses with sub-bullets>  — keep together as
//      assessment, leave plan undefined; the coder uses assessment
//      for both. Better to over-include than to fragment a #1/#2/#3
//      structured A/P that has plan items nested under each diagnosis.
function splitAssessmentAndPlan(block: string): {
  assessment: string;
  plan?: string;
} {
  const planHeader = /^\s*(?:[*\-•]\s*)?\**\s*plan\b\s*\**\s*[:\-]?\s*$/im;
  const m = planHeader.exec(block);
  if (!m) return { assessment: block.trim() };
  return {
    assessment: block.slice(0, m.index).trim(),
    plan: block.slice(m.index + m[0].length).trim(),
  };
}

export function parseNoteSections(body: string): ParsedNoteSections {
  const normalized = body.replace(/\r\n/g, "\n");
  const hits = findHeaderHits(normalized);

  // No recognizable headers — dump everything into `other` so the AI
  // still has the note to work from. Empty notes return {}.
  if (hits.length === 0) {
    const trimmed = normalized.trim();
    return trimmed ? { other: trimmed } : {};
  }

  const result: ParsedNoteSections = {};

  // Preamble (text before the first header) — usually a chief-complaint
  // line or visit metadata. Park it in `other` so it isn't lost.
  const preamble = normalized.slice(0, hits[0]!.start).trim();
  if (preamble) result.other = preamble;

  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const nextStart = i + 1 < hits.length ? hits[i + 1]!.start : normalized.length;
    const block = normalized.slice(hit.end, nextStart).trim();
    if (!block) continue;

    if (hit.key === "assessmentAndPlan") {
      const { assessment, plan } = splitAssessmentAndPlan(block);
      if (assessment) {
        // Merge if multiple Assessment blocks exist (rare but possible
        // in long visits). Newline-separated to preserve readability.
        result.assessment = result.assessment
          ? `${result.assessment}\n\n${assessment}`
          : assessment;
      }
      if (plan) {
        result.plan = result.plan ? `${result.plan}\n\n${plan}` : plan;
      }
      continue;
    }

    const key = hit.key as keyof ParsedNoteSections;
    result[key] = result[key] ? `${result[key]}\n\n${block}` : block;
  }

  return result;
}
