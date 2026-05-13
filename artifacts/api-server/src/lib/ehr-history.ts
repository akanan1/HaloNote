import {
  FhirError,
  type AllergyIntolerance as FhirAllergyIntolerance,
  type Bundle,
  type Condition as FhirCondition,
  type MedicationRequest as FhirMedicationRequest,
} from "@workspace/ehr";
import { getAthenahealthClient } from "./athena";
import { getEpicClient } from "./epic";
import { logger } from "./logger";

export interface PatientHistoryProblem {
  id: string;
  text: string;
  onsetDate: string | null;
}

export interface PatientHistoryMedication {
  id: string;
  text: string;
  dosage: string | null;
}

export interface PatientHistoryAllergy {
  id: string;
  text: string;
  severity: string | null;
  reactions: string[];
}

export interface PatientHistory {
  problems: PatientHistoryProblem[];
  medications: PatientHistoryMedication[];
  allergies: PatientHistoryAllergy[];
}

export class HistoryError extends Error {
  override readonly name = "HistoryError";
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.status = status;
  }
}

function resolveProvider(): "athenahealth" | "epic" | "mock" {
  const mode = process.env["EHR_MODE"]?.trim().toLowerCase();
  if (mode === "athenahealth") return "athenahealth";
  if (mode === "epic") return "epic";
  return "mock";
}

/**
 * Pull a patient's clinical context from the EHR — three FHIR
 * searches in parallel: active Conditions, active MedicationRequests,
 * and AllergyIntolerances. Reduced to the bits a provider actually
 * scans pre-visit; raw FHIR resources stay inside this module so the
 * note UI never has to think in FHIR shapes.
 *
 * Mock mode returns realistic-ish data per the seeded demo patients
 * so the UI is testable without a sandbox.
 */
export async function getPatientHistory(
  ehrPatientId: string,
): Promise<PatientHistory> {
  const provider = resolveProvider();

  if (provider === "mock") {
    return buildMockHistory(ehrPatientId);
  }

  try {
    const client =
      provider === "athenahealth" ? getAthenahealthClient() : getEpicClient();

    // Three parallel searches; each one is its own FHIR call but the
    // server doesn't pay for sequencing them.
    const [conditions, meds, allergies] = await Promise.all([
      client.fhir.search<FhirCondition>("Condition", {
        patient: ehrPatientId,
        "clinical-status": "active",
        _count: 50,
      }),
      client.fhir.search<FhirMedicationRequest>("MedicationRequest", {
        patient: ehrPatientId,
        status: "active",
        _count: 50,
      }),
      client.fhir.search<FhirAllergyIntolerance>("AllergyIntolerance", {
        patient: ehrPatientId,
        _count: 50,
      }),
    ]);

    return {
      problems: extractProblems(conditions),
      medications: extractMedications(meds),
      allergies: extractAllergies(allergies),
    };
  } catch (err) {
    if (err instanceof FhirError) {
      throw new HistoryError(err.message, err.status === 404 ? 404 : 502);
    }
    throw err;
  }
}

function extractProblems(b: Bundle<FhirCondition>): PatientHistoryProblem[] {
  const out: PatientHistoryProblem[] = [];
  for (const entry of b.entry ?? []) {
    const c = entry.resource;
    if (c?.resourceType !== "Condition") continue;
    const text = c.code?.text ?? c.code?.coding?.[0]?.display;
    if (!text || !c.id) continue;
    out.push({
      id: c.id,
      text,
      onsetDate: c.onsetDateTime ?? c.recordedDate ?? null,
    });
  }
  return out;
}

function extractMedications(
  b: Bundle<FhirMedicationRequest>,
): PatientHistoryMedication[] {
  const out: PatientHistoryMedication[] = [];
  for (const entry of b.entry ?? []) {
    const m = entry.resource;
    if (m?.resourceType !== "MedicationRequest") continue;
    const text =
      m.medicationCodeableConcept?.text ??
      m.medicationCodeableConcept?.coding?.[0]?.display ??
      m.medicationReference?.display;
    if (!text || !m.id) continue;
    const dosage = m.dosageInstruction?.[0]?.text ?? null;
    out.push({ id: m.id, text, dosage });
  }
  return out;
}

function extractAllergies(
  b: Bundle<FhirAllergyIntolerance>,
): PatientHistoryAllergy[] {
  const out: PatientHistoryAllergy[] = [];
  for (const entry of b.entry ?? []) {
    const a = entry.resource;
    if (a?.resourceType !== "AllergyIntolerance") continue;
    const text = a.code?.text ?? a.code?.coding?.[0]?.display;
    if (!text || !a.id) continue;
    const reactions: string[] = [];
    let severity: string | null = null;
    for (const r of a.reaction ?? []) {
      if (r.severity && !severity) severity = r.severity;
      for (const m of r.manifestation ?? []) {
        const mtext = m.text ?? m.coding?.[0]?.display;
        if (mtext) reactions.push(mtext);
      }
    }
    out.push({ id: a.id, text, severity, reactions });
  }
  return out;
}

// Stitched per-patient mock so the UI has plausible context cards in
// dev. Keyed off the demo patient ids seeded by patients.ts.
function buildMockHistory(ehrPatientId: string): PatientHistory {
  logger.info({ ehrPatientId }, "patient history (mock)");
  switch (ehrPatientId) {
    case "pt_001": // Aguirre, Marisol
      return {
        problems: [
          { id: "p1", text: "Essential hypertension", onsetDate: "2019-03-12" },
          { id: "p2", text: "Type 2 diabetes mellitus", onsetDate: "2021-07-04" },
          { id: "p3", text: "Chronic kidney disease, stage 3", onsetDate: "2023-01-20" },
        ],
        medications: [
          { id: "m1", text: "Lisinopril 20 mg tablet", dosage: "1 tab PO daily" },
          { id: "m2", text: "Metformin 1000 mg tablet", dosage: "1 tab PO BID with meals" },
          { id: "m3", text: "Atorvastatin 40 mg tablet", dosage: "1 tab PO at bedtime" },
        ],
        allergies: [
          { id: "a1", text: "Penicillin", severity: "moderate", reactions: ["Hives"] },
        ],
      };
    case "pt_002": // Okafor, Daniel
      return {
        problems: [],
        medications: [],
        allergies: [{ id: "a1", text: "No known drug allergies", severity: null, reactions: [] }],
      };
    case "pt_003": // Bhattacharya, Priya
      return {
        problems: [
          { id: "p1", text: "Type 2 diabetes mellitus", onsetDate: "2017-11-02" },
          { id: "p2", text: "Diabetic neuropathy", onsetDate: "2022-05-15" },
        ],
        medications: [
          { id: "m1", text: "Insulin glargine 100 units/mL", dosage: "20 units subQ at bedtime" },
          { id: "m2", text: "Gabapentin 300 mg capsule", dosage: "1 cap PO TID" },
        ],
        allergies: [],
      };
    case "pt_004": // Tran, Wesley
      return {
        problems: [
          { id: "p1", text: "Patellofemoral pain syndrome, right knee", onsetDate: "2024-09-10" },
        ],
        medications: [
          { id: "m1", text: "Ibuprofen 600 mg tablet", dosage: "1 tab PO TID PRN pain" },
        ],
        allergies: [{ id: "a1", text: "Sulfa drugs", severity: "mild", reactions: ["Rash"] }],
      };
    default:
      return { problems: [], medications: [], allergies: [] };
  }
}
