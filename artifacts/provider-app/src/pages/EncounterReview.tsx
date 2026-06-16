import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  CircleDashed,
  FileText,
  Loader2,
  ReceiptText,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

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
      />

      <BillingPanel
        encounterId={encounterId}
        billing={billingQuery.data ?? null}
        loading={billingQuery.isPending}
        onChanged={() =>
          void qc.invalidateQueries({ queryKey: ["billing", encounterId] })
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
}: {
  note: Note | null;
  loading: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

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
        {note && note.status === "draft" ? (
          <Button size="sm" onClick={() => void approve()} disabled={busy}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            )}
            Approve & sign
          </Button>
        ) : null}
      </div>
      {loading ? (
        <p className="text-sm text-(--color-muted-foreground)">Loading note…</p>
      ) : !note ? (
        <p className="text-sm text-(--color-muted-foreground)">
          No note linked to this encounter yet.
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
    </Card>
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
