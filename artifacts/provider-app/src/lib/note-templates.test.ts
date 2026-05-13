import { describe, expect, it } from "vitest";
import {
  NOTE_TEMPLATES,
  detectTemplateFromVoice,
  stripCueFromTranscript,
} from "./note-templates";

const byId = (id: string) => NOTE_TEMPLATES.find((t) => t.id === id)!;

describe("detectTemplateFromVoice", () => {
  it("matches the basic phrase 'soap note'", () => {
    expect(detectTemplateFromVoice("soap note")?.id).toBe("soap");
  });

  it("matches 'history and physical' as H&P", () => {
    expect(detectTemplateFromVoice("history and physical")?.id).toBe("hp");
  });

  it("matches a leading filler word", () => {
    expect(detectTemplateFromVoice("okay soap note for Mrs. Smith")?.id).toBe(
      "soap",
    );
    expect(detectTemplateFromVoice("new progress note today")?.id).toBe(
      "progress",
    );
    expect(detectTemplateFromVoice("start consult note")?.id).toBe("consult");
  });

  it("prefers the longer, more specific cue when both match", () => {
    // "soap note" should win over "soap" alone.
    expect(detectTemplateFromVoice("soap note for the patient")?.id).toBe(
      "soap",
    );
  });

  it("ignores trivial punctuation", () => {
    expect(detectTemplateFromVoice("SOAP, note for chest pain")?.id).toBe(
      "soap",
    );
  });

  it("returns null when nothing in the head matches", () => {
    expect(detectTemplateFromVoice("the patient reports headache")).toBeNull();
  });

  it("does not match if the cue is buried far into the transcript", () => {
    // Past the 40-char head — shouldn't fire.
    const buried =
      "the patient reports chest pain with associated shortness of breath soap";
    expect(detectTemplateFromVoice(buried)).toBeNull();
  });
});

describe("stripCueFromTranscript", () => {
  it("strips the cue and following punctuation/space", () => {
    const result = stripCueFromTranscript(
      "SOAP note, patient reports headache",
      byId("soap"),
    );
    expect(result).toBe("patient reports headache");
  });

  it("strips an 'okay <cue>' prefix", () => {
    const result = stripCueFromTranscript(
      "okay soap note for Mrs. Smith",
      byId("soap"),
    );
    expect(result).toBe("for Mrs. Smith");
  });

  it("returns the transcript unchanged if no cue prefix matches", () => {
    const input = "patient is here for follow-up";
    expect(stripCueFromTranscript(input, byId("soap"))).toBe(input);
  });
});
