// Unit tests for the CDS dedupe layer + the data-shape gates that keep
// the LLM call from firing on transcripts/charts where there's nothing
// to check. Patient-safety surface — dedupe regressions become alarm-
// fatigue in production, so the guard stays under test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  filterAlreadyFired,
  suggestLiveCdsWarnings,
  type LiveCdsWarning,
} from "./live-cds";

describe("filterAlreadyFired", () => {
  it("returns the input unchanged when nothing has fired yet", () => {
    const incoming: LiveCdsWarning[] = [
      {
        kind: "allergy_interaction",
        severity: "block",
        message: "Patient is allergic to penicillin.",
      },
    ];
    const out = filterAlreadyFired(incoming, []);
    expect(out).toEqual(incoming);
  });

  it("drops warnings whose (kind, message) already fired", () => {
    const incoming: LiveCdsWarning[] = [
      {
        kind: "allergy_interaction",
        severity: "block",
        message: "Patient is allergic to penicillin.",
      },
      {
        kind: "duplicate_therapy",
        severity: "warn",
        message: "Already on metformin.",
      },
    ];
    const already = [
      {
        kind: "allergy_interaction",
        message: "Patient is allergic to penicillin.",
      },
    ];
    const out = filterAlreadyFired(incoming, already);
    expect(out).toHaveLength(1);
    expect(out[0]?.kind).toBe("duplicate_therapy");
  });

  it("treats kind+message as the dedupe key — same kind, different message survives", () => {
    const incoming: LiveCdsWarning[] = [
      {
        kind: "drug_drug_interaction",
        severity: "warn",
        message: "Lisinopril + spironolactone raises hyperkalemia risk.",
      },
    ];
    const already = [
      {
        kind: "drug_drug_interaction",
        message: "Lisinopril + NSAID increases renal risk.",
      },
    ];
    const out = filterAlreadyFired(incoming, already);
    expect(out).toEqual(incoming);
  });

  it("treats kind+message as the dedupe key — same message, different kind survives", () => {
    const incoming: LiveCdsWarning[] = [
      {
        kind: "dose_warning",
        severity: "warn",
        message: "Verify dosing.",
      },
    ];
    const already = [{ kind: "other", message: "Verify dosing." }];
    const out = filterAlreadyFired(incoming, already);
    expect(out).toEqual(incoming);
  });

  it("does not mutate the input arrays", () => {
    const incoming: LiveCdsWarning[] = [
      {
        kind: "allergy_interaction",
        severity: "block",
        message: "Penicillin allergy.",
      },
    ];
    const already = [
      { kind: "allergy_interaction", message: "Penicillin allergy." },
    ];
    filterAlreadyFired(incoming, already);
    expect(incoming).toHaveLength(1);
    expect(already).toHaveLength(1);
  });
});

describe("suggestLiveCdsWarnings — short-circuit gates", () => {
  const realEnv = process.env["ANTHROPIC_API_KEY"];
  beforeEach(() => {
    // Force the API key on so we're definitely testing the other gates,
    // not the mock-mode early return. The mock-mode case is the simplest
    // gate and is already covered by the live-billing pattern.
    process.env["ANTHROPIC_API_KEY"] = "test-key-not-used";
  });
  afterEach(() => {
    if (realEnv === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = realEnv;
    vi.restoreAllMocks();
  });

  it("returns [] when the transcript is shorter than 150 chars", async () => {
    const out = await suggestLiveCdsWarnings({
      transcript: "Hi, how are you today?",
      chart: {
        activeMeds: ["Lisinopril 20mg daily"],
        allergies: ["Penicillin"],
        conditions: ["Hypertension"],
      },
      alreadyFired: [],
    });
    expect(out).toEqual([]);
  });

  it("returns [] when chart is empty (all three arrays empty)", async () => {
    const long = "A ".repeat(200); // > 150 chars
    const out = await suggestLiveCdsWarnings({
      transcript: long,
      chart: { activeMeds: [], allergies: [], conditions: [] },
      alreadyFired: [],
    });
    expect(out).toEqual([]);
  });

  it("returns [] when ANTHROPIC_API_KEY is unset (mock mode)", async () => {
    delete process.env["ANTHROPIC_API_KEY"];
    const long = "A ".repeat(200);
    const out = await suggestLiveCdsWarnings({
      transcript: long,
      chart: {
        activeMeds: ["Lisinopril 20mg daily"],
        allergies: ["Penicillin"],
        conditions: ["Hypertension"],
      },
      alreadyFired: [],
    });
    expect(out).toEqual([]);
  });
});
