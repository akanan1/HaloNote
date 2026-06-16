import { useMemo } from "react";
import { Link } from "wouter";
import { Calendar, ChevronRight, Video } from "lucide-react";
import {
  getListEncountersQueryKey,
  useListEncounters,
  useListPatients,
  type Encounter,
  type EncounterStatus,
  type Patient,
  type VisitType,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";

// Cap rows shown — provider's "what have I been doing" feed should be
// quick to scan, not a backfill of every visit in the clinic.
const MAX_ROWS = 6;

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

const STATUS_LABEL: Record<EncounterStatus, string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

function formatTimestamp(iso: string): string {
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

function pickAnchorTimestamp(e: Encounter): string {
  return e.completedAt ?? e.startedAt ?? e.scheduledAt ?? e.createdAt;
}

function patientDisplayName(p: Patient | undefined): string {
  if (!p) return "Unknown patient";
  return `${p.lastName}, ${p.firstName}`;
}

export function RecentEncountersSection() {
  // No patientId → org-wide. Server returns up to 200 ordered by createdAt
  // desc; we slice to MAX_ROWS after the lookup so the cache stays useful
  // for the PatientDetail page (which uses the patientId-filtered key).
  const params = {};
  const query = useListEncounters(params, {
    query: { queryKey: getListEncountersQueryKey(params) },
  });
  const patientsQuery = useListPatients();

  const patientsById = useMemo(() => {
    const map = new Map<string, Patient>();
    for (const p of patientsQuery.data?.data ?? []) {
      map.set(p.id, p);
    }
    return map;
  }, [patientsQuery.data]);

  const encounters: Encounter[] = useMemo(
    () => (query.data?.data ?? []).slice(0, MAX_ROWS),
    [query.data],
  );

  // Empty list is the common dev-day state on a fresh DB. Skip the section
  // entirely rather than rendering an empty card — keeps Today scannable.
  if (!query.isPending && encounters.length === 0) {
    return null;
  }

  return (
    <section className="space-y-3" aria-labelledby="recent-encounters-heading">
      <h2
        id="recent-encounters-heading"
        className="text-lg font-medium text-(--color-foreground)"
      >
        Recent encounters
      </h2>
      {query.isPending ? (
        <p className="text-sm text-(--color-muted-foreground)">
          Loading recent encounters…
        </p>
      ) : (
        <ul className="space-y-2" aria-label="Recent encounters">
          {encounters.map((e) => {
            const p = patientsById.get(e.patientId);
            const label =
              e.visitType === "custom" && e.customLabel
                ? e.customLabel
                : VISIT_LABEL[e.visitType];
            return (
              <li key={e.id}>
                <Link
                  href={`/patients/${e.patientId}/encounters/${e.id}`}
                  className="block"
                >
                  <Card className="relative cursor-pointer overflow-hidden transition-colors hover:bg-(--color-muted)/40">
                    <div className="flex flex-wrap items-center gap-4 px-5 py-4">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-base font-medium">
                            {patientDisplayName(p)}
                          </span>
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_TONE[e.status]}`}
                          >
                            {STATUS_LABEL[e.status]}
                          </span>
                          {e.isTelehealth ? (
                            <span className="inline-flex items-center gap-1 text-xs text-(--color-muted-foreground)">
                              <Video
                                className="h-3.5 w-3.5"
                                aria-hidden="true"
                              />
                              Telehealth
                            </span>
                          ) : null}
                        </div>
                        <p className="flex items-center gap-3 text-xs text-(--color-muted-foreground)">
                          <span>{label}</span>
                          {e.location ? <span>· {e.location}</span> : null}
                          <span className="flex items-center gap-1">
                            <Calendar
                              className="h-3.5 w-3.5"
                              aria-hidden="true"
                            />
                            {formatTimestamp(pickAnchorTimestamp(e))}
                          </span>
                        </p>
                      </div>
                      <ChevronRight
                        className="h-4 w-4 text-(--color-muted-foreground)"
                        aria-hidden="true"
                      />
                    </div>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
