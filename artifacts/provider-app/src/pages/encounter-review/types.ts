// Wire types hand-mirrored against the API serializers. These should
// eventually be replaced by `@workspace/api-client-react` generated
// types — the unblocker is adding the matching schemas to openapi.yaml.
// Until then this file is the canonical local source of truth for the
// encounter-review page and the panels it spawns.
//
// Why omit organizationId / updatedAt that exist on the server-side
// shape: the page only consumes a client-facing subset. Keeping the
// types narrow makes accidental over-fetching obvious in PR diffs.

// ---------------------------------------------------------------------------
// Encounter
// ---------------------------------------------------------------------------

export type EncounterStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "cancelled";

export type VisitType =
  | "new_patient"
  | "established_patient"
  | "follow_up"
  | "annual_physical"
  | "hospital_follow_up"
  | "procedure"
  | "telehealth"
  | "nursing_facility"
  | "custom";

export interface Encounter {
  id: string;
  patientId: string;
  providerId: string | null;
  visitType: VisitType;
  customLabel: string | null;
  status: EncounterStatus;
  isTelehealth: boolean;
  location: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  ehrEncounterRef: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Patient
// ---------------------------------------------------------------------------

export interface Patient {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  mrn: string;
}

// ---------------------------------------------------------------------------
// Note
// ---------------------------------------------------------------------------

export type NoteStatus =
  | "draft"
  | "approved"
  | "exported"
  | "entered-in-error"
  | "active";

export interface Note {
  id: string;
  patientId: string;
  encounterId: string | null;
  body: string;
  status: NoteStatus;
  approvedAt: string | null;
  approvedByUserId: string | null;
  signedNoteHash: string | null;
  ehrPushedAt: string | null;
  ehrError: string | null;
}

export interface NoteListResponse {
  data: Note[];
}

export interface NoteGap {
  field: string;
  message: string;
  suggestedResolution?: string;
  locationHint?: string;
  severity: "info" | "warn" | "block";
}

export interface GapAnalysisResponse {
  gaps: NoteGap[];
  summary: string;
  source: "ai" | "stub";
}

export interface RefineResponse {
  note: { id: string; body: string; updatedAt: string };
  changeSummary: string;
  source: "ai" | "stub";
}

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export type CodeSystem = "icd10" | "cpt" | "em" | "modifier";
export type Confidence = "low" | "medium" | "high";
export type SuggestionStatus =
  | "ai_suggested"
  | "needs_review"
  | "provider_approved"
  | "biller_approved"
  | "rejected"
  | "exported";

export interface DocumentationGap {
  field: string;
  message: string;
  severity: "info" | "warn" | "block";
}

export interface SupportingExcerpt {
  text: string;
  locationHint?: string;
}

export interface BillingSuggestion {
  id: string;
  codeSystem: CodeSystem;
  code: string;
  description: string;
  rationale: string;
  supportingExcerpts: SupportingExcerpt[];
  documentationGaps: DocumentationGap[];
  confidence: Confidence;
  status: SuggestionStatus;
  createdByAi: boolean;
}

export interface ApprovedBillingCode {
  id: string;
  codeSystem: CodeSystem;
  code: string;
  description: string;
  sourceSuggestionId: string | null;
  approvedAt: string | null;
  billerApprovedAt: string | null;
  exportedAt: string | null;
  ehrDocumentRef: string | null;
  ehrError: string | null;
}

export interface BillingResponse {
  suggestions: BillingSuggestion[];
  approvedCodes: ApprovedBillingCode[];
}

export interface SuggestResponse {
  data: BillingSuggestion[];
  source: "ai" | "stub";
}

// ---------------------------------------------------------------------------
// Coder (Phase 1B) — richer ICD/CPT/E&M/modifier suggestions with section
// attribution + HCC capture + session tracking. Distinct from the lightweight
// /billing/suggest above, which still powers the live billing tab.
// ---------------------------------------------------------------------------

export type CodingNoteSource = "halonote_scribe" | "athena_existing";

export type CodingSessionStatus =
  | "queued"
  | "extracting"
  | "ready"
  | "approved"
  | "writing"
  | "complete"
  | "failed";

export type CodingSectionKey =
  | "assessment"
  | "plan"
  | "hpi"
  | "ros"
  | "physical_exam"
  | "procedures"
  | "orders"
  | "mdm"
  | "time"
  | "other";

export interface CodingParsedSections {
  assessment?: string;
  plan?: string;
  hpi?: string;
  ros?: string;
  physicalExam?: string;
  procedures?: string;
  orders?: string;
  mdm?: string;
  time?: string;
  other?: string;
}

export interface EncounterCodingSession {
  id: string;
  organizationId: string;
  encounterId: string;
  noteId: string | null;
  noteSource: CodingNoteSource;
  sourceNoteHash: string | null;
  status: CodingSessionStatus;
  failureReason: string | null;
  parsedSections: CodingParsedSections | null;
  extractionStartedAt: string | null;
  extractionCompletedAt: string | null;
  approvedAt: string | null;
  approvedByUserId: string | null;
  writebackStartedAt: string | null;
  writebackCompletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CodingSuggestion {
  id: string;
  organizationId: string;
  encounterId: string;
  codingSessionId: string | null;
  codeSystem: CodeSystem;
  code: string;
  description: string;
  editedCode: string | null;
  editedDescription: string | null;
  rationale: string;
  supportingExcerpts: SupportingExcerpt[];
  documentationGaps: DocumentationGap[];
  confidence: Confidence;
  sourceSection: CodingSectionKey | null;
  destinationField: string | null;
  hccCategory: string | null;
  rafRelevant: boolean;
  status: SuggestionStatus;
  statusNote: string | null;
  createdByAi: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CodingSessionWithSuggestions {
  session: EncounterCodingSession;
  suggestions: CodingSuggestion[];
}

export interface ApproveAllCodingResponse {
  session: EncounterCodingSession;
  approvedCount: number;
  skippedCount: number;
  pushedBillingCount: number;
  pushedOrderCount: number;
  pushFailedCount: number;
}

// ---- Encounter audit timeline ----

export interface EncounterAuditEvent {
  id: string;
  at: string;
  userId: string | null;
  userDisplayName: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: Record<string, unknown> | null;
}

// ---- Refine (HaloNote's unique twist on CarePilot's refine) ----

export type RefinementEvidenceMode = "supported" | "documentation_gap";

export interface RefinementOption {
  code: string;
  description: string;
  evidenceMode: RefinementEvidenceMode;
  supportingExcerpts: SupportingExcerpt[];
  suggestedNoteLanguage?: string;
  rationale: string;
  hccCategory?: string;
  hccUnlocked: boolean;
  confidence: Confidence;
}

export interface RefineSuggestionResponse {
  options: RefinementOption[];
  source: "ai" | "stub";
}

export interface RefineAllItem {
  suggestionId: string;
  originalCode: string;
  options: RefinementOption[];
}

export interface RefineAllResponse {
  items: RefineAllItem[];
  hccUnlockCount: number;
  source: "ai" | "stub";
}

// ---- Problem list (Phase 2) ----

export type ProblemStatus =
  | "active"
  | "stable"
  | "worsening"
  | "improving"
  | "resolved";

export type ProblemEhrSource = "athena" | "epic" | "cerner" | "manual";

export type ProblemSuggestionAction =
  | "add"
  | "update_status"
  | "resolve"
  | "merge_duplicate"
  | "flag_uncertain";

export type ProblemSuggestionStatus =
  | "suggested"
  | "accepted"
  | "rejected"
  | "applied";

export interface PatientProblem {
  id: string;
  organizationId: string;
  patientId: string;
  code: string;
  description: string;
  status: ProblemStatus;
  onsetDate: string | null;
  ehrSource: ProblemEhrSource;
  ehrResourceRef: string | null;
  syncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProblemListSuggestion {
  id: string;
  organizationId: string;
  codingSessionId: string | null;
  patientId: string;
  encounterId: string;
  action: ProblemSuggestionAction;
  targetProblemId: string | null;
  mergeFromProblemId: string | null;
  proposedCode: string | null;
  proposedDescription: string | null;
  proposedStatus: ProblemStatus | null;
  rationale: string;
  supportingExcerpts: SupportingExcerpt[];
  confidence: Confidence;
  status: ProblemSuggestionStatus;
  statusNote: string | null;
  appliedLocally: boolean;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProblemSuggestionsResponse {
  data: ProblemListSuggestion[];
}

export interface ReconcileResponse {
  data: ProblemListSuggestion[];
  problems: PatientProblem[];
  ehrHit: boolean;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type OrderType =
  | "lab"
  | "imaging"
  | "referral"
  | "medication"
  | "procedure"
  | "followup"
  | "instruction"
  | "dme"
  | "therapy"
  | "nursing";

export type OrderPriority = "routine" | "urgent" | "stat";
export type OrderSuggestionStatus =
  | "ai_suggested"
  | "needs_review"
  | "approved"
  | "rejected"
  | "exported";
export type ApprovedOrderStatus =
  | "approved"
  | "export_ready"
  | "exported"
  | "cancelled";

export interface SafetyWarning {
  kind: string;
  message: string;
  severity: "info" | "warn" | "block";
}

// Subset of the order columns surfaced in the panel — every field shared by
// suggestions and approved rows lives here. Type-specific columns (med
// dose etc.) follow on the concrete interfaces.
export interface OrderCommon {
  id: string;
  orderType: OrderType;
  name: string;
  indication: string | null;
  indicationDiagnosisCode: string | null;
  priority: OrderPriority;
  instructions: string | null;
  frequency: string | null;
  duration: string | null;
  medicationName: string | null;
  medicationDose: string | null;
  medicationRoute: string | null;
  medicationFrequency: string | null;
  medicationDuration: string | null;
  medicationQuantity: number | null;
  medicationRefills: number | null;
  isComplete: boolean;
  safetyWarnings: SafetyWarning[];
}

export interface OrderSuggestion extends OrderCommon {
  rationale: string;
  status: OrderSuggestionStatus;
  createdByAi: boolean;
}

export interface ApprovedOrder extends OrderCommon {
  sourceSuggestionId: string | null;
  status: ApprovedOrderStatus;
  approvedAt: string | null;
  exportReadyAt: string | null;
  exportedAt: string | null;
}

export interface OrdersResponse {
  suggestions: OrderSuggestion[];
  approvedOrders: ApprovedOrder[];
}

export interface OrderSuggestResponse {
  data: OrderSuggestion[];
  source: "ai" | "stub";
}

export interface MedicationPatch {
  medicationName?: string | null;
  medicationDose?: string | null;
  medicationRoute?: string | null;
  medicationFrequency?: string | null;
  medicationDuration?: string | null;
  medicationQuantity?: number | null;
  medicationRefills?: number | null;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskCategory =
  | "call_patient"
  | "schedule_followup"
  | "send_referral"
  | "prior_auth"
  | "obtain_records"
  | "repeat_labs"
  | "nursing_instruction"
  | "billing_followup"
  | "patient_instruction"
  | "other";
export type TaskStatus = "open" | "in_progress" | "completed" | "cancelled";
export type TaskPriority = "low" | "normal" | "high";

export interface Task {
  id: string;
  encounterId: string | null;
  category: TaskCategory;
  title: string;
  description: string | null;
  dueAt: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  isClosed: boolean;
  source: "ai" | "manual";
}

export interface TaskListResponse {
  data: Task[];
}

export interface TaskGenerateResponse {
  data: Task[];
  source: "ai" | "stub";
}

// ---------------------------------------------------------------------------
// Vitals
// ---------------------------------------------------------------------------

export type VitalConfidence = "low" | "medium" | "high";

export interface NumericVital {
  value: number;
  source: string;
  confidence: VitalConfidence;
}

export interface BloodPressureVital {
  systolic: number;
  diastolic: number;
  position?: string | null;
  source: string;
  confidence: VitalConfidence;
}

export interface PainVital {
  score: number | null;
  source: string;
  confidence: VitalConfidence;
}

export interface VitalsResponse {
  bp?: BloodPressureVital;
  heartRate?: NumericVital;
  respiratoryRate?: NumericVital;
  temperatureF?: NumericVital;
  spo2Percent?: NumericVital;
  weightLbs?: NumericVital;
  heightIn?: NumericVital;
  bmi?: NumericVital;
  pain?: PainVital;
  other: { label: string; valueText: string; source: string }[];
  source: "ai" | "stub";
}

export interface VitalTrendRow {
  noteId: string;
  encounterId: string | null;
  noteCreatedAt: string;
  noteUpdatedAt: string;
  noteStatus: string;
  // Same shape as VitalsResponse but without `source` (server doesn't
  // persist that). Fields are optional and the trend renderer just
  // reads what it finds.
  extractedVitals: Omit<VitalsResponse, "source"> | null;
}

export interface VitalTrendsResponse {
  data: VitalTrendRow[];
}

// ---------------------------------------------------------------------------
// Patient summary
// ---------------------------------------------------------------------------

export type SummaryLanguage = "en" | "es" | "zh" | "vi" | "ko" | "tl" | "ru";

export interface PatientSummary {
  overview: string;
  diagnoses: { name: string; explanation: string }[];
  medications: { name: string; howToTake: string; why: string }[];
  selfCare: string[];
  followUp?: { when: string; why: string };
  whenToCall: string[];
  source: "ai" | "stub";
  language: SummaryLanguage;
}

// ---------------------------------------------------------------------------
// EHR push outcome (shared by orders + billing send-to-ehr endpoints)
// ---------------------------------------------------------------------------

export interface EhrPushOutcome {
  provider: "athenahealth" | "epic" | "mock";
  ehrDocumentRef: string;
  pushedAt: string;
  mock: boolean;
}
