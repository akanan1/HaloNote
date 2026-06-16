import { describe, expect, it } from "vitest";
import {
  buildPdfFilename,
  copyAvailability,
  formatAssessmentAndPlanForCopy,
  formatFullForCopy,
  formatPatientInstructionsForCopy,
  formatSoapForCopy,
  parseNoteSections,
} from "./note-export";

const META = {
  patientName: "Aguirre, Marisol",
  dateOfBirth: "1958-07-22",
  createdAt: "2026-05-17T15:30:00Z",
  providerName: "Dr. Bob Park",
};

const SOAP_NOTE = [
  "Subjective:",
  "58yo F with hx HTN p/w worsening fatigue x2 weeks.",
  "",
  "Objective:",
  "BP 156/94, HR 78, BMI 31.",
  "Lungs clear bilaterally.",
  "",
  "Assessment:",
  "1. Uncontrolled HTN.",
  "2. Fatigue, etiology unclear.",
  "",
  "Plan:",
  "- Increase lisinopril to 20mg daily",
  "- Recheck BP in 2 weeks",
  "",
  "Patient Instructions:",
  "Take new dose with breakfast. Call if BP > 180/110.",
].join("\n");

const COMBINED_AP_NOTE = [
  "Subjective:",
  "CP since 0600.",
  "",
  "A&P:",
  "Likely musculoskeletal — reassurance + NSAIDs prn.",
].join("\n");

const FREEFORM_NOTE =
  "Patient presented with chest pain. Vitals stable. Sent home with reassurance and PRN NSAIDs.";

describe("parseNoteSections — header detection", () => {
  it("parses a standard SOAP note with all sections", () => {
    const p = parseNoteSections(SOAP_NOTE);
    expect(p.subjective).toContain("worsening fatigue");
    expect(p.objective).toContain("BP 156/94");
    expect(p.assessment).toContain("Uncontrolled HTN");
    expect(p.plan).toContain("lisinopril");
    expect(p.patientInstructions).toContain("Take new dose");
    expect(p.assessmentAndPlan).toBeNull(); // separate, not combined
  });

  it("parses a note that uses combined A&P header", () => {
    const p = parseNoteSections(COMBINED_AP_NOTE);
    expect(p.subjective).toBe("CP since 0600.");
    expect(p.assessmentAndPlan).toContain("musculoskeletal");
    expect(p.assessment).toBeNull();
    expect(p.plan).toBeNull();
  });

  it("returns all nulls for free-form text without headers", () => {
    const p = parseNoteSections(FREEFORM_NOTE);
    expect(p.subjective).toBeNull();
    expect(p.objective).toBeNull();
    expect(p.assessment).toBeNull();
    expect(p.plan).toBeNull();
    expect(p.assessmentAndPlan).toBeNull();
    expect(p.patientInstructions).toBeNull();
    expect(p.full).toBe(FREEFORM_NOTE); // raw body preserved
  });

  it("is case-insensitive on the header line", () => {
    const p = parseNoteSections("SUBJECTIVE:\nfoo\n\nplan:\nbar");
    expect(p.subjective).toBe("foo");
    expect(p.plan).toBe("bar");
  });

  it("accepts shorthand single-letter S:/O:/A:/P: headers", () => {
    const p = parseNoteSections("S:\nx\n\nO:\ny\n\nA:\nz\n\nP:\nw");
    expect(p.subjective).toBe("x");
    expect(p.objective).toBe("y");
    expect(p.assessment).toBe("z");
    expect(p.plan).toBe("w");
  });

  it("ignores 'A:' that appears inline inside content, not as a header line", () => {
    // Header detection is line-anchored; inline mentions don't trigger.
    const p = parseNoteSections(
      "Assessment:\nPt notes 'A:' for severity scale, not a header.",
    );
    expect(p.assessment).toContain("severity scale");
  });

  it("recognizes alternative patient-instruction labels", () => {
    for (const label of [
      "Patient Instructions",
      "Patient instruction",
      "Discharge Instructions",
      "Return Precautions",
      "Instructions for Patient",
    ]) {
      const p = parseNoteSections(`${label}:\nfollow up in 2 weeks`);
      expect(p.patientInstructions).toBe("follow up in 2 weeks");
    }
  });

  it("skips empty sections", () => {
    const p = parseNoteSections("Assessment:\n\nPlan:\nactual plan content");
    expect(p.assessment).toBeNull();
    expect(p.plan).toBe("actual plan content");
  });
});

describe("copyAvailability", () => {
  it("only 'full' is enabled for a free-form note", () => {
    const a = copyAvailability(parseNoteSections(FREEFORM_NOTE));
    expect(a).toEqual({
      full: true,
      soap: false,
      assessmentAndPlan: false,
      patientInstructions: false,
    });
  });

  it("all enabled for a complete SOAP note with instructions", () => {
    const a = copyAvailability(parseNoteSections(SOAP_NOTE));
    expect(a).toEqual({
      full: true,
      soap: true,
      assessmentAndPlan: true,
      patientInstructions: true,
    });
  });

  it("soap and a&p enabled when only the combined A&P block is present", () => {
    const a = copyAvailability(parseNoteSections(COMBINED_AP_NOTE));
    expect(a.full).toBe(true);
    expect(a.soap).toBe(true);
    expect(a.assessmentAndPlan).toBe(true);
    expect(a.patientInstructions).toBe(false);
  });
});

describe("format*ForCopy — output includes the header but never invents PHI", () => {
  it("full copy embeds patient + date + provider header followed by raw body", () => {
    const out = formatFullForCopy(parseNoteSections(SOAP_NOTE), META);
    expect(out).toContain("CLINICAL NOTE");
    expect(out).toContain("Patient: Aguirre, Marisol");
    expect(out).toContain("DOB: 1958-07-22");
    expect(out).toContain("Provider: Dr. Bob Park");
    // Raw body still present verbatim (after the header).
    expect(out).toContain("worsening fatigue x2 weeks");
  });

  it("omits header fields the caller did not supply (no PHI invention)", () => {
    const out = formatFullForCopy(parseNoteSections(SOAP_NOTE), {
      createdAt: META.createdAt,
    });
    expect(out).not.toContain("Patient:");
    expect(out).not.toContain("DOB:");
    expect(out).not.toContain("Provider:");
    expect(out).toContain("Date:");
  });

  it("SOAP copy excludes patient-instructions section", () => {
    const out = formatSoapForCopy(parseNoteSections(SOAP_NOTE), META)!;
    expect(out).toContain("SUBJECTIVE");
    expect(out).toContain("ASSESSMENT");
    expect(out).toContain("PLAN");
    expect(out).not.toContain("PATIENT INSTRUCTIONS");
  });

  it("SOAP copy returns null for a free-form note", () => {
    expect(formatSoapForCopy(parseNoteSections(FREEFORM_NOTE), META)).toBeNull();
  });

  it("A&P copy uses the combined block when present", () => {
    const out = formatAssessmentAndPlanForCopy(
      parseNoteSections(COMBINED_AP_NOTE),
      META,
    )!;
    expect(out).toContain("ASSESSMENT & PLAN");
    expect(out).toContain("musculoskeletal");
    expect(out).not.toContain("CP since 0600"); // S section excluded
  });

  it("A&P copy combines separate A and P sections when no combined block", () => {
    const out = formatAssessmentAndPlanForCopy(
      parseNoteSections(SOAP_NOTE),
      META,
    )!;
    expect(out).toContain("ASSESSMENT");
    expect(out).toContain("PLAN");
    expect(out).not.toContain("SUBJECTIVE");
    expect(out).not.toContain("OBJECTIVE");
    expect(out).not.toContain("PATIENT INSTRUCTIONS");
  });

  it("A&P copy returns null when neither A, P, nor combined is present", () => {
    expect(
      formatAssessmentAndPlanForCopy(parseNoteSections(FREEFORM_NOTE), META),
    ).toBeNull();
  });

  it("patient instructions copy returns null when section absent", () => {
    expect(
      formatPatientInstructionsForCopy(parseNoteSections(COMBINED_AP_NOTE), META),
    ).toBeNull();
  });

  it("patient instructions copy includes only that section", () => {
    const out = formatPatientInstructionsForCopy(
      parseNoteSections(SOAP_NOTE),
      META,
    )!;
    expect(out).toContain("PATIENT INSTRUCTIONS");
    expect(out).toContain("Take new dose");
    expect(out).not.toContain("Uncontrolled HTN");
  });
});

describe("buildPdfFilename", () => {
  it("emits a clinical-looking, filesystem-safe filename", () => {
    expect(
      buildPdfFilename("Aguirre, Marisol", "2026-05-17T15:30:00Z"),
    ).toBe("halo-note-Aguirre-Marisol-2026-05-17.pdf");
  });

  it("falls back to 'patient' when no name is provided", () => {
    expect(buildPdfFilename(undefined, "2026-05-17T15:30:00Z")).toBe(
      "halo-note-patient-2026-05-17.pdf",
    );
  });

  it("strips dangerous filename chars", () => {
    const out = buildPdfFilename(
      "../etc/passwd<script>",
      "2026-05-17T15:30:00Z",
    );
    expect(out).not.toContain("/");
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).toMatch(/^halo-note-[A-Za-z0-9-]+-2026-05-17\.pdf$/);
  });
});
