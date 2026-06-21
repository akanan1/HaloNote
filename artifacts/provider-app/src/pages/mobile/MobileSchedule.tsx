// Mobile PWA landing — today's schedule, one big touch-target per row.
//
// Flow: provider opens the home-screen app → lands here → sees today's
// appointments → taps one → claim + sync + navigate to the existing
// NewNote recording flow (autostart=1 fires getUserMedia on mount,
// so the tap counts as the user-gesture browsers want).
//
// On first mount we fire POST /m/initialize. That's a one-shot that
// flips the auto-push flags (after_transcription mode +
// autoApproveNonMedOrders) so the doctor's record-and-walk-out flow
// actually delivers notes + non-med orders to the EHR without further
// taps. The endpoint is idempotent and respects later user edits.

import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { ChevronRight, Loader2, Mic, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  getGetTodayScheduleQueryKey,
  initializeMobile,
  useGetTodaySchedule,
  useSyncPatientFromEhr,
  type ScheduledAppointment,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { claimAppointment } from "@/lib/appointment-note-links";
import { Button } from "@/components/ui/button";
import { IosInstallHint } from "./IosInstallHint";

const POLL_MS = 30 * 1000;

function formatTime(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function todayString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function longLabelForDate(iso: string): string {
  // iso is YYYY-MM-DD local; reconstruct a local Date so the label
  // matches what the user picked (avoids the day-shift you get when
  // you pass "2026-06-22" to new Date() — it parses as UTC midnight).
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const local = new Date(y, m - 1, d);
  return local.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

export function MobileSchedulePage() {
  const [, navigate] = useLocation();
  const { user, refresh } = useAuth();
  const sync = useSyncPatientFromEhr();
  const [busyId, setBusyId] = useState<string | null>(null);

  // One-shot mobile init. Fires on mount if the AuthUser hasn't been
  // marked mobileOnboarded yet. Idempotent server-side; we still gate
  // here to avoid the extra round-trip on every visit.
  useEffect(() => {
    if (!user || user.mobileOnboarded) return;
    initializeMobile()
      .then(() => {
        // Refresh local auth state so the gate above stops firing on
        // navigation within this session.
        void refresh();
      })
      .catch((err) => {
        // Don't block recording — mobile init failure just means the
        // doctor's settings stay as-is. We log + soldier on.
        console.warn("Mobile init failed", err);
      });
  }, [user, refresh]);

  // Optional ?date=YYYY-MM-DD override — handy in demo + dev when
  // today is a weekend and the mock schedule generator returns []. In
  // production this is harmless: any past/future date the EHR has
  // appointments for renders normally.
  const params = useMemo(() => {
    const qs = new URLSearchParams(window.location.search);
    const override = qs.get("date");
    const date = override && /^\d{4}-\d{2}-\d{2}$/.test(override)
      ? override
      : todayString();
    return { date };
  }, []);
  const scheduleQuery = useGetTodaySchedule(params, {
    query: {
      queryKey: getGetTodayScheduleQueryKey(params),
      refetchInterval: POLL_MS,
      refetchOnWindowFocus: true,
    },
  });

  const appointments = scheduleQuery.data?.data ?? [];
  const upcoming = appointments.filter(
    (a) => a.status !== "cancelled" && a.status !== "no_show",
  );

  async function openPatient(appt: ScheduledAppointment) {
    if (!appt.patient) {
      toast.error("This appointment has no patient assigned.");
      return;
    }
    setBusyId(appt.appointmentId);
    try {
      const synced = await sync.mutateAsync({
        data: { externalId: appt.patient.ehrId },
      });
      await claimAppointment(appt.appointmentId, synced.id);
      // Hand off to the mobile-only record screen. wouter's navigate
      // is synchronous, so the tap that ran openPatient is still the
      // active user gesture when MobileRecord's RecordingPanel mounts
      // and calls getUserMedia — same trick the desktop Today page
      // uses to dodge the "user gesture required" mic prompt.
      const name = appt.patient.display ?? "";
      navigate(
        `/m/record/${synced.id}?name=${encodeURIComponent(name)}`,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't open patient",
      );
      setBusyId(null);
    }
  }

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col bg-(--color-background) text-(--color-foreground)">
      <IosInstallHint />
      {/* Top bar — name + date + manual refresh. Safe-area-aware top
          padding so the iOS notch doesn't eat the title. */}
      <header className="sticky top-0 z-10 border-b border-(--color-border) bg-(--color-background)/95 px-4 pb-3 pt-[max(env(safe-area-inset-top),1rem)] backdrop-blur">
        <div className="flex items-baseline justify-between gap-2">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-(--color-muted-foreground)">
              Today
            </div>
            <h1 className="text-lg font-semibold tracking-tight">
              {longLabelForDate(params.date)}
            </h1>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => void scheduleQuery.refetch()}
            disabled={scheduleQuery.isFetching}
            aria-label="Refresh schedule"
          >
            {scheduleQuery.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
          </Button>
        </div>
        {user?.displayName ? (
          <div className="mt-0.5 text-xs text-(--color-muted-foreground)">
            {user.displayName}
          </div>
        ) : null}
      </header>

      {/* Body */}
      <main className="flex-1 px-4 py-3">
        {scheduleQuery.isPending ? (
          <ul className="space-y-2" aria-label="Loading schedule">
            {[0, 1, 2, 3].map((i) => (
              <li
                key={i}
                className="h-20 animate-pulse rounded-lg bg-(--color-muted)"
              />
            ))}
          </ul>
        ) : scheduleQuery.isError ? (
          <EmptyState
            title="Couldn't load today's schedule"
            body={
              scheduleQuery.error instanceof Error
                ? scheduleQuery.error.message
                : "Try again in a moment."
            }
          />
        ) : upcoming.length === 0 ? (
          <EmptyState
            title="No appointments today"
            body="When your schedule fills in from the EHR, your patients will show up here."
          />
        ) : (
          <ul className="space-y-2">
            {upcoming.map((appt) => (
              <li key={appt.appointmentId}>
                <AppointmentTile
                  appt={appt}
                  busy={busyId === appt.appointmentId}
                  onTap={() => void openPatient(appt)}
                />
              </li>
            ))}
          </ul>
        )}
      </main>

      {/* Bottom hint — only on the first visit (before mobileOnboarded
          flips). Surfaces what's about to happen so the auto-push isn't
          a surprise. */}
      {user && !user.mobileOnboarded ? (
        <footer className="border-t border-(--color-border) bg-(--color-muted)/30 px-4 pb-[max(env(safe-area-inset-bottom),1rem)] pt-3 text-xs text-(--color-muted-foreground)">
          <p>
            <span className="font-medium text-(--color-foreground)">
              Mobile mode activated.
            </span>{" "}
            Notes auto-push to the chart after each recording. Non-medication
            orders push automatically. Medications stay queued for your
            desktop review.
          </p>
        </footer>
      ) : null}
    </div>
  );
}

function AppointmentTile({
  appt,
  busy,
  onTap,
}: {
  appt: ScheduledAppointment;
  busy: boolean;
  onTap: () => void;
}) {
  const patientName = appt.patient?.display ?? "Unassigned";
  const time = appt.start ? formatTime(appt.start) : "—";
  return (
    <button
      type="button"
      onClick={onTap}
      disabled={busy || !appt.patient}
      className="flex w-full items-center gap-3 rounded-lg border border-(--color-border) bg-(--color-card) px-4 py-4 text-left transition active:scale-[0.98] disabled:opacity-60"
    >
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-(--color-primary)/10 text-(--color-primary)">
        {busy ? (
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
        ) : (
          <Mic className="h-5 w-5" aria-hidden="true" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-base font-medium">{patientName}</span>
          <span className="shrink-0 text-sm text-(--color-muted-foreground)">
            {time}
          </span>
        </div>
        {appt.reason ? (
          <div className="mt-0.5 truncate text-xs text-(--color-muted-foreground)">
            {appt.reason}
          </div>
        ) : null}
      </div>
      <ChevronRight
        className="h-5 w-5 shrink-0 text-(--color-muted-foreground)"
        aria-hidden="true"
      />
    </button>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="mt-10 rounded-lg border border-dashed border-(--color-border) px-6 py-10 text-center">
      <h2 className="text-base font-medium">{title}</h2>
      <p className="mt-1 text-sm text-(--color-muted-foreground)">{body}</p>
    </div>
  );
}
