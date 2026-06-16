import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  Calendar,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mic,
  RefreshCw,
  Send,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import {
  ApiError,
  getGetTodayScheduleQueryKey,
  getListNotesQueryKey,
  useGetEhrConnectionStatus,
  useGetTodaySchedule,
  useListNotes,
  useSendNoteToEhr,
  useSyncPatientFromEhr,
  type Note,
  type ScheduledAppointment,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  claimAppointment,
  getAppointmentClaim,
} from "@/lib/appointment-note-links";
import {
  deriveWorkflowStatus,
  STATUS_LABEL,
  STATUS_TONE,
  workflowActions,
  type NoteSnapshot,
  type WorkflowAction,
  type WorkflowStatus,
} from "@/lib/schedule-workflow";

// Schedule refetch cadence. The product spec asks for 60–120s; 90s is
// the middle of the band. Polling only fires while the user is looking
// at today — past/future days are read-once.
const SCHEDULE_POLL_MS = 90 * 1000;
// How many recent notes to pull for correlation. Notes on a given day
// for a busy clinic shouldn't exceed ~30; 100 leaves comfortable slack
// without paginating.
const NOTES_PAGE_LIMIT = 100;

function formatTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function toLocalDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

function parseLocalDateString(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y ?? 2000, (m ?? 1) - 1, d ?? 1);
}

function formatLongDate(d: Date): string {
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function shiftDays(s: string, delta: number): string {
  const d = parseLocalDateString(s);
  d.setDate(d.getDate() + delta);
  return toLocalDateString(d);
}

// Pick the most-recent ACTIVE note authored after `claimedAt` for the
// given patient. The schedule view uses this to attach a note to its
// originating appointment without a backend join.
function pickMatchingNote(
  notes: readonly Note[],
  patientId: string,
  claimedAt: Date,
): Note | null {
  let best: Note | null = null;
  for (const n of notes) {
    if (n.patientId !== patientId) continue;
    if (n.status === "entered-in-error") continue;
    const created = new Date(n.createdAt);
    if (Number.isNaN(created.getTime())) continue;
    if (created.getTime() < claimedAt.getTime()) continue;
    if (!best || new Date(best.createdAt).getTime() < created.getTime()) {
      best = n;
    }
  }
  return best;
}

function toNoteSnapshot(n: Note): NoteSnapshot {
  return {
    id: n.id,
    status: n.status,
    ehrDocumentRef: n.ehrDocumentRef,
    ehrPushedAt: n.ehrPushedAt,
    ehrError: n.ehrError,
  };
}

export function TodayPage() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const sync = useSyncPatientFromEhr();
  const sendNote = useSendNoteToEhr();
  const [busyId, setBusyId] = useState<string | null>(null);

  const today = useMemo(() => toLocalDateString(new Date()), []);
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const isToday = selectedDate === today;
  const selectedDateObj = useMemo(
    () => parseLocalDateString(selectedDate),
    [selectedDate],
  );

  // Schedule query — only poll while looking at today.
  const params = { date: selectedDate };
  const scheduleQuery = useGetTodaySchedule(params, {
    query: {
      queryKey: getGetTodayScheduleQueryKey(params),
      refetchInterval: isToday ? SCHEDULE_POLL_MS : false,
      refetchOnWindowFocus: isToday,
    },
  });

  // Recent notes — used to derive per-appointment workflow status by
  // pairing each note to the claim the clinician made when they
  // clicked "Start note" on the originating schedule card.
  const notesParams = { limit: NOTES_PAGE_LIMIT };
  const notesQuery = useListNotes(notesParams, {
    query: {
      queryKey: getListNotesQueryKey(notesParams),
      refetchInterval: isToday ? SCHEDULE_POLL_MS : false,
      refetchOnWindowFocus: isToday,
    },
  });

  // Connection status drives the "demo data" banner when EHR is not
  // connected (or HaloNote is running with EHR_MODE unset on the server).
  const connStatus = useGetEhrConnectionStatus();
  const ehrConnected = Boolean(
    connStatus.data?.athenahealth?.connected ?? false,
  );

  // "Last synced HH:MM" — reflects the schedule query's last successful
  // refetch (not the note query's, which is paired). Falls back to "—"
  // while the first load is still in flight.
  const lastSyncedLabel =
    scheduleQuery.dataUpdatedAt > 0
      ? `Last synced ${formatTime(new Date(scheduleQuery.dataUpdatedAt))}`
      : "Syncing…";

  // Per-appointment workflow derivation. Cheap; rebuilt on every render
  // because both inputs (schedule list, notes list) are cache-stable
  // between refetches.
  const workflow = useMemo(() => {
    const map = new Map<
      string,
      { status: WorkflowStatus; note: Note | null }
    >();
    const notes = notesQuery.data?.data ?? [];
    for (const appt of scheduleQuery.data?.data ?? []) {
      const claim = getAppointmentClaim(appt.appointmentId);
      const matched = claim
        ? pickMatchingNote(notes, claim.patientId, new Date(claim.claimedAt))
        : null;
      const status = deriveWorkflowStatus(
        { fhirStatus: appt.status },
        matched ? toNoteSnapshot(matched) : null,
      );
      map.set(appt.appointmentId, { status, note: matched });
    }
    return map;
  }, [scheduleQuery.data, notesQuery.data]);

  // Day-level progress summary used in the header — at-a-glance,
  // "X of Y visits done · Z left".
  const dayCounts = useMemo(() => {
    let completed = 0;
    let inProgress = 0;
    let remaining = 0;
    let total = 0;
    for (const { status } of workflow.values()) {
      if (status === "cancelled" || status === "no_show") continue;
      total += 1;
      if (status === "completed") completed += 1;
      else if (status === "in_progress" || status === "failed_sync") inProgress += 1;
      else remaining += 1;
    }
    return { completed, inProgress, remaining, total };
  }, [workflow]);

  function refreshAll(): void {
    void scheduleQuery.refetch();
    void notesQuery.refetch();
  }

  // Click the row → sync patient → claim the appointment for this
  // patient → open new note. The claim lets the next schedule refetch
  // correlate the autosaved note back to this appointment row.
  async function startNote(appt: ScheduledAppointment) {
    if (!appt.patient) {
      toast.error("This appointment has no patient assigned.");
      return;
    }
    setBusyId(appt.appointmentId);
    try {
      const synced = await sync.mutateAsync({
        data: { externalId: appt.patient.ehrId },
      });
      claimAppointment(appt.appointmentId, synced.id);
      // `?autostart=1` tells NewNote → RecordingPanel to fire
      // getUserMedia on mount. The click that ran startNote IS the
      // user gesture browsers want, and wouter's navigate is synchronous
      // — the autorun happens on the same task continuation, so the
      // gesture window is still open when getUserMedia runs.
      navigate(
        `/patients/${synced.id}/notes/new?ehrId=${encodeURIComponent(
          appt.patient.ehrId,
        )}&autostart=1`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't open patient");
    } finally {
      setBusyId(null);
    }
  }

  function openNote(note: Note) {
    navigate(`/patients/${note.patientId}/notes/${note.id}`);
  }

  async function sendNoteToEhr(note: Note, apptId: string) {
    setBusyId(apptId);
    try {
      const outcome = await sendNote.mutateAsync({ id: note.id });
      toast.success(
        outcome.mock
          ? "Sent to EHR (mock)"
          : `Sent to ${outcome.provider}`,
      );
      // Force both queries to refetch so the card flips to "Completed".
      void queryClient.invalidateQueries({
        queryKey: getListNotesQueryKey(notesParams),
      });
      void queryClient.invalidateQueries({
        queryKey: getGetTodayScheduleQueryKey(params),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "EHR send failed");
    } finally {
      setBusyId(null);
    }
  }

  const notLinked =
    scheduleQuery.isError &&
    scheduleQuery.error instanceof ApiError &&
    scheduleQuery.error.status === 409;

  if (notLinked) {
    return (
      <div className="space-y-6">
        <header className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">Today</h1>
          <p className="text-(--color-muted-foreground)">
            {formatLongDate(new Date())}
          </p>
        </header>
        <Card className="space-y-3 p-6 text-center">
          <Calendar
            className="mx-auto h-10 w-10 text-(--color-muted-foreground)"
            aria-hidden="true"
          />
          <h2 className="text-lg font-medium">
            Connect your EHR to see your schedule
          </h2>
          <p className="text-sm text-(--color-muted-foreground)">
            Your HaloNote account isn't linked to an EHR provider yet. An admin
            can set your Practitioner ID under Users.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">
              {isToday ? "Today" : "Schedule"}
            </h1>
            <p className="text-(--color-muted-foreground)">
              {formatLongDate(selectedDateObj)}
              {dayCounts.total > 0 ? (
                <span className="ml-2 text-(--color-muted-foreground)/70">
                  ·{" "}
                  <span className="font-medium text-(--color-foreground)">
                    {dayCounts.completed}
                  </span>
                  {" of "}
                  <span className="font-medium text-(--color-foreground)">
                    {dayCounts.total}
                  </span>{" "}
                  completed
                  {dayCounts.inProgress > 0
                    ? ` · ${dayCounts.inProgress} in progress`
                    : ""}
                </span>
              ) : null}
            </p>
          </div>

          {/* Date navigation grouped as a single segmented control,
              with the refresh button hugging it on the right. */}
          <div className="flex items-center gap-2">
            <div className="inline-flex items-center rounded-md border border-(--color-border) bg-(--color-card) shadow-sm">
              <button
                type="button"
                onClick={() => setSelectedDate((d) => shiftDays(d, -1))}
                aria-label="Previous day"
                className="flex h-9 items-center px-2 text-(--color-muted-foreground) hover:bg-(--color-muted) hover:text-(--color-foreground)"
              >
                <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              </button>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) setSelectedDate(v);
                }}
                aria-label="Select date"
                className="h-9 border-x border-(--color-border) bg-transparent px-3 text-sm tabular-nums focus:outline-none"
              />
              <button
                type="button"
                onClick={() => setSelectedDate((d) => shiftDays(d, 1))}
                aria-label="Next day"
                className="flex h-9 items-center px-2 text-(--color-muted-foreground) hover:bg-(--color-muted) hover:text-(--color-foreground)"
              >
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            {!isToday ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedDate(today)}
              >
                Today
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              onClick={refreshAll}
              disabled={scheduleQuery.isFetching || notesQuery.isFetching}
              aria-label="Refresh schedule"
              title={lastSyncedLabel}
            >
              <RefreshCw
                className={`h-4 w-4 ${
                  scheduleQuery.isFetching || notesQuery.isFetching
                    ? "animate-spin"
                    : ""
                }`}
                aria-hidden="true"
              />
              <span className="sr-only">Refresh</span>
            </Button>
          </div>
        </div>

        {/* Demo-data banner — shown only when the user is connected
            *neither* through SMART OAuth nor via the legacy
            ehrPractitionerId path the 409-not-linked branch covers.
            Skip in error state, where the error message itself is
            more useful. */}
        {!connStatus.isPending && !ehrConnected && !scheduleQuery.isError ? (
          <p
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
            role="status"
          >
            Showing demo data. Connect Athena from Settings to see your real
            schedule.
          </p>
        ) : null}
      </header>

      {scheduleQuery.isPending ? (
        <p role="status" className="text-(--color-muted-foreground)">
          Loading schedule…
        </p>
      ) : scheduleQuery.isError ? (
        <p role="alert" className="text-(--color-destructive)">
          Couldn't load schedule.{" "}
          {scheduleQuery.error instanceof Error
            ? scheduleQuery.error.message
            : ""}
        </p>
      ) : scheduleQuery.data.data.length === 0 ? (
        <Card className="p-10 text-center text-(--color-muted-foreground)">
          <Calendar className="mx-auto mb-2 h-8 w-8" aria-hidden="true" />
          {isToday
            ? "Nothing on your schedule today."
            : "Nothing scheduled for this day."}
        </Card>
      ) : (
        <ul
          className="space-y-3"
          aria-label={isToday ? "Today's appointments" : "Appointments"}
        >
          {scheduleQuery.data.data.map((appt) => {
            const wf = workflow.get(appt.appointmentId);
            const status: WorkflowStatus = wf?.status ?? "unknown";
            const note = wf?.note ?? null;
            const actions = workflowActions(status, !!note);
            const busy = busyId === appt.appointmentId;
            return (
              <AppointmentCard
                key={appt.appointmentId}
                appt={appt}
                status={status}
                note={note}
                actions={actions}
                busy={busy}
                onStart={() => void startNote(appt)}
                onOpenNote={() => note && openNote(note)}
                onSend={() =>
                  note && void sendNoteToEhr(note, appt.appointmentId)
                }
              />
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface AppointmentCardProps {
  appt: ScheduledAppointment;
  status: WorkflowStatus;
  note: Note | null;
  actions: readonly WorkflowAction[];
  busy: boolean;
  onStart: () => void;
  onOpenNote: () => void;
  onSend: () => void;
}

// Left accent-bar color per status — mirrors the badge palette but
// applied to a 4px rail on the card's leading edge for at-a-glance
// scanning of a long list.
const STATUS_RAIL: Record<WorkflowStatus, string> = {
  pending: "bg-sky-400",
  checked_in: "bg-amber-400",
  in_progress: "bg-violet-400",
  completed: "bg-emerald-500",
  failed_sync: "bg-red-500",
  cancelled: "bg-(--color-border)",
  no_show: "bg-(--color-border)",
  unknown: "bg-(--color-border)",
};

function AppointmentCard({
  appt,
  status,
  note,
  actions,
  busy,
  onStart,
  onOpenNote,
  onSend,
}: AppointmentCardProps) {
  const label = STATUS_LABEL[status];
  const tone = STATUS_TONE[status];
  const rail = STATUS_RAIL[status];
  const pushedAt = note?.ehrPushedAt
    ? new Date(note.ehrPushedAt)
    : null;

  return (
    <li>
      <Card className="relative overflow-hidden transition-colors hover:bg-(--color-muted)/40">
        <span
          aria-hidden="true"
          className={`absolute inset-y-0 left-0 w-1 ${rail}`}
        />
        <div className="flex flex-wrap items-center gap-4 px-5 py-4">
          <div className="min-w-[4rem] text-center">
            <div className="text-base font-semibold tabular-nums">
              {formatTime(appt.start)}
            </div>
            {appt.end ? (
              <div className="text-xs text-(--color-muted-foreground) tabular-nums">
                {formatTime(appt.end)}
              </div>
            ) : null}
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="text-base font-medium leading-snug">
              {appt.patient?.display ?? "Unknown patient"}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm text-(--color-muted-foreground)">
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}
              >
                {label}
              </span>
              {status === "completed" && pushedAt ? (
                <span className="inline-flex items-center gap-1">
                  <CheckCircle2
                    className="h-3.5 w-3.5"
                    aria-hidden="true"
                  />
                  Pushed {formatTime(pushedAt)}
                </span>
              ) : null}
              {status === "failed_sync" && note?.ehrError ? (
                <span className="inline-flex items-center gap-1 text-(--color-destructive)">
                  <TriangleAlert
                    className="h-3.5 w-3.5"
                    aria-hidden="true"
                  />
                  Last error: {note.ehrError.slice(0, 80)}
                </span>
              ) : null}
              {appt.reason ? <span>{appt.reason}</span> : null}
            </div>
          </div>
          <div className="flex w-full shrink-0 flex-wrap items-center gap-2 sm:w-auto [&>*]:flex-1 [&>*]:sm:flex-none">
            {busy ? (
              <Loader2 className="h-5 w-5 animate-spin text-(--color-muted-foreground)" aria-hidden="true" />
            ) : null}
            {actions.includes("start_note") ? (
              <Button size="sm" onClick={onStart} disabled={busy}>
                <Mic className="h-4 w-4" aria-hidden="true" />
                Start note
              </Button>
            ) : null}
            {actions.includes("continue_note") ? (
              <Button
                size="sm"
                variant="outline"
                onClick={onOpenNote}
                disabled={busy}
              >
                Continue note
              </Button>
            ) : null}
            {actions.includes("send_to_ehr") ? (
              <Button size="sm" onClick={onSend} disabled={busy}>
                <Send className="h-4 w-4" aria-hidden="true" />
                Send to EHR
              </Button>
            ) : null}
            {actions.includes("retry_send") ? (
              <Button size="sm" onClick={onSend} disabled={busy}>
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Retry send
              </Button>
            ) : null}
            {actions.includes("view_note") ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={onOpenNote}
                disabled={busy}
              >
                <ChevronRight className="h-4 w-4" aria-hidden="true" />
                View note
              </Button>
            ) : null}
          </div>
        </div>
      </Card>
    </li>
  );
}
