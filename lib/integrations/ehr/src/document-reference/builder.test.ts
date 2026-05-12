import { describe, it, expect } from "vitest";
import { buildDocumentReference } from "./builder";

describe("buildDocumentReference", () => {
  it("base64-encodes text content", () => {
    const doc = buildDocumentReference({
      patient: "Patient/123",
      content: { text: "hello" },
    });
    const attachment = doc.content[0]!.attachment;
    expect(attachment.contentType).toBe("text/plain");
    expect(attachment.data).toBe(Buffer.from("hello", "utf8").toString("base64"));
  });

  it("passes pre-encoded base64 through unchanged", () => {
    const data = Buffer.from("preencoded", "utf8").toString("base64");
    const doc = buildDocumentReference({
      patient: "Patient/123",
      content: { base64: data, contentType: "application/pdf" },
    });
    const attachment = doc.content[0]!.attachment;
    expect(attachment.data).toBe(data);
    expect(attachment.contentType).toBe("application/pdf");
  });

  it("throws when neither text nor base64 is provided", () => {
    expect(() =>
      buildDocumentReference({
        patient: "Patient/123",
        content: {},
      }),
    ).toThrow(/requires either `text` or `base64`/);
  });

  it("defaults type to LOINC 34109-9 'Note'", () => {
    const doc = buildDocumentReference({
      patient: "Patient/123",
      content: { text: "x" },
    });
    expect(doc.type?.coding?.[0]).toMatchObject({
      system: "http://loinc.org",
      code: "34109-9",
      display: "Note",
    });
  });

  it("defaults category to US-Core clinical-note", () => {
    const doc = buildDocumentReference({
      patient: "Patient/123",
      content: { text: "x" },
    });
    expect(doc.category).toBeDefined();
    expect(doc.category![0]!.coding?.[0]).toMatchObject({
      system:
        "http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category",
      code: "clinical-note",
    });
  });

  it("includes author and encounter references when supplied", () => {
    const doc = buildDocumentReference({
      patient: "Patient/123",
      author: "Practitioner/p-1",
      encounter: "Encounter/e-1",
      content: { text: "x" },
    });
    expect(doc.author?.[0]?.reference).toBe("Practitioner/p-1");
    expect(doc.context?.encounter?.[0]?.reference).toBe("Encounter/e-1");
  });

  it("uses provided date when given, otherwise a recent ISO timestamp", () => {
    const fixed = buildDocumentReference({
      patient: "Patient/123",
      date: "2024-01-15T12:00:00.000Z",
      content: { text: "x" },
    });
    expect(fixed.date).toBe("2024-01-15T12:00:00.000Z");

    const auto = buildDocumentReference({
      patient: "Patient/123",
      content: { text: "x" },
    });
    expect(Date.parse(auto.date!)).toBeGreaterThan(Date.now() - 5000);
  });

  it("status/docStatus default to current/final but override is respected", () => {
    const d1 = buildDocumentReference({
      patient: "Patient/123",
      content: { text: "x" },
    });
    expect(d1.status).toBe("current");
    expect(d1.docStatus).toBe("final");

    const d2 = buildDocumentReference({
      patient: "Patient/123",
      content: { text: "x" },
      status: "superseded",
      docStatus: "amended",
    });
    expect(d2.status).toBe("superseded");
    expect(d2.docStatus).toBe("amended");
  });
});
