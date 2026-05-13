import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  Calendar,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Mic,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import {
  ApiError,
  getGetTodayScheduleQueryKey,
  useGetTodaySchedule,
  useSyncPatientFromEhr,
  type ScheduledAppointment,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

// Local YYYY-MM-DD for a Date object — using ISO would shift dates by
// up to a day for users east of UTC.
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

function statusTone(status: string): { label: string; class: string } {
  const s = status.toLowerCase();
  if (s === "arrived" || s === "checked-in") {
    return {
      label: "Arrived",
      class: "bg-amber-50 text-amber-800 ring-amber-200",
    };
  }
  if (s === "fulfilled") {
    return {
      label: "Done",
      class: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    };
  }
  if (s === "cancelled" || s === "noshow") {
    return {
      label: status === "noshow" ? "No-show" : "Cancelled",
      class: "bg-(--color-muted) text-(--color-muted-foreground) ring-(--color-border)",
    };
  }
  // booked / proposed / pending / waitlist / etc.
  return {
    label: "Scheduled",
    class: "bg-sky-50 text-sky-800 ring-sky-200",
  };
}

export function TodayPage() {
  const [, navigate] = useLocation();
  const sync = useSyncPatientFromEhr();
  const [openingId, setOpeningId] = useState<string | null>(null);
  const today = useMemo(() => toLocalDateString(new Date()), []);
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const isToday = selectedDate === today;
  const selectedDateObj = useMemo(
    () => parseLocalDateString(selectedDate),
    [selectedDate],
  );

  // Only poll while the provider is looking at today — historical and
  // future days don't gain anything from a 15-minute refetch loop.
  const params = { date: selectedDate };
  const query = useGetTodaySchedule(params, {
    query: {
      queryKey: getGetTodayScheduleQueryKey(params),
      refetchInterval: isToday ? FIFTEEN_MINUTES_MS : false,
      refetchOnWindowFocus: isToday,
    },
  });

  async function openAppointment(appt: ScheduledAppointment) {
    if (!appt.patient) {
      toast.error("This appointment has no patient assigned.");
      return;
    }
    setOpeningId(appt.appointmentId);
    try {
      // Upsert the patient locally so the NewNote page has them. The
      // sync endpoint is a no-op if they're already in our DB.
      const synced = await sync.mutateAsync({
        data: { externalId: appt.patient.ehrId },
      });
      // Pass the EHR id along so the NewNote page can pull the patient's
      // active problems / meds / allergies for the context panel.
      navigate(
        `/patients/${synced.id}/notes/new?ehrId=${encodeURIComponent(appt.patient.ehrId)}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't open patient");
    } finally {
      setOpeningId(null);
    }
  }

  const notLinked =
    query.isError &&
    query.error instanceof ApiError &&
    query.error.status === 409;

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
          <h2 className="text-lg font-medium">Connect your EHR to see your schedule</h2>
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
      <header className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">
              {isToday ? "Today" : "Schedule"}
            </h1>
            <p className="text-(--color-muted-foreground)">
              {formatLongDate(selectedDateObj)}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            aria-label="Refresh schedule"
          >
            <RefreshCw
              className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
            {query.isFetching ? "Refreshing" : "Refresh"}
          </Button>
        </div>

        {/* Day navigation. Mobile-first: big tap targets on the left/right
            arrows, a native <input type="date"> in the middle for direct
            jumps, and a Today shortcut when we've drifted off the current
            date. */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSelectedDate((d) => shiftDays(d, -1))}
            aria-label="Previous day"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Prev</span>
          </Button>
          <input
            type="date"
            value={selectedDate}
            onChange={(e) => {
              const v = e.target.value;
              if (v) setSelectedDate(v);
            }}
            aria-label="Select date"
            className="h-9 rounded-md border border-(--color-border) bg-(--color-card) px-3 text-sm"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSelectedDate((d) => shiftDays(d, 1))}
            aria-label="Next day"
          >
            <span className="hidden sm:inline">Next</span>
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
          {!isToday ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSelectedDate(today)}
            >
              Today
            </Button>
          ) : null}
        </div>
      </header>

      {query.isPending ? (
        <p role="status" className="text-(--color-muted-foreground)">
          Loading schedule…
        </p>
      ) : query.isError ? (
        <p role="alert" className="text-(--color-destructive)">
          Couldn't load schedule.{" "}
          {query.error instanceof Error ? query.error.message : ""}
        </p>
      ) : query.data.data.length === 0 ? (
        <Card className="p-10 text-center text-(--color-muted-foreground)">
          <Calendar
            className="mx-auto mb-2 h-8 w-8"
            aria-hidden="true"
          />
          {isToday
            ? "Nothing on your schedule today."
            : "Nothing scheduled for this day."}
        </Card>
      ) : (
        <ul
          className="space-y-3"
          aria-label={isToday ? "Today's appointments" : "Appointments"}
        >
          {query.data.data.map((appt) => {
            const tone = statusTone(appt.status);
            const opening = openingId === appt.appointmentId;
            return (
              <li key={appt.appointmentId}>
                <Card
                  role="button"
                  tabIndex={0}
                  onClick={() => void openAppointment(appt)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void openAppointment(appt);
                    }
                  }}
                  className="cursor-pointer transition-colors hover:bg-(--color-muted) active:bg-(--color-muted)"
                >
                  <div className="flex items-center gap-4 px-5 py-4">
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
                          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone.class}`}
                        >
                          {tone.label}
                        </span>
                        {appt.reason ? <span>{appt.reason}</span> : null}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2 text-(--color-muted-foreground)">
                      {opening ? (
                        <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                      ) : (
                        <>
                          <Mic className="h-5 w-5" aria-hidden="true" />
                          <ChevronRight className="h-5 w-5" aria-hidden="true" />
                        </>
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
