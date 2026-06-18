// Built-in suggestion catalog the provider can adopt during
// onboarding (or any time after). These are NOT seeded automatically
// — a provider sees them in Settings and clicks to add the ones they
// want. The rule text is what the recording pipeline hands to Claude.
//
// Kept as a hand-edited list rather than a DB row because (a) it's
// the same for every provider, (b) we want PRs / code review when
// editing the wording, and (c) bumping the catalog is a small,
// reversible deploy not a data migration.

export interface NoteDefaultSuggestion {
  key: string;
  label: string;
  description: string;
  rule: string;
}

export const NOTE_DEFAULT_SUGGESTIONS: ReadonlyArray<NoteDefaultSuggestion> = [
  {
    key: "ros-default-negative",
    label: "14-point ROS negative unless stated",
    description:
      "If the review of systems is not explicitly addressed, document a 14-point ROS as negative except for any complaints raised in the HPI.",
    rule:
      "If the transcript does not explicitly address the review of systems, " +
      "document under 'Review of Systems' a 14-point ROS (Constitutional, " +
      "Eyes, ENT, Cardiovascular, Respiratory, Gastrointestinal, " +
      "Genitourinary, Musculoskeletal, Integumentary, Neurological, " +
      "Psychiatric, Endocrine, Hematologic/Lymphatic, Allergic/Immunologic) " +
      "as 'reviewed and negative except as noted in the HPI'. If a system is " +
      "addressed in the transcript, document the actual finding for that " +
      "system; do not override a stated finding with the default.",
  },
  {
    key: "vitals-default",
    label: "Vitals block always included",
    description:
      "Always include a Vitals block in the Objective section. Use the values heard in the conversation; placeholder dashes where not spoken.",
    rule:
      "Always include a 'Vitals:' block at the top of the Objective section " +
      "listing BP, HR, RR, T, SpO2. Use the numeric values heard in the " +
      "transcript when present. For each vital not mentioned, write '—' " +
      "(em dash) rather than omitting the field, so the provider can fill " +
      "it in by hand on review.",
  },
  {
    key: "exam-default-normal",
    label: "Physical exam normal unless contradicted",
    description:
      "Default each physical exam section to 'within normal limits' unless the transcript describes an abnormal finding.",
    rule:
      "In the Physical Exam section, for each major system (General, HEENT, " +
      "Cardiovascular, Pulmonary, Abdomen, Musculoskeletal, Skin, " +
      "Neurologic, Psychiatric), document 'within normal limits' unless the " +
      "transcript explicitly describes an abnormal finding for that system. " +
      "When an abnormal finding is described, document the finding and skip " +
      "the WNL default for that system only.",
  },
  {
    key: "assessment-problem-list",
    label: "Assessment as a numbered problem list",
    description:
      "Structure the Assessment section as a numbered problem list, each item ending with the working ICD-10 description when known.",
    rule:
      "Format the Assessment section as a numbered problem list (1., 2., " +
      "3., …), one diagnosis per line. When the transcript or patient " +
      "context implies a working ICD-10 description, append it in " +
      "parentheses at the end of the line. Do not invent codes; if the " +
      "description is ambiguous, leave it off.",
  },
  {
    key: "plan-bulleted",
    label: "Plan as bullets keyed to the assessment",
    description:
      "Format the Plan as bullets, grouped under each assessment problem number.",
    rule:
      "Format the Plan section as bullets ('- '). When the Assessment is a " +
      "numbered problem list, group plan bullets under their corresponding " +
      "problem number using a sub-heading like 'For #1 — <problem>:'. Each " +
      "bullet is a concrete action (med, lab, referral, follow-up).",
  },
  {
    key: "follow-up-default",
    label: "Default follow-up interval if unspoken",
    description:
      "If no follow-up timing is mentioned, default to 'Follow up as needed; sooner if symptoms worsen'.",
    rule:
      "If the transcript does not specify a follow-up interval or timing, " +
      "close the Plan with: 'Follow up as needed; sooner if symptoms " +
      "worsen.' If the visit type implies a routine cadence (annual, " +
      "post-op), use that cadence instead.",
  },
];

export function getSuggestionByKey(
  key: string,
): NoteDefaultSuggestion | undefined {
  return NOTE_DEFAULT_SUGGESTIONS.find((s) => s.key === key);
}
