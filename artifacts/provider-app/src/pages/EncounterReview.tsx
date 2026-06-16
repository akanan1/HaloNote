import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  CircleDashed,
  FileText,
  ListChecks,
  Loader2,
  Pill,
  ReceiptText,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ---------------------------------------------------------------------------
// Wire types (hand-mirrored against the API serializers — replace with
// codegen once OpenAPI catches up).
// ---------------------------------------------------------------------------

type EncounterStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "cancelled";

type VisitType =
  | "new_patient"
  | "established_patient"
  | "follow_up"
  | "annual_physical"
  | "hospital_follow_up"
  | "procedure"
  | "telehealth"
  | "nursing_facility"
  | "custom";

interface Encounter {
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
  createdAt: string;
}

interface Patient {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  mrn: string;
}

type NoteStatus =
  | "draft"
  | "approved"
  | "exported"
  | "entered-in-error"
  | "active";

interface Note {
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

type CodeSystem = "icd10" | "cpt" | "em" | "modifier";
type Confidence = "low" | "medium" | "high";
type SuggestionStatus =
  | "ai_suggested"
  | "needs_review"
  | "provider_approved"
  | "biller_approved"
  | "rejected"
  | "exported";

interface DocumentationGap {
  field: string;
  message: string;
  severity: "info" | "warn" | "block";
}

interface SupportingExcerpt {
  text: string;
  locationHint?: string;
}

interface BillingSuggestion {
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

interface ApprovedBillingCode {
  id: string;
  codeSystem: CodeSystem;
  code: string;
  description: string;
  sourceSuggestionId: string | null;
  approvedAt: string | null;
  billerApprovedAt: string | null;
  exportedAt: string | null;
}

interface BillingResponse {
  suggestions: BillingSuggestion[];
  approvedCodes: ApprovedBillingCode[];
}

interface NoteListResponse {
  data: Note[];
}

// ---- Orders ---------------------------------------------------------------

type OrderType =
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

type OrderPriority = "routine" | "urgent" | "stat";
type OrderSuggestionStatus =
  | "ai_suggested"
  | "needs_review"
  | "approved"
  | "rejected"
  | "exported";
type ApprovedOrderStatus =
  | "approved"
  | "export_ready"
  | "exported"
  | "cancelled";

interface SafetyWarning {
  kind: string;
  message: string;
  severity: "info" | "warn" | "block";
}

// Subset of the order columns surfaced in the panel — every field shared by
// suggestions and approved rows lives here. Type-specific columns (med
// dose etc.) follow on the concrete interfaces.
interface OrderCommon {
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

interface OrderSuggestion extends OrderCommon {
  rationale: string;
  status: OrderSuggestionStatus;
  createdByAi: boolean;
}

interface ApprovedOrder extends OrderCommon {
  sourceSuggestionId: string | null;
  status: ApprovedOrderStatus;
  approvedAt: string | null;
  exportReadyAt: string | null;
  exportedAt: string | null;
}

interface OrdersResponse {
  suggestions: OrderSuggestion[];
  approvedOrders: ApprovedOrder[];
}

interface OrderSuggestResponse {
  data: OrderSuggestion[];
  source: "ai" | "stub";
}

// ---- Tasks ----------------------------------------------------------------

type TaskCategory =
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
type TaskStatus = "open" | "in_progress" | "completed" | "cancelled";
type TaskPriority = "low" | "normal" | "high";

interface Task {
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

interface TaskListResponse {
  data: Task[];
}

interface TaskGenerateResponse {
  data: Task[];
  source: "ai" | "stub";
}

// ---------------------------------------------------------------------------
// API wrappers
// ---------------------------------------------------------------------------

async function fetchEncounter(id: string): Promise<Encounter> {
  return customFetch<Encounter>(`/api/encounters/${id}`);
}

async function fetchPatient(id: string): Promise<Patient> {
  return customFetch<Patient>(`/api/patients/${id}`);
}

async function fetchNoteForEncounter(encId: string): Promise<Note | null> {
  // No GET /encounters/:id/notes endpoint yet — use the existing list
  // filtered by patient and find the one tied to this encounter.
  // Inefficient on a busy patient but correct; replace with a focused
  // endpoint in a polish pass.
  const r = await customFetch<NoteListResponse>(`/api/notes?limit=50`);
  return r.data.find((n) => n.encounterId === encId) ?? null;
}

async function approveNote(noteId: string): Promise<Note> {
  return customFetch<Note>(`/api/notes/${noteId}/approve`, { method: "POST" });
}

interface NoteGap {
  field: string;
  message: string;
  suggestedResolution?: string;
  locationHint?: string;
  severity: "info" | "warn" | "block";
}

interface GapAnalysisResponse {
  gaps: NoteGap[];
  summary: string;
  source: "ai" | "stub";
}

async function analyzeNoteGaps(noteId: string): Promise<GapAnalysisResponse> {
  return customFetch<GapAnalysisResponse>(
    `/api/notes/${noteId}/analyze-gaps`,
    { method: "POST" },
  );
}

interface RefineResponse {
  note: { id: string; body: string; updatedAt: string };
  changeSummary: string;
  source: "ai" | "stub";
}

async function refineNote(noteId: string, instruction: string): Promise<RefineResponse> {
  return customFetch<RefineResponse>(`/api/notes/${noteId}/refine`, {
    method: "POST",
    body: JSON.stringify({ instruction }),
  });
}

type VitalConfidence = "low" | "medium" | "high";

interface NumericVital {
  value: number;
  source: string;
  confidence: VitalConfidence;
}

interface BloodPressureVital {
  systolic: number;
  diastolic: number;
  position?: string | null;
  source: string;
  confidence: VitalConfidence;
}

interface PainVital {
  score: number | null;
  source: string;
  confidence: VitalConfidence;
}

interface VitalsResponse {
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

async function extractVitals(noteId: string): Promise<VitalsResponse> {
  return customFetch<VitalsResponse>(
    `/api/notes/${noteId}/extract-vitals`,
    { method: "POST" },
  );
}

type SummaryLanguage = "en" | "es" | "zh" | "vi" | "ko" | "tl" | "ru";

// Native-script labels so the picker reads correctly to a multilingual
// front-desk staffer or patient peeking over the provider's shoulder.
// English in parens for the provider's clarity.
const LANGUAGE_OPTIONS: { value: SummaryLanguage; label: string }[] = [
  { value: "en", label: "English" },
  { value: "es", label: "Español (Spanish)" },
  { value: "zh", label: "中文 (Chinese)" },
  { value: "vi", label: "Tiếng Việt (Vietnamese)" },
  { value: "ko", label: "한국어 (Korean)" },
  { value: "tl", label: "Tagalog (Filipino)" },
  { value: "ru", label: "Русский (Russian)" },
];

interface PatientSummary {
  overview: string;
  diagnoses: { name: string; explanation: string }[];
  medications: { name: string; howToTake: string; why: string }[];
  selfCare: string[];
  followUp?: { when: string; why: string };
  whenToCall: string[];
  source: "ai" | "stub";
  language: SummaryLanguage;
}

async function generatePatientSummary(
  noteId: string,
  language: SummaryLanguage,
): Promise<PatientSummary> {
  return customFetch<PatientSummary>(
    `/api/notes/${noteId}/generate-summary?lang=${encodeURIComponent(language)}`,
    { method: "POST" },
  );
}

async function fetchBilling(encId: string): Promise<BillingResponse> {
  return customFetch<BillingResponse>(`/api/encounters/${encId}/billing`);
}

interface SuggestResponse {
  data: BillingSuggestion[];
  source: "ai" | "stub";
}

async function suggestBilling(encId: string): Promise<SuggestResponse> {
  return customFetch<SuggestResponse>(
    `/api/encounters/${encId}/billing/suggest`,
    { method: "POST" },
  );
}

async function approveSuggestion(
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

async function rejectSuggestion(
  id: string,
  reason: string,
): Promise<BillingSuggestion> {
  return customFetch<BillingSuggestion>(
    `/api/billing/suggestions/${id}/reject`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}

// ---- Orders ---------------------------------------------------------------

async function fetchOrders(encId: string): Promise<OrdersResponse> {
  return customFetch<OrdersResponse>(`/api/encounters/${encId}/orders`);
}

async function suggestOrders(encId: string): Promise<OrderSuggestResponse> {
  return customFetch<OrderSuggestResponse>(
    `/api/encounters/${encId}/orders/suggest`,
    { method: "POST" },
  );
}

async function approveOrderSuggestion(id: string): Promise<ApprovedOrder> {
  return customFetch<ApprovedOrder>(
    `/api/orders/suggestions/${id}/approve`,
    { method: "POST" },
  );
}

async function rejectOrderSuggestion(
  id: string,
  reason: string,
): Promise<OrderSuggestion> {
  return customFetch<OrderSuggestion>(
    `/api/orders/suggestions/${id}/reject`,
    { method: "POST", body: JSON.stringify({ reason }) },
  );
}

interface MedicationPatch {
  medicationName?: string | null;
  medicationDose?: string | null;
  medicationRoute?: string | null;
  medicationFrequency?: string | null;
  medicationDuration?: string | null;
  medicationQuantity?: number | null;
  medicationRefills?: number | null;
}

async function patchOrder(
  id: string,
  body: MedicationPatch,
): Promise<ApprovedOrder> {
  return customFetch<ApprovedOrder>(`/api/orders/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

async function markOrderExportReady(id: string): Promise<ApprovedOrder> {
  return customFetch<ApprovedOrder>(`/api/orders/${id}/mark-export-ready`, {
    method: "POST",
  });
}

// ---- Tasks ----------------------------------------------------------------

async function fetchTasksForEncounter(encId: string): Promise<TaskListResponse> {
  // /api/tasks doesn't have an encounterId filter on the route (only
  // patientId / assignedUserId). Pull the assignee's list and filter
  // client-side — small N per encounter; revisit if a busy clinic
  // hits the 500-row default cap.
  const r = await customFetch<TaskListResponse>(
    `/api/tasks?assignedUserId=me&includeClosed=true`,
  );
  return { data: r.data.filter((t) => t.encounterId === encId) };
}

async function generateTasksForEncounter(
  encId: string,
): Promise<TaskGenerateResponse> {
  return customFetch<TaskGenerateResponse>(
    `/api/encounters/${encId}/tasks/generate`,
    { method: "POST" },
  );
}

async function completeTaskApi(id: string): Promise<Task> {
  return customFetch<Task>(`/api/tasks/${id}/complete`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const VISIT_LABEL: Record<VisitType, string> = {
  new_patient: "New patient",
  established_patient: "Established patient",
  follow_up: "Follow-up",
  annual_physical: "Annual physical",
  hospital_follow_up: "Hospital follow-up",
  procedure: "Procedure",
  telehealth: "Telehealth",
  nursing_facility: "Nursing facility",
  custom: "Custom",
};

const STATUS_TONE: Record<EncounterStatus, string> = {
  scheduled: "ring-sky-200 bg-sky-50 text-sky-900",
  in_progress: "ring-violet-200 bg-violet-50 text-violet-900",
  completed: "ring-emerald-200 bg-emerald-50 text-emerald-900",
  cancelled: "ring-(--color-border) bg-(--color-muted) text-(--color-muted-foreground)",
};

const NOTE_STATUS_LABEL: Record<NoteStatus, string> = {
  draft: "Draft",
  approved: "Approved",
  exported: "Exported to EHR",
  "entered-in-error": "Withdrawn",
  active: "Active",
};

const NOTE_STATUS_TONE: Record<NoteStatus, string> = {
  draft: "ring-amber-200 bg-amber-50 text-amber-900",
  approved: "ring-emerald-200 bg-emerald-50 text-emerald-900",
  exported: "ring-blue-200 bg-blue-50 text-blue-900",
  "entered-in-error": "ring-(--color-border) bg-(--color-muted) text-(--color-muted-foreground)",
  active: "ring-(--color-border) bg-(--color-muted) text-(--color-foreground)",
};

const CODE_SYSTEM_LABEL: Record<CodeSystem, string> = {
  em: "E&M level",
  cpt: "CPT",
  icd10: "ICD-10",
  modifier: "Modifier",
};

// Ordered: providers scan from "what level" → "what diagnoses" → procedures → modifiers.
const CODE_SYSTEM_ORDER: CodeSystem[] = ["em", "icd10", "cpt", "modifier"];

const CONFIDENCE_TONE: Record<Confidence, string> = {
  low: "text-red-700",
  medium: "text-amber-700",
  high: "text-emerald-700",
};

const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  lab: "Lab",
  imaging: "Imaging",
  referral: "Referral",
  medication: "Medication",
  procedure: "Procedure",
  followup: "Follow-up",
  instruction: "Patient instruction",
  dme: "DME",
  therapy: "Therapy",
  nursing: "Nursing",
};

const ORDER_PRIORITY_TONE: Record<OrderPriority, string> = {
  routine: "ring-(--color-border) bg-(--color-card) text-(--color-muted-foreground)",
  urgent: "ring-amber-200 bg-amber-50 text-amber-900",
  stat: "ring-red-200 bg-red-50 text-red-900",
};

const APPROVED_ORDER_STATUS_LABEL: Record<ApprovedOrderStatus, string> = {
  approved: "Approved",
  export_ready: "Export ready",
  exported: "Exported",
  cancelled: "Cancelled",
};

const TASK_CATEGORY_LABEL: Record<TaskCategory, string> = {
  call_patient: "Call patient",
  schedule_followup: "Schedule follow-up",
  send_referral: "Send referral",
  prior_auth: "Prior authorization",
  obtain_records: "Obtain records",
  repeat_labs: "Repeat labs",
  nursing_instruction: "Nursing instruction",
  billing_followup: "Billing follow-up",
  patient_instruction: "Patient instruction",
  other: "Other",
};

// Per the spec's non-negotiable: only `medication` orders carry the
// strict completeness rule. Surfacing it at the type-list level so
// the UI can render the "Complete details" call-to-action consistently.
function requiresMedicationDetails(t: OrderType): boolean {
  return t === "medication";
}

function formatLocalDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function patientDisplay(p: Patient): string {
  return `${p.firstName} ${p.lastName} · MRN ${p.mrn}`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface Props {
  patientId: string;
  encounterId: string;
}

export function EncounterReviewPage({ patientId, encounterId }: Props) {
  const qc = useQueryClient();

  const encounterQuery = useQuery({
    queryKey: ["encounter", encounterId],
    queryFn: () => fetchEncounter(encounterId),
  });
  const patientQuery = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => fetchPatient(patientId),
  });
  const noteQuery = useQuery({
    queryKey: ["note-for-encounter", encounterId],
    queryFn: () => fetchNoteForEncounter(encounterId),
  });
  const billingQuery = useQuery({
    queryKey: ["billing", encounterId],
    queryFn: () => fetchBilling(encounterId),
  });
  const ordersQuery = useQuery({
    queryKey: ["orders", encounterId],
    queryFn: () => fetchOrders(encounterId),
  });
  const tasksQuery = useQuery({
    queryKey: ["tasks-for-encounter", encounterId],
    queryFn: () => fetchTasksForEncounter(encounterId),
  });

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: ["note-for-encounter", encounterId] });
    void qc.invalidateQueries({ queryKey: ["billing", encounterId] });
  };

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/patients/${patientId}`}
          className="inline-flex items-center gap-1 text-sm text-(--color-muted-foreground) hover:text-(--color-foreground)"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Back to patient
        </Link>
      </div>

      <PatientEncounterHeader
        patient={patientQuery.data ?? null}
        encounter={encounterQuery.data ?? null}
        loading={patientQuery.isPending || encounterQuery.isPending}
      />

      <NotePanel
        note={noteQuery.data ?? null}
        loading={noteQuery.isPending}
        onChanged={() => invalidateAll()}
        patientId={patientId}
        encounterId={encounterId}
      />

      <VitalsPanel note={noteQuery.data ?? null} />

      <PatientSummaryPanel note={noteQuery.data ?? null} />

      <BillingPanel
        encounterId={encounterId}
        billing={billingQuery.data ?? null}
        loading={billingQuery.isPending}
        onChanged={() =>
          void qc.invalidateQueries({ queryKey: ["billing", encounterId] })
        }
      />

      <OrdersPanel
        encounterId={encounterId}
        orders={ordersQuery.data ?? null}
        loading={ordersQuery.isPending}
        onChanged={() =>
          void qc.invalidateQueries({ queryKey: ["orders", encounterId] })
        }
      />

      <TasksPanel
        encounterId={encounterId}
        tasks={tasksQuery.data?.data ?? null}
        loading={tasksQuery.isPending}
        onChanged={() =>
          void qc.invalidateQueries({
            queryKey: ["tasks-for-encounter", encounterId],
          })
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function PatientEncounterHeader({
  patient,
  encounter,
  loading,
}: {
  patient: Patient | null;
  encounter: Encounter | null;
  loading: boolean;
}) {
  if (loading) {
    return (
      <Card className="p-5">
        <p className="text-sm text-(--color-muted-foreground)">Loading…</p>
      </Card>
    );
  }
  if (!encounter || !patient) {
    return (
      <Card className="p-5">
        <p className="text-sm text-(--color-destructive)">
          Encounter or patient not found.
        </p>
      </Card>
    );
  }
  const visitLabel =
    encounter.visitType === "custom" && encounter.customLabel
      ? encounter.customLabel
      : VISIT_LABEL[encounter.visitType];
  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            {patientDisplay(patient)}
          </h1>
          <p className="text-sm text-(--color-muted-foreground)">
            DOB {patient.dateOfBirth}
          </p>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_TONE[encounter.status]}`}
        >
          {encounter.status.replace("_", " ")}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
        <Stat label="Visit type" value={visitLabel} />
        <Stat
          label="Scheduled"
          value={formatLocalDateTime(encounter.scheduledAt)}
        />
        <Stat
          label="Started"
          value={formatLocalDateTime(encounter.startedAt)}
        />
        <Stat
          label="Completed"
          value={formatLocalDateTime(encounter.completedAt)}
        />
      </dl>
      {encounter.isTelehealth || encounter.location ? (
        <p className="text-xs text-(--color-muted-foreground)">
          {encounter.isTelehealth ? "Telehealth · " : ""}
          {encounter.location ?? ""}
        </p>
      ) : null}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
        {label}
      </dt>
      <dd className="font-medium text-(--color-foreground)">{value}</dd>
    </div>
  );
}

function NotePanel({
  note,
  loading,
  onChanged,
  patientId,
  encounterId,
}: {
  note: Note | null;
  loading: boolean;
  onChanged: () => void;
  patientId: string;
  encounterId: string;
}) {
  const [busy, setBusy] = useState(false);
  // Gap analysis is request-driven — we don't persist the result, so
  // it lives in component state and clears on remount. analysis === null
  // means "never run"; an empty gaps array means "run, no gaps."
  const [analysis, setAnalysis] = useState<GapAnalysisResponse | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  // Conversational refinement state. refineOpen toggles the inline input;
  // refining gates double-submits.
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineInstruction, setRefineInstruction] = useState("");
  const [refining, setRefining] = useState(false);

  const approve = async () => {
    if (!note) return;
    setBusy(true);
    try {
      await approveNote(note.id);
      toast.success("Note approved");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setBusy(false);
    }
  };

  const runRefine = async () => {
    if (!note || !refineInstruction.trim()) return;
    setRefining(true);
    try {
      const r = await refineNote(note.id, refineInstruction.trim());
      toast.success(r.changeSummary, { duration: 6000 });
      setRefineInstruction("");
      setRefineOpen(false);
      // The note query re-fetches so the textarea-equivalent <pre>
      // surface shows the new body. Clear any stale gap analysis since
      // the body changed.
      setAnalysis(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Refine failed");
    } finally {
      setRefining(false);
    }
  };

  const runAnalysis = async () => {
    if (!note) return;
    setAnalyzing(true);
    try {
      const r = await analyzeNoteGaps(note.id);
      setAnalysis(r);
      const blockerCount = r.gaps.filter((g) => g.severity === "block").length;
      if (blockerCount > 0) {
        toast.warning(
          `${blockerCount} blocker${blockerCount === 1 ? "" : "s"} found`,
        );
      } else if (r.gaps.length === 0) {
        toast.success("No gaps detected");
      } else {
        toast.message(
          `${r.gaps.length} item${r.gaps.length === 1 ? "" : "s"} to review`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Gap analysis failed");
    } finally {
      setAnalyzing(false);
    }
  };

  const blockingGaps =
    analysis?.gaps.filter((g) => g.severity === "block") ?? [];
  const canApprove = note?.status === "draft" && blockingGaps.length === 0;

  // Where the "Record / write note" button goes — the NewNote page reads
  // ?encounterId from the URL and threads it through useNoteAutosave so
  // the resulting draft is linked back to this encounter. autostart=1
  // tells RecordingPanel to fire getUserMedia immediately (the click on
  // this link is the user gesture the browser wants).
  const recordHref = `/patients/${patientId}/notes/new?encounterId=${encodeURIComponent(encounterId)}&autostart=1`;

  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-(--color-muted-foreground)" aria-hidden="true" />
          <h2 className="text-lg font-medium">Note</h2>
          {note ? (
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${NOTE_STATUS_TONE[note.status]}`}
            >
              {NOTE_STATUS_LABEL[note.status]}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {note && note.status === "draft" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRefineOpen((v) => !v)}
              disabled={refining}
              title="Ask the AI to refine the note ('make assessment shorter', 'soften the tone', etc.)"
            >
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              Refine with AI
            </Button>
          ) : null}
          {note && note.status === "draft" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void runAnalysis()}
              disabled={analyzing}
              title="Run an AI completeness check on the note"
            >
              {analyzing ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="h-4 w-4" aria-hidden="true" />
              )}
              {analysis ? "Re-analyze" : "Analyze gaps"}
            </Button>
          ) : null}
          {note && note.status === "draft" ? (
            <Button
              size="sm"
              onClick={() => void approve()}
              disabled={busy || !canApprove}
              title={
                !canApprove
                  ? "Resolve the block-severity gaps before signing"
                  : undefined
              }
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              )}
              Approve & sign
            </Button>
          ) : null}
          {!loading && !note ? (
            <Link href={recordHref}>
              <Button size="sm">
                <FileText className="h-4 w-4" aria-hidden="true" />
                Start note
              </Button>
            </Link>
          ) : null}
        </div>
      </div>
      {loading ? (
        <p className="text-sm text-(--color-muted-foreground)">Loading note…</p>
      ) : !note ? (
        <p className="text-sm text-(--color-muted-foreground)">
          No note linked to this encounter yet. Start one to record audio and
          generate a SOAP draft.
        </p>
      ) : (
        <>
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border border-(--color-border) bg-(--color-muted)/30 p-3 text-sm font-sans">
            {note.body}
          </pre>
          {note.approvedAt ? (
            <p className="text-xs text-(--color-muted-foreground)">
              Signed {formatLocalDateTime(note.approvedAt)} ·{" "}
              <span className="font-mono">
                {note.signedNoteHash?.slice(0, 12)}…
              </span>
            </p>
          ) : null}
        </>
      )}
      {refineOpen && note && note.status === "draft" ? (
        <div className="space-y-2 rounded-md border border-(--color-border) bg-(--color-muted)/30 p-3">
          <label
            htmlFor="refine-input"
            className="block text-xs font-semibold uppercase tracking-wide text-(--color-muted-foreground)"
          >
            Ask the AI to refine the note
          </label>
          <textarea
            id="refine-input"
            value={refineInstruction}
            onChange={(e) => setRefineInstruction(e.target.value)}
            placeholder='e.g. "Shorten the assessment to 2 sentences" or "Add a normal 10-point ROS"'
            rows={2}
            disabled={refining}
            className="block w-full rounded-md border border-(--color-border) bg-(--color-card) p-2 text-sm focus:outline-none focus:ring-2 focus:ring-(--color-primary)"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <p className="text-(--color-muted-foreground)">
              The AI will rewrite the body and persist the change. It won't
              add clinical content that isn't in the original.
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRefineOpen(false);
                  setRefineInstruction("");
                }}
                disabled={refining}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void runRefine()}
                disabled={refining || !refineInstruction.trim()}
              >
                {refining ? (
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                )}
                Apply refinement
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {analysis ? (
        <GapAnalysisDisplay analysis={analysis} />
      ) : null}
    </Card>
  );
}

// Inline gap-analysis renderer. Sorted so block-severity gaps land at the
// top — the provider's first scan should hit the things that block signing.
function GapAnalysisDisplay({ analysis }: { analysis: GapAnalysisResponse }) {
  const sorted = [...analysis.gaps].sort((a, b) => {
    const weight = { block: 0, warn: 1, info: 2 };
    return weight[a.severity] - weight[b.severity];
  });
  return (
    <div className="space-y-2 border-t border-(--color-border) pt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground)">
          Gap analysis
        </h3>
        <span className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
          {analysis.source === "ai" ? "AI" : "stub"}
        </span>
      </div>
      {analysis.gaps.length === 0 ? (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-inset ring-emerald-200">
          {analysis.summary}
        </p>
      ) : (
        <ul className="space-y-2">
          {sorted.map((g, i) => (
            <GapRow key={`${g.field}-${i}`} gap={g} />
          ))}
        </ul>
      )}
      {analysis.gaps.length > 0 && analysis.summary ? (
        <p className="text-xs italic text-(--color-muted-foreground)">
          {analysis.summary}
        </p>
      ) : null}
    </div>
  );
}

function GapRow({ gap }: { gap: NoteGap }) {
  const tone =
    gap.severity === "block"
      ? "ring-red-200 bg-red-50 text-red-900"
      : gap.severity === "warn"
        ? "ring-amber-200 bg-amber-50 text-amber-900"
        : "ring-(--color-border) bg-(--color-card) text-(--color-muted-foreground)";
  return (
    <li>
      <div className={`rounded-md px-3 py-2 ring-1 ring-inset ${tone}`}>
        <div className="flex items-start gap-2">
          {gap.severity === "block" ? (
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
          ) : null}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide">
                {gap.severity}
              </span>
              {gap.locationHint ? (
                <span className="text-xs">{gap.locationHint}</span>
              ) : null}
            </div>
            <p className="text-sm">{gap.message}</p>
            {gap.suggestedResolution ? (
              <p className="text-xs italic">
                Suggested: &ldquo;{gap.suggestedResolution}&rdquo;
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}

function BillingPanel({
  encounterId,
  billing,
  loading,
  onChanged,
}: {
  encounterId: string;
  billing: BillingResponse | null;
  loading: boolean;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const suggestMut = useMutation({
    mutationFn: () => suggestBilling(encounterId),
    onSuccess: (res) => {
      toast.success(
        res.source === "ai"
          ? `Generated ${res.data.length} suggestions`
          : `Generated ${res.data.length} suggestions (stub)`,
      );
      onChanged();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Suggest failed"),
  });

  async function handleApprove(s: BillingSuggestion) {
    const blockers = s.documentationGaps.filter((g) => g.severity === "block");
    let ack = false;
    if (blockers.length > 0) {
      const confirmed = window.confirm(
        `This suggestion has ${blockers.length} blocking documentation gap(s):\n\n` +
          blockers.map((g) => `• ${g.message}`).join("\n") +
          "\n\nApprove anyway? The override is logged for audit.",
      );
      if (!confirmed) return;
      ack = true;
    }
    setBusyId(s.id);
    try {
      await approveSuggestion(s.id, ack);
      toast.success(`Approved ${s.code}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(s: BillingSuggestion) {
    const reason = window.prompt(
      `Reject ${s.code} — reason for audit:`,
      "",
    );
    if (!reason || !reason.trim()) return;
    setBusyId(s.id);
    try {
      await rejectSuggestion(s.id, reason.trim());
      toast.success(`Rejected ${s.code}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reject failed");
    } finally {
      setBusyId(null);
    }
  }

  // Group suggestions by code system for the rendered sections; preserve
  // the codeSystem ordering above so providers see E&M first.
  const groups = useMemo(() => {
    const map = new Map<CodeSystem, BillingSuggestion[]>();
    for (const sys of CODE_SYSTEM_ORDER) map.set(sys, []);
    for (const s of billing?.suggestions ?? []) {
      const arr = map.get(s.codeSystem);
      if (arr) arr.push(s);
    }
    return map;
  }, [billing?.suggestions]);

  const hasAny = (billing?.suggestions.length ?? 0) > 0;
  const approved = billing?.approvedCodes ?? [];

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ReceiptText className="h-5 w-5 text-(--color-muted-foreground)" aria-hidden="true" />
          <h2 className="text-lg font-medium">Billing</h2>
          {hasAny ? (
            <span className="text-sm text-(--color-muted-foreground)">
              {billing?.suggestions.length} suggested · {approved.length} approved
            </span>
          ) : null}
        </div>
        <Button
          size="sm"
          variant={hasAny ? "outline" : "default"}
          onClick={() => suggestMut.mutate()}
          disabled={suggestMut.isPending}
        >
          {suggestMut.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          )}
          {hasAny ? "Regenerate suggestions" : "Generate suggestions"}
        </Button>
      </div>
      {loading ? (
        <p className="text-sm text-(--color-muted-foreground)">Loading billing…</p>
      ) : !hasAny ? (
        <p className="text-sm text-(--color-muted-foreground)">
          No suggestions yet. Generate to see AI-proposed codes.
        </p>
      ) : (
        <div className="space-y-5">
          {CODE_SYSTEM_ORDER.map((sys) => {
            const rows = groups.get(sys) ?? [];
            if (rows.length === 0) return null;
            return (
              <section key={sys} className="space-y-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground)">
                  {CODE_SYSTEM_LABEL[sys]}
                </h3>
                <ul className="space-y-2">
                  {rows.map((s) => (
                    <SuggestionRow
                      key={s.id}
                      sug={s}
                      busy={busyId === s.id}
                      onApprove={() => void handleApprove(s)}
                      onReject={() => void handleReject(s)}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {approved.length > 0 ? (
        <section className="space-y-2 border-t border-(--color-border) pt-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground)">
            Approved codes
          </h3>
          <ul className="space-y-1.5">
            {approved.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-3 rounded-md bg-(--color-muted)/50 px-3 py-2 text-sm"
              >
                <CheckCircle2
                  className="h-4 w-4 text-emerald-600"
                  aria-hidden="true"
                />
                <span className="font-mono font-semibold">{a.code}</span>
                <span className="text-(--color-muted-foreground)">
                  {a.description}
                </span>
                <span className="ml-auto text-xs text-(--color-muted-foreground)">
                  {a.exportedAt
                    ? "Exported"
                    : a.billerApprovedAt
                      ? "Biller approved"
                      : "Provider approved"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Card>
  );
}

function SuggestionRow({
  sug,
  busy,
  onApprove,
  onReject,
}: {
  sug: BillingSuggestion;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const blockers = sug.documentationGaps.filter((g) => g.severity === "block");
  const warns = sug.documentationGaps.filter((g) => g.severity === "warn");
  const isClosed =
    sug.status === "rejected" ||
    sug.status === "provider_approved" ||
    sug.status === "biller_approved" ||
    sug.status === "exported";

  return (
    <li>
      <div
        className={`rounded-md border border-(--color-border) p-3 ${
          isClosed ? "opacity-60" : ""
        }`}
      >
        <div className="flex flex-wrap items-start gap-3">
          <div className="mt-1">
            {sug.status === "rejected" ? (
              <X className="h-5 w-5 text-(--color-muted-foreground)" aria-hidden="true" />
            ) : isClosed ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden="true" />
            ) : (
              <CircleDashed className="h-5 w-5 text-(--color-muted-foreground)" aria-hidden="true" />
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-base font-semibold">
                {sug.code}
              </span>
              <span className="text-sm text-(--color-foreground)">
                {sug.description}
              </span>
              <span
                className={`text-xs font-medium uppercase tracking-wide ${CONFIDENCE_TONE[sug.confidence]}`}
              >
                {sug.confidence}
              </span>
            </div>
            <p className="text-xs text-(--color-muted-foreground)">
              {sug.rationale}
            </p>
            {blockers.length > 0 ? (
              <div className="flex flex-wrap items-start gap-1 text-xs text-red-800">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>
                  Blocks approval: {blockers.map((b) => b.message).join(" · ")}
                </span>
              </div>
            ) : null}
            {warns.length > 0 ? (
              <p className="text-xs text-amber-800">
                {warns.map((w) => w.message).join(" · ")}
              </p>
            ) : null}
          </div>
          {!isClosed ? (
            <div className="flex shrink-0 items-center gap-2">
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin text-(--color-muted-foreground)" aria-hidden="true" />
              ) : null}
              <Button size="sm" onClick={onApprove} disabled={busy}>
                Approve
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onReject}
                disabled={busy}
              >
                Reject
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Orders panel
// ---------------------------------------------------------------------------

function OrdersPanel({
  encounterId,
  orders,
  loading,
  onChanged,
}: {
  encounterId: string;
  orders: OrdersResponse | null;
  loading: boolean;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const suggestMut = useMutation({
    mutationFn: () => suggestOrders(encounterId),
    onSuccess: (res) => {
      toast.success(
        res.source === "ai"
          ? `Generated ${res.data.length} order suggestions`
          : `Generated ${res.data.length} order suggestions (stub)`,
      );
      onChanged();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Suggest failed"),
  });

  async function handleApprove(s: OrderSuggestion) {
    setBusyId(s.id);
    try {
      await approveOrderSuggestion(s.id);
      toast.success(`Approved ${s.name}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(s: OrderSuggestion) {
    const reason = window.prompt(`Reject "${s.name}" — reason for audit:`, "");
    if (!reason || !reason.trim()) return;
    setBusyId(s.id);
    try {
      await rejectOrderSuggestion(s.id, reason.trim());
      toast.success("Order rejected");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reject failed");
    } finally {
      setBusyId(null);
    }
  }

  const hasSugg = (orders?.suggestions.length ?? 0) > 0;
  const approved = orders?.approvedOrders ?? [];

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Pill className="h-5 w-5 text-(--color-muted-foreground)" aria-hidden="true" />
          <h2 className="text-lg font-medium">Orders</h2>
          {orders ? (
            <span className="text-sm text-(--color-muted-foreground)">
              {orders.suggestions.length} suggested · {approved.length} approved
            </span>
          ) : null}
        </div>
        <Button
          size="sm"
          variant={hasSugg ? "outline" : "default"}
          onClick={() => suggestMut.mutate()}
          disabled={suggestMut.isPending}
        >
          {suggestMut.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          )}
          {hasSugg ? "Regenerate suggestions" : "Generate suggestions"}
        </Button>
      </div>
      {loading ? (
        <p className="text-sm text-(--color-muted-foreground)">Loading orders…</p>
      ) : !hasSugg && approved.length === 0 ? (
        <p className="text-sm text-(--color-muted-foreground)">
          No orders yet. Generate to see AI-proposed orders or add a manual order
          via the API.
        </p>
      ) : null}
      {hasSugg ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground)">
            Suggestions
          </h3>
          <ul className="space-y-2">
            {orders!.suggestions.map((s) => (
              <OrderSuggestionRow
                key={s.id}
                ord={s}
                busy={busyId === s.id}
                onApprove={() => void handleApprove(s)}
                onReject={() => void handleReject(s)}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {approved.length > 0 ? (
        <section className="space-y-2 border-t border-(--color-border) pt-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground)">
            Approved orders
          </h3>
          <ul className="space-y-2">
            {approved.map((o) => (
              <ApprovedOrderRow
                key={o.id}
                ord={o}
                busy={busyId === o.id}
                onChanged={onChanged}
                setBusyId={setBusyId}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </Card>
  );
}

function OrderTypePill({ t }: { t: OrderType }) {
  return (
    <span className="inline-flex rounded-full bg-(--color-muted) px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-(--color-border)">
      {ORDER_TYPE_LABEL[t]}
    </span>
  );
}

function PriorityPill({ p }: { p: OrderPriority }) {
  if (p === "routine") return null;
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium uppercase ring-1 ring-inset ${ORDER_PRIORITY_TONE[p]}`}
    >
      {p}
    </span>
  );
}

function MedicationSummary({ ord }: { ord: OrderCommon }) {
  if (!requiresMedicationDetails(ord.orderType)) return null;
  // Compact one-liner for non-mutation contexts (suggestion + approved).
  // Missing fields render as em-dash so the gap is visually obvious.
  const em = (v: string | number | null) =>
    v == null || v === "" ? "—" : String(v);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-(--color-muted)/40 px-3 py-2 text-xs sm:grid-cols-4">
      <MedField label="Dose" value={em(ord.medicationDose)} />
      <MedField label="Route" value={em(ord.medicationRoute)} />
      <MedField label="Frequency" value={em(ord.medicationFrequency)} />
      <MedField label="Duration" value={em(ord.medicationDuration)} />
      <MedField label="Quantity" value={em(ord.medicationQuantity)} />
      <MedField label="Refills" value={em(ord.medicationRefills)} />
    </dl>
  );
}

function MedField({ label, value }: { label: string; value: string }) {
  const missing = value === "—";
  return (
    <div>
      <dt className="uppercase tracking-wide text-(--color-muted-foreground)">
        {label}
      </dt>
      <dd
        className={
          missing
            ? "font-medium text-(--color-destructive)"
            : "font-medium text-(--color-foreground)"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function SafetyList({ warnings }: { warnings: SafetyWarning[] }) {
  if (warnings.length === 0) return null;
  const blockers = warnings.filter((w) => w.severity === "block");
  const warns = warnings.filter((w) => w.severity === "warn");
  const infos = warnings.filter((w) => w.severity === "info");
  return (
    <div className="space-y-1 text-xs">
      {blockers.length > 0 ? (
        <div className="flex items-start gap-1 text-red-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{blockers.map((b) => b.message).join(" · ")}</span>
        </div>
      ) : null}
      {warns.length > 0 ? (
        <p className="text-amber-800">{warns.map((w) => w.message).join(" · ")}</p>
      ) : null}
      {infos.length > 0 ? (
        <p className="text-(--color-muted-foreground)">
          {infos.map((w) => w.message).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

function OrderSuggestionRow({
  ord,
  busy,
  onApprove,
  onReject,
}: {
  ord: OrderSuggestion;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const isClosed =
    ord.status === "approved" ||
    ord.status === "rejected" ||
    ord.status === "exported";
  return (
    <li>
      <div
        className={`rounded-md border border-(--color-border) p-3 ${
          isClosed ? "opacity-60" : ""
        }`}
      >
        <div className="flex flex-wrap items-start gap-3">
          <div className="mt-1">
            {ord.status === "rejected" ? (
              <X className="h-5 w-5 text-(--color-muted-foreground)" aria-hidden="true" />
            ) : isClosed ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-600" aria-hidden="true" />
            ) : (
              <CircleDashed className="h-5 w-5 text-(--color-muted-foreground)" aria-hidden="true" />
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <OrderTypePill t={ord.orderType} />
              <PriorityPill p={ord.priority} />
              <span className="text-base font-medium">{ord.name}</span>
            </div>
            {ord.indication ? (
              <p className="text-xs text-(--color-muted-foreground)">
                Indication: {ord.indication}
                {ord.indicationDiagnosisCode
                  ? ` · ${ord.indicationDiagnosisCode}`
                  : ""}
              </p>
            ) : null}
            <MedicationSummary ord={ord} />
            <p className="text-xs text-(--color-muted-foreground)">
              {ord.rationale}
            </p>
            <SafetyList warnings={ord.safetyWarnings} />
          </div>
          {!isClosed ? (
            <div className="flex shrink-0 items-center gap-2">
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin text-(--color-muted-foreground)" aria-hidden="true" />
              ) : null}
              <Button size="sm" onClick={onApprove} disabled={busy}>
                Approve
              </Button>
              <Button size="sm" variant="ghost" onClick={onReject} disabled={busy}>
                Reject
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function ApprovedOrderRow({
  ord,
  busy,
  onChanged,
  setBusyId,
}: {
  ord: ApprovedOrder;
  busy: boolean;
  onChanged: () => void;
  setBusyId: (id: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const showCompleteCta =
    !ord.isComplete && requiresMedicationDetails(ord.orderType) && ord.status === "approved";

  async function handleExportReady() {
    setBusyId(ord.id);
    try {
      await markOrderExportReady(ord.id);
      toast.success("Marked export ready");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't mark ready");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <li>
      <div className="space-y-2 rounded-md border border-(--color-border) bg-(--color-card) p-3">
        <div className="flex flex-wrap items-start gap-3">
          <CheckCircle2
            className="mt-1 h-5 w-5 text-emerald-600"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <OrderTypePill t={ord.orderType} />
              <PriorityPill p={ord.priority} />
              <span className="text-base font-medium">{ord.name}</span>
              <span className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
                {APPROVED_ORDER_STATUS_LABEL[ord.status]}
              </span>
            </div>
            <MedicationSummary ord={ord} />
            <SafetyList warnings={ord.safetyWarnings} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin text-(--color-muted-foreground)" aria-hidden="true" />
            ) : null}
            {showCompleteCta ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditing((v) => !v)}
                disabled={busy}
              >
                {editing ? "Close" : "Complete details"}
              </Button>
            ) : null}
            {ord.status === "approved" ? (
              <Button
                size="sm"
                onClick={() => void handleExportReady()}
                disabled={busy || !ord.isComplete}
                title={
                  !ord.isComplete
                    ? "Resolve the blocking safety warnings before marking export-ready"
                    : undefined
                }
              >
                <Send className="h-4 w-4" aria-hidden="true" />
                Mark export-ready
              </Button>
            ) : null}
          </div>
        </div>
        {editing && requiresMedicationDetails(ord.orderType) ? (
          <CompleteMedicationForm
            ord={ord}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              onChanged();
            }}
          />
        ) : null}
      </div>
    </li>
  );
}

// Inline form to fill in the structured medication fields for an order
// whose AI suggester (or manual create) couldn't supply them. Only the
// fields the spec flags as required for export-ready show as required;
// quantity / refills are optional but recommended.
function CompleteMedicationForm({
  ord,
  onCancel,
  onSaved,
}: {
  ord: ApprovedOrder;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(ord.medicationName ?? ord.name);
  const [dose, setDose] = useState(ord.medicationDose ?? "");
  const [route, setRoute] = useState(ord.medicationRoute ?? "");
  const [frequency, setFrequency] = useState(ord.medicationFrequency ?? "");
  const [duration, setDuration] = useState(ord.medicationDuration ?? "");
  const [quantity, setQuantity] = useState<string>(
    ord.medicationQuantity != null ? String(ord.medicationQuantity) : "",
  );
  const [refills, setRefills] = useState<string>(
    ord.medicationRefills != null ? String(ord.medicationRefills) : "",
  );

  const save = useMutation({
    mutationFn: (patch: MedicationPatch) => patchOrder(ord.id, patch),
    onSuccess: () => {
      toast.success("Medication details saved");
      onSaved();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Couldn't save"),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const patch: MedicationPatch = {
      medicationName: name.trim() || null,
      medicationDose: dose.trim() || null,
      medicationRoute: route.trim() || null,
      medicationFrequency: frequency.trim() || null,
      medicationDuration: duration.trim() || null,
      medicationQuantity: quantity.trim() ? Number(quantity) : null,
      medicationRefills: refills.trim() ? Number(refills) : null,
    };
    save.mutate(patch);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-md border border-(--color-border) bg-(--color-muted)/30 p-3"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
        <Field label="Medication" value={name} onChange={setName} required />
        <Field label="Dose" value={dose} onChange={setDose} required placeholder="500 mg" />
        <Field label="Route" value={route} onChange={setRoute} required placeholder="PO" />
        <Field
          label="Frequency"
          value={frequency}
          onChange={setFrequency}
          required
          placeholder="BID"
        />
        <Field
          label="Duration"
          value={duration}
          onChange={setDuration}
          required
          placeholder="30 days"
        />
        <div />
        <Field
          label="Quantity"
          value={quantity}
          onChange={setQuantity}
          type="number"
          placeholder="60"
        />
        <Field
          label="Refills"
          value={refills}
          onChange={setRefills}
          type="number"
          placeholder="3"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          Save details
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
  type?: string;
}) {
  const id = `field-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span className="ml-0.5 text-(--color-destructive)">*</span>
        ) : null}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tasks panel
// ---------------------------------------------------------------------------

function TasksPanel({
  encounterId,
  tasks,
  loading,
  onChanged,
}: {
  encounterId: string;
  tasks: Task[] | null;
  loading: boolean;
  onChanged: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const generateMut = useMutation({
    mutationFn: () => generateTasksForEncounter(encounterId),
    onSuccess: (res) => {
      toast.success(
        res.source === "ai"
          ? `Generated ${res.data.length} tasks`
          : `Generated ${res.data.length} tasks (stub)`,
      );
      onChanged();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Generate failed"),
  });

  async function handleComplete(t: Task) {
    setBusyId(t.id);
    try {
      await completeTaskApi(t.id);
      toast.success("Task completed");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't complete");
    } finally {
      setBusyId(null);
    }
  }

  const list = tasks ?? [];
  const open = list.filter((t) => !t.isClosed);
  const closed = list.filter((t) => t.isClosed);

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ListChecks
            className="h-5 w-5 text-(--color-muted-foreground)"
            aria-hidden="true"
          />
          <h2 className="text-lg font-medium">Follow-up tasks</h2>
          {tasks ? (
            <span className="text-sm text-(--color-muted-foreground)">
              {open.length} open
              {closed.length > 0 ? ` · ${closed.length} closed` : ""}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/tasks"
            className="text-sm text-(--color-muted-foreground) hover:text-(--color-foreground)"
          >
            All tasks →
          </Link>
          <Button
            size="sm"
            variant={list.length > 0 ? "outline" : "default"}
            onClick={() => generateMut.mutate()}
            disabled={generateMut.isPending}
          >
            {generateMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            )}
            {list.length > 0 ? "Generate more" : "Generate tasks"}
          </Button>
        </div>
      </div>
      {loading ? (
        <p className="text-sm text-(--color-muted-foreground)">Loading tasks…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-(--color-muted-foreground)">
          No tasks for this encounter yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {[...open, ...closed].map((t) => (
            <EncounterTaskRow
              key={t.id}
              task={t}
              busy={busyId === t.id}
              onComplete={() => void handleComplete(t)}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function EncounterTaskRow({
  task,
  busy,
  onComplete,
}: {
  task: Task;
  busy: boolean;
  onComplete: () => void;
}) {
  const closed = task.isClosed;
  return (
    <li>
      <div
        className={`flex items-start gap-3 rounded-md border border-(--color-border) p-3 ${
          closed ? "opacity-60" : ""
        }`}
      >
        <div className="mt-1">
          {closed ? (
            <CheckCircle2
              className="h-5 w-5 text-emerald-600"
              aria-hidden="true"
            />
          ) : (
            <CircleDashed
              className="h-5 w-5 text-(--color-muted-foreground)"
              aria-hidden="true"
            />
          )}
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="inline-flex rounded-full bg-(--color-muted) px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-(--color-border)">
              {TASK_CATEGORY_LABEL[task.category]}
            </span>
            {task.priority === "high" ? (
              <span className="text-xs font-medium uppercase text-red-700">
                High
              </span>
            ) : null}
            {task.source === "ai" ? (
              <span className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
                AI
              </span>
            ) : null}
            <span className="text-sm font-medium">{task.title}</span>
          </div>
          {task.description ? (
            <p className="text-xs text-(--color-muted-foreground)">
              {task.description}
            </p>
          ) : null}
          {task.dueAt ? (
            <p className="text-xs text-(--color-muted-foreground)">
              Due {new Date(task.dueAt).toLocaleDateString()}
            </p>
          ) : null}
        </div>
        {!closed ? (
          <Button size="sm" onClick={onComplete} disabled={busy}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            )}
            Done
          </Button>
        ) : null}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Patient summary panel
// ---------------------------------------------------------------------------

function PatientSummaryPanel({ note }: { note: Note | null }) {
  // Summary lives in panel state (not persisted) so it clears on
  // remount. Re-running is cheap; v2 will persist + offer PDF / portal
  // export from the same surface.
  const [summary, setSummary] = useState<PatientSummary | null>(null);
  const [busy, setBusy] = useState(false);
  // Selected language. Defaults to English; the provider switches via the
  // dropdown before clicking Generate. Changing language after a generation
  // doesn't auto-regenerate — provider clicks Regenerate to commit.
  const [language, setLanguage] = useState<SummaryLanguage>("en");

  // Don't show the panel until there's a note to summarize. Empty
  // encounter renders cleaner without it.
  if (!note) return null;

  const generate = async () => {
    setBusy(true);
    try {
      const s = await generatePatientSummary(note.id, language);
      setSummary(s);
      toast.success(
        s.source === "ai"
          ? "Patient summary generated"
          : "Patient summary generated (stub)",
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't generate summary");
    } finally {
      setBusy(false);
    }
  };

  const copyAsText = async () => {
    if (!summary) return;
    const text = summaryAsPlainText(summary);
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Couldn't copy");
    }
  };

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileText
            className="h-5 w-5 text-(--color-muted-foreground)"
            aria-hidden="true"
          />
          <h2 className="text-lg font-medium">Patient summary</h2>
          {summary ? (
            <span className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
              {summary.source === "ai" ? "AI" : "stub"}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as SummaryLanguage)}
            aria-label="Summary language"
            disabled={busy}
            className="h-8 rounded-md border border-(--color-border) bg-(--color-card) px-2 text-xs"
          >
            {LANGUAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {summary ? (
            <Button size="sm" variant="ghost" onClick={() => void copyAsText()}>
              Copy
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={summary ? "outline" : "default"}
            onClick={() => void generate()}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            )}
            {summary ? "Regenerate" : "Generate"}
          </Button>
        </div>
      </div>
      {!summary ? (
        <p className="text-sm text-(--color-muted-foreground)">
          Generate a 6th-grade reading-level handout the patient can take home,
          send via portal, or read in the room before leaving.
        </p>
      ) : (
        <SummaryDisplay summary={summary} />
      )}
    </Card>
  );
}

function SummaryDisplay({ summary }: { summary: PatientSummary }) {
  return (
    <article className="space-y-4 rounded-md border border-(--color-border) bg-(--color-card) p-4">
      <p className="text-sm leading-relaxed">{summary.overview}</p>

      {summary.diagnoses.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground)">
            What we found
          </h3>
          <ul className="space-y-2">
            {summary.diagnoses.map((d, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium">{d.name}.</span>{" "}
                <span className="text-(--color-muted-foreground)">
                  {d.explanation}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {summary.medications.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground)">
            Your medicines
          </h3>
          <ul className="space-y-2">
            {summary.medications.map((m, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium">{m.name}</span> — {m.howToTake}
                <p className="text-xs italic text-(--color-muted-foreground)">
                  Why: {m.why}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {summary.selfCare.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground)">
            How to take care of yourself at home
          </h3>
          <ul className="list-inside list-disc space-y-1 text-sm">
            {summary.selfCare.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {summary.followUp ? (
        <section className="space-y-1">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground)">
            Coming back
          </h3>
          <p className="text-sm">
            <span className="font-medium">{summary.followUp.when}.</span>{" "}
            {summary.followUp.why}
          </p>
        </section>
      ) : null}

      {summary.whenToCall.length > 0 ? (
        <section className="space-y-2 rounded-md bg-red-50 p-3 ring-1 ring-inset ring-red-200">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-red-900">
            Call us right away if…
          </h3>
          <ul className="list-inside list-disc space-y-1 text-sm text-red-900">
            {summary.whenToCall.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

// Plain-text serializer for the copy-to-clipboard button. Mirrors the
// rendered structure so a patient pasting it into a portal message
// (or print preview) sees the same sections in the same order.
function summaryAsPlainText(s: PatientSummary): string {
  const lines: string[] = [s.overview, ""];
  if (s.diagnoses.length > 0) {
    lines.push("WHAT WE FOUND");
    for (const d of s.diagnoses) lines.push(`• ${d.name}. ${d.explanation}`);
    lines.push("");
  }
  if (s.medications.length > 0) {
    lines.push("YOUR MEDICINES");
    for (const m of s.medications) {
      lines.push(`• ${m.name} — ${m.howToTake}`);
      lines.push(`  Why: ${m.why}`);
    }
    lines.push("");
  }
  if (s.selfCare.length > 0) {
    lines.push("HOW TO TAKE CARE OF YOURSELF AT HOME");
    for (const c of s.selfCare) lines.push(`• ${c}`);
    lines.push("");
  }
  if (s.followUp) {
    lines.push("COMING BACK");
    lines.push(`${s.followUp.when}. ${s.followUp.why}`);
    lines.push("");
  }
  if (s.whenToCall.length > 0) {
    lines.push("CALL US RIGHT AWAY IF…");
    for (const w of s.whenToCall) lines.push(`• ${w}`);
  }
  return lines.join("\n").trim();
}

// ---------------------------------------------------------------------------
// Vitals panel
// ---------------------------------------------------------------------------

function VitalsPanel({ note }: { note: Note | null }) {
  const [vitals, setVitals] = useState<VitalsResponse | null>(null);
  const [busy, setBusy] = useState(false);

  if (!note) return null;

  const extract = async () => {
    setBusy(true);
    try {
      const v = await extractVitals(note.id);
      setVitals(v);
      const count = countExtractedVitals(v);
      if (count === 0) {
        toast.message(
          v.source === "ai"
            ? "No vitals documented in this note."
            : "AI is offline; stub returned no vitals.",
        );
      } else {
        toast.success(`Extracted ${count} vital${count === 1 ? "" : "s"}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't extract vitals");
    } finally {
      setBusy(false);
    }
  };

  const extractedCount = vitals ? countExtractedVitals(vitals) : 0;

  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity
            className="h-5 w-5 text-(--color-muted-foreground)"
            aria-hidden="true"
          />
          <h2 className="text-lg font-medium">Vitals</h2>
          {vitals ? (
            <span className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
              {vitals.source === "ai" ? "AI" : "stub"}
              {extractedCount > 0 ? ` · ${extractedCount} value${extractedCount === 1 ? "" : "s"}` : ""}
            </span>
          ) : null}
        </div>
        <Button
          size="sm"
          variant={vitals ? "outline" : "default"}
          onClick={() => void extract()}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          )}
          {vitals ? "Re-extract" : "Extract vitals"}
        </Button>
      </div>
      {!vitals ? (
        <p className="text-sm text-(--color-muted-foreground)">
          Click to extract structured vital signs (BP, HR, temp, SpO₂…) from
          the note. Each value shows the verbatim source phrase so you can
          fact-check the extraction.
        </p>
      ) : extractedCount === 0 ? (
        <p className="rounded-md bg-(--color-muted)/30 px-3 py-2 text-sm text-(--color-muted-foreground)">
          {vitals.source === "ai"
            ? "No vitals were documented in this note."
            : "AI extractor is offline (ANTHROPIC_API_KEY not configured). No vitals returned."}
        </p>
      ) : (
        <VitalsGrid vitals={vitals} />
      )}
    </Card>
  );
}

function countExtractedVitals(v: VitalsResponse): number {
  let n = 0;
  if (v.bp) n++;
  if (v.heartRate) n++;
  if (v.respiratoryRate) n++;
  if (v.temperatureF) n++;
  if (v.spo2Percent) n++;
  if (v.weightLbs) n++;
  if (v.heightIn) n++;
  if (v.bmi) n++;
  if (v.pain) n++;
  n += v.other.length;
  return n;
}

const CONFIDENCE_DOT: Record<VitalConfidence, string> = {
  high: "bg-emerald-500",
  medium: "bg-amber-500",
  low: "bg-red-500",
};

function VitalsGrid({ vitals }: { vitals: VitalsResponse }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {vitals.bp ? (
        <VitalTile
          label="BP"
          value={`${vitals.bp.systolic}/${vitals.bp.diastolic}`}
          unit="mmHg"
          source={vitals.bp.source}
          confidence={vitals.bp.confidence}
          extra={vitals.bp.position ?? undefined}
        />
      ) : null}
      {vitals.heartRate ? (
        <VitalTile
          label="HR"
          value={String(vitals.heartRate.value)}
          unit="bpm"
          source={vitals.heartRate.source}
          confidence={vitals.heartRate.confidence}
        />
      ) : null}
      {vitals.respiratoryRate ? (
        <VitalTile
          label="RR"
          value={String(vitals.respiratoryRate.value)}
          unit="bpm"
          source={vitals.respiratoryRate.source}
          confidence={vitals.respiratoryRate.confidence}
        />
      ) : null}
      {vitals.temperatureF ? (
        <VitalTile
          label="Temp"
          value={String(vitals.temperatureF.value)}
          unit="°F"
          source={vitals.temperatureF.source}
          confidence={vitals.temperatureF.confidence}
        />
      ) : null}
      {vitals.spo2Percent ? (
        <VitalTile
          label="SpO₂"
          value={`${vitals.spo2Percent.value}`}
          unit="%"
          source={vitals.spo2Percent.source}
          confidence={vitals.spo2Percent.confidence}
        />
      ) : null}
      {vitals.weightLbs ? (
        <VitalTile
          label="Weight"
          value={String(vitals.weightLbs.value)}
          unit="lbs"
          source={vitals.weightLbs.source}
          confidence={vitals.weightLbs.confidence}
        />
      ) : null}
      {vitals.heightIn ? (
        <VitalTile
          label="Height"
          value={String(vitals.heightIn.value)}
          unit="in"
          source={vitals.heightIn.source}
          confidence={vitals.heightIn.confidence}
        />
      ) : null}
      {vitals.bmi ? (
        <VitalTile
          label="BMI"
          value={String(vitals.bmi.value)}
          unit=""
          source={vitals.bmi.source}
          confidence={vitals.bmi.confidence}
        />
      ) : null}
      {vitals.pain ? (
        <VitalTile
          label="Pain"
          value={vitals.pain.score != null ? `${vitals.pain.score}/10` : "—"}
          unit=""
          source={vitals.pain.source}
          confidence={vitals.pain.confidence}
        />
      ) : null}
      {vitals.other.map((o, i) => (
        <VitalTile
          key={`${o.label}-${i}`}
          label={o.label}
          value={o.valueText}
          unit=""
          source={o.source}
          confidence="medium"
        />
      ))}
    </div>
  );
}

// Single vital "tile". Tabular numbers + confidence dot + verbatim
// source line below. title attribute carries the full source so a long
// quote isn't truncated invisibly.
function VitalTile({
  label,
  value,
  unit,
  source,
  confidence,
  extra,
}: {
  label: string;
  value: string;
  unit: string;
  source: string;
  confidence: VitalConfidence;
  extra?: string;
}) {
  return (
    <div className="rounded-md border border-(--color-border) bg-(--color-card) p-3">
      <div className="flex items-start justify-between gap-1">
        <p className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
          {label}
        </p>
        <span
          aria-label={`Confidence: ${confidence}`}
          title={`Confidence: ${confidence}`}
          className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${CONFIDENCE_DOT[confidence]}`}
        />
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <p className="text-xl font-semibold tabular-nums">{value}</p>
        {unit ? (
          <p className="text-xs text-(--color-muted-foreground)">{unit}</p>
        ) : null}
      </div>
      {extra ? (
        <p className="text-xs text-(--color-muted-foreground)">{extra}</p>
      ) : null}
      <p
        className="mt-1 truncate text-xs italic text-(--color-muted-foreground)"
        title={source}
      >
        &ldquo;{source}&rdquo;
      </p>
    </div>
  );
}

