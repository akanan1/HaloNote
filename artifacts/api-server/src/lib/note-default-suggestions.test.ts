// Sanity checks on the suggestion catalog. The list is hand-edited
// markdown wrapped in TS — invariants like "keys are unique" and
// "every entry has a non-empty rule" need a guardrail so a future
// edit can't silently break the onboarding flow.

import { describe, expect, it } from "vitest";
import {
  NOTE_DEFAULT_SUGGESTIONS,
  getSuggestionByKey,
} from "./note-default-suggestions";

describe("NOTE_DEFAULT_SUGGESTIONS catalog", () => {
  it("has a non-empty list", () => {
    expect(NOTE_DEFAULT_SUGGESTIONS.length).toBeGreaterThan(0);
  });

  it("uses unique keys (so the UI can dedupe adopted suggestions)", () => {
    const keys = NOTE_DEFAULT_SUGGESTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("uses unique labels (so the dedupe-by-label adoption check works)", () => {
    const labels = NOTE_DEFAULT_SUGGESTIONS.map((s) =>
      s.label.toLowerCase(),
    );
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("has a non-empty label, rule, and description for every entry", () => {
    for (const s of NOTE_DEFAULT_SUGGESTIONS) {
      expect(s.label.trim().length, `label for ${s.key}`).toBeGreaterThan(0);
      expect(s.rule.trim().length, `rule for ${s.key}`).toBeGreaterThan(0);
      expect(
        s.description.trim().length,
        `description for ${s.key}`,
      ).toBeGreaterThan(0);
    }
  });

  it("keeps rules under 1000 chars (matches OpenAPI maxLength)", () => {
    for (const s of NOTE_DEFAULT_SUGGESTIONS) {
      expect(s.rule.length, `rule length for ${s.key}`).toBeLessThanOrEqual(
        1000,
      );
    }
  });

  it("resolves by key", () => {
    const first = NOTE_DEFAULT_SUGGESTIONS[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(getSuggestionByKey(first.key)).toBe(first);
    expect(getSuggestionByKey("does-not-exist")).toBeUndefined();
  });
});
