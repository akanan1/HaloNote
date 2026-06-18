import {
  FhirError,
  type AllergyIntolerance as FhirAllergyIntolerance,
  type Bundle,
  type Condition as FhirCondition,
  type DocumentReference as FhirDocumentReference,
  type FhirClient,
  type MedicationRequest as FhirMedicationRequest,
} from "@workspace/ehr";
import { getAthenahealthClient } from "./athena";
import { getEpicClient } from "./epic";
import {
  getAthenahealthClientForUser,
  getCernerClientForUser,
} from "./ehr-user-client";
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
  userId?: string,
): Promise<PatientHistory> {
  if (userId) {
    // Cerner first: it's the active residency-pilot path. A user who
    // launched via Cerner has a `cerner` connection but no Athena
    // one, and falling through to the env-driven Athena/Epic client
    // would return another tenant's chart data — wrong-patient risk
    // we must not ship.
    const cernerClient = await getCernerClientForUser(userId);
    if (cernerClient) {
      return runHistoryFetch(cernerClient.fhir, ehrPatientId);
    }
    const athenaClient = await getAthenahealthClientForUser(userId);
    if (athenaClient) {
      return runHistoryFetch(athenaClient.fhir, ehrPatientId);
    }
  }
  const provider = resolveProvider();
  if (provider === "mock") {
    return buildMockHistory(ehrPatientId);
  }
  const client =
    provider === "athenahealth" ? getAthenahealthClient() : getEpicClient();
  return runHistoryFetch(client.fhir, ehrPatientId);
}

async function runHistoryFetch(
  fhir: FhirClient,
  ehrPatientId: string,
): Promise<PatientHistory> {
  try {
    // Three parallel searches; each one is its own FHIR call but the
    // server doesn't pay for sequencing them.
    const [conditions, meds, allergies] = await Promise.all([
      fhir.search<FhirCondition>("Condition", {
        patient: ehrPatientId,
        "clinical-status": "active",
        _count: 50,
      }),
      fhir.search<FhirMedicationRequest>("MedicationRequest", {
        patient: ehrPatientId,
        status: "active",
        _count: 50,
      }),
      fhir.search<FhirAllergyIntolerance>("AllergyIntolerance", {
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

// ---------------------------------------------------------------------------
// Prior chart notes — Phase 33
//
// The recording-pipeline used to only see notes HaloNote itself
// generated. For a freshly-onboarded patient (or a doctor's first
// week on the platform) that meant zero prior context, even though
// the EHR's chart was full of history. Pulling the patient's
// DocumentReferences from Athena/Epic/Cerner closes the gap.
//
// We deliberately keep this in its own function (rather than folding
// into getPatientHistory) so the pipeline can decide to skip it on
// patients with abundant local notes — the LLM prompt budget is the
// constraint, not the FHIR call cost.
// ---------------------------------------------------------------------------

export interface PriorChartNote {
  /** EHR-side DocumentReference.id. */
  id: string;
  /** ISO 8601 datetime; "1970-01-01" sentinel when the EHR omitted date. */
  date: string;
  /** Best-effort title from DocumentReference.type/description. */
  title: string;
  /** Decoded inline text — only set when the EHR returned attachment.data
   *  and the contentType is text-like. PDFs, images, or url-only refs
   *  resolve to null and the caller surfaces a stub. */
  body: string | null;
}

export async function fetchPriorChartNotes(
  ehrPatientId: string,
  userId?: string,
  limit = 20,
): Promise<PriorChartNote[]> {
  if (userId) {
    const cernerClient = await getCernerClientForUser(userId);
    if (cernerClient) {
      return runDocRefFetch(cernerClient.fhir, ehrPatientId, limit);
    }
    const athenaClient = await getAthenahealthClientForUser(userId);
    if (athenaClient) {
      return runDocRefFetch(athenaClient.fhir, ehrPatientId, limit);
    }
  }
  const provider = resolveProvider();
  if (provider === "mock") {
    return buildMockChartNotes(ehrPatientId, limit);
  }
  const client =
    provider === "athenahealth" ? getAthenahealthClient() : getEpicClient();
  return runDocRefFetch(client.fhir, ehrPatientId, limit);
}

async function runDocRefFetch(
  fhir: FhirClient,
  ehrPatientId: string,
  limit: number,
): Promise<PriorChartNote[]> {
  try {
    // _sort=-date (descending) so the most recent notes are at the
    // top of the bundle. status=current excludes superseded /
    // entered-in-error rows — same shape filter notes.ts applies on
    // our own side.
    const bundle = await fhir.search<FhirDocumentReference>(
      "DocumentReference",
      {
        patient: ehrPatientId,
        status: "current",
        _sort: "-date",
        _count: limit,
      },
    );
    return extractChartNotes(bundle);
  } catch (err) {
    if (err instanceof FhirError) {
      // Don't propagate — the pipeline should still produce a note
      // even if the EHR's chart history is unreachable. Log the
      // status so a downstream observability dashboard can flag
      // repeat failures.
      logger.warn(
        { err, ehrPatientId, status: err.status },
        "chart-note fetch failed; pipeline will use local notes only",
      );
      return [];
    }
    throw err;
  }
}

function extractChartNotes(
  bundle: Bundle<FhirDocumentReference>,
): PriorChartNote[] {
  const out: PriorChartNote[] = [];
  for (const entry of bundle.entry ?? []) {
    const d = entry.resource;
    if (d?.resourceType !== "DocumentReference") continue;
    if (!d.id) continue;
    const title =
      d.type?.text ??
      d.type?.coding?.[0]?.display ??
      d.description ??
      "Chart note";
    const date = d.date ?? "1970-01-01";
    const body = decodeInlineText(d);
    out.push({ id: d.id, date, title, body });
  }
  return out;
}

// DocumentReference content is a list of attachments. We pick the
// first text-like one and base64-decode its `data` field. Returns
// null when nothing decodable is present — the caller turns that
// into a placeholder line in the prompt rather than a blank body.
function decodeInlineText(d: FhirDocumentReference): string | null {
  for (const c of d.content ?? []) {
    const att = c.attachment;
    if (!att?.data) continue;
    const ct = (att.contentType ?? "").toLowerCase();
    // Accept text/plain, text/html (stripped below in the pipeline if
    // needed), and the catch-all "text/*". Skip pdf/image — decoding
    // those into useful prompt context needs OCR we don't ship.
    if (!ct.startsWith("text/")) continue;
    try {
      return Buffer.from(att.data, "base64").toString("utf8");
    } catch {
      // Malformed base64 — skip this attachment, try the next.
      continue;
    }
  }
  return null;
}

// Per-patient chart-note stubs so the pipeline path is testable in
// dev without a sandbox connection. Generates dates relative to a
// fixed "now" so the snapshots are stable across local runs.
function buildMockChartNotes(
  ehrPatientId: string,
  limit: number,
): PriorChartNote[] {
  logger.info({ ehrPatientId }, "chart notes (mock)");
  switch (ehrPatientId) {
    case "pt_001":
      return [
        {
          id: "mock-pt001-2026-04-12",
          date: "2026-04-12T15:30:00Z",
          title: "Office Visit — Hypertension follow-up",
          body:
            "Subjective: Marisol reports adherence to lisinopril. Home BP " +
            "log shows readings around 138/86. No chest pain, no edema.\n" +
            "Objective: BP 144/86 in office. HR 80. Weight 165 lb.\n" +
            "Assessment/Plan: HTN trending down on lisinopril 20 mg. " +
            "Continue current regimen. DM follow-up scheduled separately.",
        },
        {
          id: "mock-pt001-2026-03-21",
          date: "2026-03-21T09:00:00Z",
          title: "Office Visit — A1c review",
          body:
            "A1c 7.4% (down from 7.9 in December). Metformin 1g BID continued. " +
            "Discussed diet, exercise. F/u 3 months.",
        },
        {
          id: "mock-pt001-2026-02-14",
          date: "2026-02-14T10:15:00Z",
          title: "Office Visit — BP titration",
          body:
            "BP 158/94 in office. Increased lisinopril from 10 mg to 20 mg. " +
            "Recheck in 4-6 weeks.",
        },
      ].slice(0, limit);
    case "pt_003":
      return [
        {
          id: "mock-pt003-2026-05-05",
          date: "2026-05-05T13:00:00Z",
          title: "Office Visit — Neuropathy",
          body:
            "Burning sensation in both feet, worse at night. Trial of gabapentin " +
            "300 mg TID. Monitor.",
        },
      ].slice(0, limit);
    default:
      return [];
  }
}
