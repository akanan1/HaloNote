// Thin customFetch wrappers, one per server endpoint the encounter-review
// page touches. Lives next to types.ts and constants.ts so the page +
// panels share a single import surface. Replace with generated react-query
// hooks once @workspace/api-client-react covers these routes.

import { customFetch } from "@workspace/api-client-react";
import type {
  ApprovedBillingCode,
  ApprovedOrder,
  BillingResponse,
  BillingSuggestion,
  Encounter,
  EhrPushOutcome,
  GapAnalysisResponse,
  MedicationPatch,
  Note,
  NoteListResponse,
  OrderSuggestion,
  OrderSuggestResponse,
  OrdersResponse,
  Patient,
  PatientSummary,
  RefineResponse,
  SuggestResponse,
  SummaryLanguage,
  Task,
  TaskGenerateResponse,
  TaskListResponse,
  VitalsResponse,
  VitalTrendsResponse,
} from "./types";

// ---- Encounter + patient + note --------------------------------------------

export async function fetchEncounter(id: string): Promise<Encounter> {
  return customFetch<Encounter>(`/api/encounters/${id}`);
}

export async function fetchEncounterAuditTimeline(
  id: string,
): Promise<{ data: import("./types").EncounterAuditEvent[] }> {
  return customFetch<{ data: import("./types").EncounterAuditEvent[] }>(
    `/api/encounters/${id}/audit-timeline`,
  );
}

export async function fetchPatient(id: string): Promise<Patient> {
  return customFetch<Patient>(`/api/patients/${id}`);
}

export async function fetchNoteForEncounter(
  encId: string,
): Promise<Note | null> {
  // No GET /encounters/:id/notes endpoint yet — use the existing list
  // filtered by patient and find the one tied to this encounter.
  // Inefficient on a busy patient but correct; replace with a focused
  // endpoint in a polish pass.
  const r = await customFetch<NoteListResponse>(`/api/notes?limit=50`);
  return r.data.find((n) => n.encounterId === encId) ?? null;
}

export async function approveNote(noteId: string): Promise<Note> {
  return customFetch<Note>(`/api/notes/${noteId}/approve`, { method: "POST" });
}

export async function analyzeNoteGaps(
  noteId: string,
): Promise<GapAnalysisResponse> {
  return customFetch<GapAnalysisResponse>(
    `/api/notes/${noteId}/analyze-gaps`,
    { method: "POST" },
  );
}

export async function refineNote(
  noteId: string,
  instruction: string,
): Promise<RefineResponse> {
  return customFetch<RefineResponse>(`/api/notes/${noteId}/refine`, {
    method: "POST",
    body: JSON.stringify({ instruction }),
  });
}

// ---- Vitals ----------------------------------------------------------------

export async function extractVitals(noteId: string): Promise<VitalsResponse> {
  return customFetch<VitalsResponse>(
    `/api/notes/${noteId}/extract-vitals`,
    { method: "POST" },
  );
}

export async function fetchVitalTrends(
  patientId: string,
  excludeNoteId: string,
): Promise<VitalTrendsResponse> {
  const qs = new URLSearchParams({ excludeNoteId });
  return customFetch<VitalTrendsResponse>(
    `/api/patients/${patientId}/vital-trends?${qs.toString()}`,
  );
}

// ---- Patient summary -------------------------------------------------------

export async function generatePatientSummary(
  noteId: string,
  language: SummaryLanguage,
): Promise<PatientSummary> {
  return customFetch<PatientSummary>(
    `/api/notes/${noteId}/generate-summary?lang=${encodeURIComponent(language)}`,
    { method: "POST" },
  );
}

// ---- Billing ---------------------------------------------------------------

export async function fetchBilling(encId: string): Promise<BillingResponse> {
  return customFetch<BillingResponse>(`/api/encounters/${encId}/billing`);
}

export async function suggestBilling(encId: string): Promise<SuggestResponse> {
  return customFetch<SuggestResponse>(
    `/api/encounters/${encId}/billing/suggest`,
    { method: "POST" },
  );
}

export async function approveSuggestion(
  id: string,
  ackBlock = false,
): Promise<ApprovedBillingCode> {
  return customFetch<ApprovedBillingCode>(
    `/api/billing/suggestions/${id}/approve`,
    {
      method: "POST",
      body: JSON.stringify({ acknowledgeBlockingGaps: ackBlock }),
    },
  );
}

export async function rejectSuggestion(
  id: string,
  reason: string,
): Promise<BillingSuggestion> {
  return customFetch<BillingSuggestion>(
    `/api/billing/suggestions/${id}/reject`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}

// ---- Coder (Phase 1B) ------------------------------------------------------

import type {
  ApproveAllCodingResponse,
  CodingSessionWithSuggestions,
  CodingSuggestion,
  Confidence,
} from "./types";

export async function fetchCodingSession(
  encId: string,
): Promise<CodingSessionWithSuggestions | null> {
  // 404 when the encounter hasn't been Coder-coded yet — that's the
  // expected pre-approval state, not an error. Swallow it and return
  // null so the panel can render its empty state.
  try {
    return await customFetch<CodingSessionWithSuggestions>(
      `/api/encounters/${encId}/coding/session`,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("404")) return null;
    throw err;
  }
}

export async function generateCoding(
  encId: string,
): Promise<CodingSessionWithSuggestions> {
  return customFetch<CodingSessionWithSuggestions>(
    `/api/encounters/${encId}/coding/generate`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function editCodingSuggestion(
  id: string,
  body: { editedCode: string; editedDescription: string; reason?: string },
): Promise<CodingSuggestion> {
  return customFetch<CodingSuggestion>(
    `/api/coding/suggestions/${id}/edit`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

export async function approveAllHighConfidenceCoding(
  sessionId: string,
  minConfidence?: Confidence,
): Promise<ApproveAllCodingResponse> {
  return customFetch<ApproveAllCodingResponse>(
    `/api/coding/sessions/${sessionId}/approve-all-high-confidence`,
    {
      method: "POST",
      body: JSON.stringify(minConfidence ? { minConfidence } : {}),
    },
  );
}

// ---- Refine (HaloNote's twist on CarePilot's refine) ----------------------

import type {
  RefineAllResponse,
  RefinementOption,
  RefineSuggestionResponse,
} from "./types";

export async function refineCodingSuggestion(
  suggestionId: string,
): Promise<RefineSuggestionResponse> {
  return customFetch<RefineSuggestionResponse>(
    `/api/coding/suggestions/${suggestionId}/refine`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function refineAllInSession(
  sessionId: string,
): Promise<RefineAllResponse> {
  return customFetch<RefineAllResponse>(
    `/api/coding/sessions/${sessionId}/refine-all`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function applyCodingRefinement(
  suggestionId: string,
  chosen: RefinementOption,
): Promise<CodingSuggestion> {
  return customFetch<CodingSuggestion>(
    `/api/coding/suggestions/${suggestionId}/apply-refinement`,
    {
      method: "POST",
      body: JSON.stringify({
        chosenCode: chosen.code,
        chosenDescription: chosen.description,
        chosenHccCategory: chosen.hccCategory ?? null,
        hccUnlocked: chosen.hccUnlocked,
      }),
    },
  );
}

// ---- Problem list (Phase 2) ------------------------------------------------

import type {
  PatientProblem,
  ProblemListSuggestion,
  ProblemSuggestionsResponse,
  ReconcileResponse,
} from "./types";

export async function fetchProblemSuggestions(
  sessionId: string,
): Promise<ProblemSuggestionsResponse> {
  return customFetch<ProblemSuggestionsResponse>(
    `/api/coding/sessions/${sessionId}/problem-suggestions`,
  );
}

export async function reconcileProblems(
  sessionId: string,
): Promise<ReconcileResponse> {
  return customFetch<ReconcileResponse>(
    `/api/coding/sessions/${sessionId}/reconcile-problems`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function acceptProblemSuggestion(
  id: string,
  reason?: string,
): Promise<ProblemListSuggestion> {
  return customFetch<ProblemListSuggestion>(
    `/api/problem-list-suggestions/${id}/accept`,
    {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
    },
  );
}

export async function rejectProblemSuggestion(
  id: string,
  reason: string,
): Promise<ProblemListSuggestion> {
  return customFetch<ProblemListSuggestion>(
    `/api/problem-list-suggestions/${id}/reject`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}

export async function fetchPatientProblems(
  patientId: string,
): Promise<{ data: PatientProblem[] }> {
  return customFetch<{ data: PatientProblem[] }>(
    `/api/patients/${patientId}/problems`,
  );
}

// ---- Athena note ingestion (Phase 3) ---------------------------------------

export interface AthenaNoteCandidate {
  documentReferenceId: string;
  date: string | null;
  description: string | null;
  encounterEhrRef: string | null;
  contentType: string | null;
}

export async function fetchAthenaNoteCandidates(
  patientId: string,
): Promise<{ data: AthenaNoteCandidate[] }> {
  return customFetch<{ data: AthenaNoteCandidate[] }>(
    `/api/patients/${patientId}/athena-notes`,
  );
}

export async function ingestAthenaNote(
  encounterId: string,
  athenaDocumentReferenceId: string,
): Promise<CodingSessionWithSuggestions & { noteId: string; noteSource: "athena" | "mock" }> {
  return customFetch<
    CodingSessionWithSuggestions & {
      noteId: string;
      noteSource: "athena" | "mock";
    }
  >(`/api/encounters/${encounterId}/coding/ingest-athena-note`, {
    method: "POST",
    body: JSON.stringify({ athenaDocumentReferenceId }),
  });
}

// ---- Athena encounter linking ----------------------------------------------

export interface AthenaEncounterCandidate {
  encounterId: string;
  period: { start: string | null; end: string | null };
  status: string | null;
  classDisplay: string | null;
  typeDisplay: string | null;
}

export async function fetchAthenaEncounterCandidates(
  patientId: string,
): Promise<{ data: AthenaEncounterCandidate[] }> {
  return customFetch<{ data: AthenaEncounterCandidate[] }>(
    `/api/patients/${patientId}/athena-encounters`,
  );
}

export async function linkEncounterToAthena(
  encounterId: string,
  athenaEncounterId: string,
): Promise<{ id: string; ehrEncounterRef: string | null }> {
  return customFetch<{ id: string; ehrEncounterRef: string | null }>(
    `/api/encounters/${encounterId}`,
    {
      method: "PATCH",
      body: JSON.stringify({ ehrEncounterRef: athenaEncounterId }),
    },
  );
}

// ---- Orders ----------------------------------------------------------------

export async function fetchOrders(encId: string): Promise<OrdersResponse> {
  return customFetch<OrdersResponse>(`/api/encounters/${encId}/orders`);
}

export async function suggestOrders(
  encId: string,
): Promise<OrderSuggestResponse> {
  return customFetch<OrderSuggestResponse>(
    `/api/encounters/${encId}/orders/suggest`,
    { method: "POST" },
  );
}

export async function approveOrderSuggestion(
  id: string,
): Promise<ApprovedOrder> {
  return customFetch<ApprovedOrder>(
    `/api/orders/suggestions/${id}/approve`,
    { method: "POST" },
  );
}

export async function rejectOrderSuggestion(
  id: string,
  reason: string,
): Promise<OrderSuggestion> {
  return customFetch<OrderSuggestion>(
    `/api/orders/suggestions/${id}/reject`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}

export async function patchOrder(
  id: string,
  body: MedicationPatch,
): Promise<ApprovedOrder> {
  return customFetch<ApprovedOrder>(`/api/orders/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export async function markOrderExportReady(
  id: string,
): Promise<ApprovedOrder> {
  return customFetch<ApprovedOrder>(`/api/orders/${id}/mark-export-ready`, {
    method: "POST",
  });
}

// ---- EHR push --------------------------------------------------------------

export async function sendOrderToEhr(id: string): Promise<EhrPushOutcome> {
  return customFetch<EhrPushOutcome>(`/api/orders/${id}/send-to-ehr`, {
    method: "POST",
  });
}

export async function sendBillingCodeToEhr(
  id: string,
): Promise<EhrPushOutcome> {
  return customFetch<EhrPushOutcome>(
    `/api/billing/codes/${id}/send-to-ehr`,
    { method: "POST" },
  );
}

// Per-card retry for stranded billing codes — codes left with ehrError
// set + exportedAt null by a failed bulk-approve push. Distinct from
// sendBillingCodeToEhr above (which is the biller-driven happy-path
// export and gates on billerApprovedAt).
export async function retryBillingCodePush(
  id: string,
): Promise<EhrPushOutcome> {
  return customFetch<EhrPushOutcome>(
    `/api/billing/codes/${id}/retry-push`,
    { method: "POST" },
  );
}

// ---- Tasks -----------------------------------------------------------------

export async function fetchTasksForEncounter(
  encId: string,
): Promise<TaskListResponse> {
  // /api/tasks doesn't have an encounterId filter on the route (only
  // patientId / assignedUserId). Pull the assignee's list and filter
  // client-side — small N per encounter; revisit if a busy clinic
  // hits the 500-row default cap.
  const r = await customFetch<TaskListResponse>(
    `/api/tasks?assignedUserId=me&includeClosed=true`,
  );
  return { data: r.data.filter((t) => t.encounterId === encId) };
}

export async function generateTasksForEncounter(
  encId: string,
): Promise<TaskGenerateResponse> {
  return customFetch<TaskGenerateResponse>(
    `/api/encounters/${encId}/tasks/generate`,
    { method: "POST" },
  );
}

export async function completeTaskApi(id: string): Promise<Task> {
  return customFetch<Task>(`/api/tasks/${id}/complete`, { method: "POST" });
}
