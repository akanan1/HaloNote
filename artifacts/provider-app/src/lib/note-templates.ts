export interface NoteTemplate {
  id: string;
  label: string;
  /**
   * Lowercase phrases that, when heard at the start of dictation, swap
   * to this template. Match is case-insensitive on the first ~30 chars
   * of the running transcript so a doctor can say "SOAP note for Mrs.
   * Aguirre, subjective: …" and have the template applied before the
   * rest of the dictation lands.
   */
  cues: string[];
  body: string;
}

export const NOTE_TEMPLATES: NoteTemplate[] = [
  {
    id: "soap",
    label: "SOAP",
    cues: ["soap note", "soap"],
    body:
      "Subjective:\n\n\n" +
      "Objective:\n\n\n" +
      "Assessment:\n\n\n" +
      "Plan:\n",
  },
  {
    id: "hp",
    label: "H&P",
    cues: ["history and physical", "h and p", "admission note", "admit note"],
    body:
      "Chief Complaint:\n\n" +
      "History of Present Illness:\n\n" +
      "Past Medical History:\n\n" +
      "Medications:\n\n" +
      "Allergies:\n\n" +
      "Review of Systems:\n\n" +
      "Physical Exam:\n\n" +
      "Assessment:\n\n" +
      "Plan:\n",
  },
  {
    id: "progress",
    label: "Progress",
    cues: ["progress note", "progress"],
    body:
      "Subjective:\n\n" +
      "Objective:\n\n" +
      "Assessment & Plan:\n",
  },
  {
    id: "consult",
    label: "Consult",
    cues: ["consultation note", "consult note", "consultation", "consult"],
    body:
      "Reason for Consultation:\n\n" +
      "History:\n\n" +
      "Exam:\n\n" +
      "Impression:\n\n" +
      "Recommendations:\n",
  },
  {
    id: "discharge",
    label: "Discharge",
    cues: ["discharge summary", "discharge note", "discharge"],
    body:
      "Admission Date:\n" +
      "Discharge Date:\n\n" +
      "Diagnoses:\n\n" +
      "Hospital Course:\n\n" +
      "Discharge Medications:\n\n" +
      "Follow-up:\n",
  },
];

/**
 * Match a chunk of running dictation against template cues. Returns the
 * matched template or null. Cues are matched against the first non-
 * trivial portion of `text` so the trigger phrase doesn't have to be
 * the entire transcript.
 *
 * Cue ordering inside each template's `cues` array matters: longer /
 * more specific phrases first so "soap note" wins over plain "soap"
 * when both match.
 */
export function detectTemplateFromVoice(text: string): NoteTemplate | null {
  const normalized = text.toLowerCase().replace(/[.,!?]/g, " ").trim();
  if (!normalized) return null;
  // Only inspect the first ~40 chars — past that we're into the body
  // of the dictation and shouldn't flip templates.
  const head = normalized.slice(0, 40);
  for (const template of NOTE_TEMPLATES) {
    for (const cue of template.cues) {
      if (head.startsWith(cue)) return template;
      // Allow a single leading filler word (e.g. "okay soap note …").
      if (head.startsWith(`okay ${cue}`)) return template;
      if (head.startsWith(`new ${cue}`)) return template;
      if (head.startsWith(`start ${cue}`)) return template;
    }
  }
  return null;
}

/**
 * Strip the cue phrase from the front of a transcript so the
 * "soap note" prefix isn't typed into the note body after the
 * template is applied.
 */
export function stripCueFromTranscript(text: string, template: NoteTemplate): string {
  const lower = text.toLowerCase();
  for (const cue of template.cues) {
    for (const prefix of ["", "okay ", "new ", "start "]) {
      const phrase = `${prefix}${cue}`;
      if (lower.startsWith(phrase)) {
        // Also eat trailing punctuation + whitespace after the cue.
        return text.slice(phrase.length).replace(/^[\s,.;:]+/, "");
      }
    }
  }
  return text;
}
