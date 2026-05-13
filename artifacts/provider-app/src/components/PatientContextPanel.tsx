import { useState } from "react";
import { AlertTriangle, ChevronDown, ChevronUp, Loader2, Pill, Stethoscope } from "lucide-react";
import {
  ApiError,
  getGetPatientHistoryQueryKey,
  useGetPatientHistory,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface PatientContextPanelProps {
  ehrPatientId: string;
}

// Compact, read-only summary of the patient's active problems,
// medications, and allergies pulled from the EHR. Sits next to the
// note editor so the provider has the chart in front of them while
// dictating. Collapsible on mobile so it doesn't crowd the textarea.
export function PatientContextPanel({ ehrPatientId }: PatientContextPanelProps) {
  const [open, setOpen] = useState(true);
  const query = useGetPatientHistory(ehrPatientId, {
    query: {
      queryKey: getGetPatientHistoryQueryKey(ehrPatientId),
      // Stale-while-revalidate: history doesn't change every second,
      // and a half-minute cache is plenty for a typical visit.
      staleTime: 30 * 1000,
    },
  });

  if (query.isPending) {
    return (
      <Card className="p-4">
        <div className="flex items-center gap-2 text-sm text-(--color-muted-foreground)">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading patient context…
        </div>
      </Card>
    );
  }

  if (query.isError) {
    const unavailable =
      query.error instanceof ApiError && query.error.status >= 500;
    return (
      <Card className="border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        {unavailable
          ? "EHR is unavailable right now — chart context isn't loaded."
          : "Couldn't load patient context."}
      </Card>
    );
  }

  const { problems, medications, allergies } = query.data;
  const empty =
    problems.length === 0 && medications.length === 0 && allergies.length === 0;

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-(--color-muted)"
        aria-expanded={open}
        aria-controls="patient-context-body"
      >
        <span className="text-sm font-medium">Patient context</span>
        <span className="flex items-center gap-2 text-xs text-(--color-muted-foreground)">
          {problems.length + medications.length + allergies.length} items
          {open ? (
            <ChevronUp className="h-4 w-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4" aria-hidden="true" />
          )}
        </span>
      </button>
      {open ? (
        <div
          id="patient-context-body"
          className="space-y-4 border-t border-(--color-border) px-4 py-4"
        >
          {empty ? (
            <p className="text-sm text-(--color-muted-foreground)">
              No active problems, medications, or allergies on file.
            </p>
          ) : (
            <>
              {allergies.length > 0 ? (
                <Section
                  title="Allergies"
                  icon={<AlertTriangle className="h-4 w-4 text-red-700" aria-hidden="true" />}
                  count={allergies.length}
                >
                  <ul className="space-y-1.5 text-sm">
                    {allergies.map((a) => (
                      <li key={a.id} className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium text-(--color-foreground)">
                          {a.text}
                        </span>
                        {a.reactions.length > 0 ? (
                          <span className="text-(--color-muted-foreground)">
                            ({a.reactions.join(", ")})
                          </span>
                        ) : null}
                        {a.severity ? (
                          <span className="inline-flex rounded-full bg-red-50 px-1.5 py-0.5 text-xs font-medium text-red-800 ring-1 ring-inset ring-red-200">
                            {a.severity}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              {problems.length > 0 ? (
                <Section
                  title="Active problems"
                  icon={<Stethoscope className="h-4 w-4" aria-hidden="true" />}
                  count={problems.length}
                >
                  <ul className="space-y-1 text-sm">
                    {problems.map((p) => (
                      <li key={p.id}>{p.text}</li>
                    ))}
                  </ul>
                </Section>
              ) : null}

              {medications.length > 0 ? (
                <Section
                  title="Active medications"
                  icon={<Pill className="h-4 w-4" aria-hidden="true" />}
                  count={medications.length}
                >
                  <ul className="space-y-1 text-sm">
                    {medications.map((m) => (
                      <li key={m.id}>
                        {m.text}
                        {m.dosage ? (
                          <span className="text-(--color-muted-foreground)">
                            {" — "}
                            {m.dosage}
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}
            </>
          )}
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void query.refetch()}
              disabled={query.isFetching}
            >
              {query.isFetching ? "Refreshing…" : "Refresh"}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function Section({
  title,
  icon,
  count,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-(--color-muted-foreground)">
        {icon}
        {title}
        <span className="rounded-full bg-(--color-muted) px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal text-(--color-foreground)">
          {count}
        </span>
      </h3>
      {children}
    </section>
  );
}
