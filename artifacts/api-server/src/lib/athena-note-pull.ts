// Pull a clinical note from Athena via FHIR DocumentReference. Returns
// the note text + a small metadata bundle suitable for materializing
// into the local `notes` table for the Athena-existing-note ingestion
// path (practices onboarding Coder without Scribe).
//
// Mock mode (default in dev) returns a synthetic note so the Coder
// pipeline runs end-to-end without an Athena connection. The mock text
// is deliberately recognizable so it's obvious to anyone reading the
// note that they're looking at a fixture, not a real chart entry.

import type {
  Bundle,
  DocumentReference as FhirDocumentReference,
  Encounter as FhirEncounter,
} from "@workspace/ehr/fhir";
import { FhirError } from "@workspace/ehr/fhir";
import { getAthenahealthClient } from "./athena";
import { logger } from "./logger";

export interface AthenaNoteRef {
  /** FHIR DocumentReference id, e.g. "DocumentReference/12345" → "12345". */
  documentReferenceId: string;
}

export interface AthenaNotePullResult {
  // The note text extracted from the FHIR Attachment. text/plain or
  // text/html (HTML gets stripped to text below).
  body: string;
  // FHIR Encounter reference the doc cites (when present). Lets the
  // ingestion route auto-link to the right local encounter when the
  // caller doesn't supply one.
  encounterEhrRef: string | null;
  // FHIR Patient reference. Used to confirm the doc actually belongs
  // to the patient the caller expects (defense-in-depth — Athena
  // shouldn't return cross-patient docs but we don't ship code that
  // assumes vendor behavior).
  patientEhrRef: string | null;
  // ISO datetime when the note was finalized in Athena. Falls back to
  // the DocumentReference.date when docStatus isn't 'final'.
  finalizedAt: string | null;
  // Author display name(s) — surfaced in the audit log so the local
  // record carries authorship information.
  authorDisplay: string | null;
  // Provider name for mock vs real distinction in the response.
  source: "athena" | "mock";
}

function resolveProvider(): "athenahealth" | "mock" {
  return process.env["EHR_MODE"]?.trim().toLowerCase() === "athenahealth"
    ? "athenahealth"
    : "mock";
}

// Decode an Attachment.data (base64) payload. FHIR encodes the body
// per RFC 4648 §4. Strip simple HTML tags so the downstream section
// parser doesn't have to. Anything fancier (rich PDF chart notes,
// embedded images) is out of scope for Phase 3 — those rare formats
// will fall through with a degraded body and the provider can paste
// the text in manually.
function decodeAttachment(att: NonNullable<FhirDocumentReference["content"][number]["attachment"]>): string | null {
  if (att.data) {
    try {
      const raw = Buffer.from(att.data, "base64").toString("utf8");
      return stripHtmlIfHtml(att.contentType ?? "text/plain", raw);
    } catch (err) {
      logger.warn({ err }, "athena-note-pull: failed to decode attachment data");
      return null;
    }
  }
  // Some Athena docs include only a URL pointer to the content rather
  // than inline data. Fetching a remote URL with the practice's bearer
  // token is a separate auth dance (the URL is often a non-FHIR
  // endpoint) — leaving that for a future iteration. Today we 422 the
  // caller and tell them what happened.
  return null;
}

function stripHtmlIfHtml(contentType: string, text: string): string {
  if (!/html/i.test(contentType)) return text;
  return text
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Pull a single doc by id. Used when the caller knows exactly which
// note to ingest (the typical flow: provider clicks a chart entry in
// Athena, copies the DocumentReference id, pastes it into the Coder).
export async function pullAthenaNote(
  ref: AthenaNoteRef,
): Promise<AthenaNotePullResult | { kind: "not_found" } | { kind: "no_text" }> {
  const provider = resolveProvider();
  if (provider !== "athenahealth") {
    return buildMockNote(ref.documentReferenceId);
  }

  let doc: FhirDocumentReference;
  try {
    const client = getAthenahealthClient();
    doc = await client.fhir.read<FhirDocumentReference>(
      "DocumentReference",
      ref.documentReferenceId,
    );
  } catch (err) {
    if (err instanceof FhirError && err.status === 404) {
      return { kind: "not_found" };
    }
    throw err;
  }

  // First text-bearing attachment wins. Athena typically ships one
  // text/html per doc.
  let body: string | null = null;
  for (const c of doc.content ?? []) {
    const decoded = decodeAttachment(c.attachment);
    if (decoded && decoded.trim().length > 0) {
      body = decoded;
      break;
    }
  }
  if (!body) return { kind: "no_text" };

  return {
    body,
    encounterEhrRef: doc.context?.encounter?.[0]?.reference ?? null,
    patientEhrRef: doc.subject?.reference ?? null,
    finalizedAt: doc.date ?? null,
    authorDisplay:
      doc.author?.map((a) => a.display).filter(Boolean).join(", ") || null,
    source: "athena",
  };
}

// List recent DocumentReferences for a patient — gives the ingestion
// UI a picker rather than forcing the provider to copy/paste ids.
// Filtered to docStatus=final by default; you can preview drafts in
// Athena but you shouldn't be coding off them.
export interface AthenaNoteCandidate {
  documentReferenceId: string;
  date: string | null;
  description: string | null;
  encounterEhrRef: string | null;
  contentType: string | null;
}

export async function listRecentAthenaNotes(
  ehrPatientId: string,
  limit = 25,
): Promise<AthenaNoteCandidate[]> {
  const provider = resolveProvider();
  if (provider !== "athenahealth") {
    return buildMockCandidates(ehrPatientId);
  }

  let bundle: Bundle<FhirDocumentReference>;
  try {
    const client = getAthenahealthClient();
    bundle = await client.fhir.search<FhirDocumentReference>(
      "DocumentReference",
      {
        patient: ehrPatientId,
        "docstatus": "final",
        _count: limit,
        _sort: "-date",
      },
    );
  } catch (err) {
    logger.warn(
      { err, ehrPatientId },
      "athena-note-pull: listRecentAthenaNotes failed",
    );
    throw err;
  }

  const out: AthenaNoteCandidate[] = [];
  for (const entry of bundle.entry ?? []) {
    const d = entry.resource;
    if (d?.resourceType !== "DocumentReference" || !d.id) continue;
    out.push({
      documentReferenceId: d.id,
      date: d.date ?? null,
      description: d.description ?? d.type?.text ?? null,
      encounterEhrRef: d.context?.encounter?.[0]?.reference ?? null,
      contentType: d.content?.[0]?.attachment?.contentType ?? null,
    });
  }
  return out;
}

// -------- mock paths ------------------------------------------------------

function buildMockNote(documentReferenceId: string): AthenaNotePullResult {
  return {
    body: [
      "** MOCK NOTE — pulled via athena-note-pull mock mode **",
      "",
      "HPI: 64yo F with longstanding T2DM and HTN, here for routine f/u.",
      "Reports good adherence to metformin; no hypoglycemic episodes.",
      "Home BP 132/78. Energy good, no chest pain or SOB.",
      "",
      "ROS: Otherwise negative.",
      "",
      "Physical Exam: Well-appearing, NAD. BP 134/82, HR 78. Heart RRR.",
      "Lungs CTA. Feet without ulceration.",
      "",
      "Assessment:",
      "1. Type 2 diabetes mellitus with hyperglycemia, A1c 7.9 (improving).",
      "2. Essential hypertension, well-controlled.",
      "",
      "Plan:",
      "- Continue metformin 1000mg BID.",
      "- Continue lisinopril 20mg daily.",
      "- Repeat A1c in 3 months.",
      "- Annual diabetic eye exam due.",
      "",
      "Time: 25 minutes spent face-to-face, 60% in counseling/coordination of care.",
    ].join("\n"),
    encounterEhrRef: null,
    patientEhrRef: null,
    finalizedAt: new Date().toISOString(),
    authorDisplay: "Mock Provider, MD",
    source: "mock",
  };
}

// ---------------------------------------------------------------------------
// Encounter picker — for linking a local encounter row to its Athena
// chart entry. Reads FHIR Encounter resources for the patient, returns
// the minimal shape the UI needs (id + date + visit class).
// ---------------------------------------------------------------------------

export interface AthenaEncounterCandidate {
  encounterId: string;
  period: { start: string | null; end: string | null };
  status: string | null;
  classDisplay: string | null;
  typeDisplay: string | null;
}

export async function listRecentAthenaEncounters(
  ehrPatientId: string,
  limit = 25,
): Promise<AthenaEncounterCandidate[]> {
  const provider = resolveProvider();
  if (provider !== "athenahealth") {
    return buildMockEncounterCandidates(ehrPatientId);
  }
  let bundle: Bundle<FhirEncounter>;
  try {
    const client = getAthenahealthClient();
    bundle = await client.fhir.search<FhirEncounter>("Encounter", {
      patient: ehrPatientId,
      _count: limit,
      _sort: "-date",
    });
  } catch (err) {
    logger.warn(
      { err, ehrPatientId },
      "athena-note-pull: listRecentAthenaEncounters failed",
    );
    throw err;
  }

  const out: AthenaEncounterCandidate[] = [];
  for (const entry of bundle.entry ?? []) {
    const e = entry.resource;
    if (e?.resourceType !== "Encounter" || !e.id) continue;
    out.push({
      encounterId: e.id,
      period: {
        start: e.period?.start ?? null,
        end: e.period?.end ?? null,
      },
      status: e.status ?? null,
      classDisplay: e.class?.display ?? e.class?.code ?? null,
      typeDisplay:
        e.type?.[0]?.text ?? e.type?.[0]?.coding?.[0]?.display ?? null,
    });
  }
  return out;
}

function buildMockEncounterCandidates(
  ehrPatientId: string,
): AthenaEncounterCandidate[] {
  return [
    {
      encounterId: `mock-enc-${ehrPatientId}-1`,
      period: {
        start: new Date(Date.now() - 86400_000).toISOString(),
        end: new Date(Date.now() - 86400_000 + 1800_000).toISOString(),
      },
      status: "finished",
      classDisplay: "Office visit",
      typeDisplay: "Established patient (mock)",
    },
    {
      encounterId: `mock-enc-${ehrPatientId}-2`,
      period: {
        start: new Date(Date.now() - 86400_000 * 14).toISOString(),
        end: new Date(Date.now() - 86400_000 * 14 + 3600_000).toISOString(),
      },
      status: "finished",
      classDisplay: "Office visit",
      typeDisplay: "Annual physical (mock)",
    },
  ];
}

function buildMockCandidates(ehrPatientId: string): AthenaNoteCandidate[] {
  return [
    {
      documentReferenceId: `mock-doc-${ehrPatientId}-1`,
      date: new Date(Date.now() - 86400_000).toISOString(),
      description: "Office visit note (mock)",
      encounterEhrRef: null,
      contentType: "text/plain",
    },
    {
      documentReferenceId: `mock-doc-${ehrPatientId}-2`,
      date: new Date(Date.now() - 86400_000 * 14).toISOString(),
      description: "Annual physical (mock)",
      encounterEhrRef: null,
      contentType: "text/plain",
    },
  ];
}
