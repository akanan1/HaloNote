// Pure-logic tests for the style-profile PHI guard. The full
// `refreshStyleProfile` path needs a DB + Anthropic client, so this
// suite covers the regex defensive layer in isolation — the only
// piece between "model hallucinated PHI" and "DB row of PHI".

import { describe, expect, it } from "vitest";
import { _PHI_GUARDS_FOR_TESTS } from "./style-profile";

function tripsAnyGuard(text: string): boolean {
  return _PHI_GUARDS_FOR_TESTS.some((re) => re.test(text));
}

describe("style-profile PHI guard", () => {
  // Positive cases — these patterns appearing in a "style profile"
  // are red flags. The guard must trip.
  it.each([
    ["MRN-12345", "MRN-12345 appears in note"],
    ["mrn 99887766", "Patient ID is mrn 99887766"],
    ["MRN AB123CD", "Stamped MRN AB123CD on top-right"],
    ["SSN 123-45-6789", "SSN 123-45-6789 was redacted manually"],
    ["ISO date", "Last seen on 2025-12-31"],
    ["US slash date", "DOB 12/31/1979 noted in problem list"],
    ["phone with parens", "Reached at (415) 555-1212"],
    ["phone with dashes", "Cell 415-555-1212"],
    ["plain email", "Contact: name@example.com"],
  ])("trips on %s", (_label, input) => {
    expect(tripsAnyGuard(input)).toBe(true);
  });

  // Negative cases — these are legitimate style descriptors that
  // the guard must NOT confuse with PHI.
  it.each([
    [
      "abbreviation list",
      "Uses 'c/o' for complains of, '+ve' for positive, 'neg' for negative.",
    ],
    [
      "section ordering",
      "Writes Subjective as a paragraph, Objective as bullets, Assessment as a numbered problem list.",
    ],
    [
      "voice descriptors",
      "Third-person past tense; uses the patient's first name on first mention only.",
    ],
    [
      "version-like numbers",
      "Plan typically has 3-5 bullets keyed to assessment problems.",
    ],
    [
      "year mentioned without full date",
      "Sentence cadence: 12-18 words per clause on average.",
    ],
  ])("does NOT trip on %s", (_label, input) => {
    expect(tripsAnyGuard(input)).toBe(false);
  });
});
