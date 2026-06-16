import { Link, useLocation } from "wouter";
import { ArrowLeft, FileText, Plus } from "lucide-react";
import {
  useListNotes,
  useListPatients,
  type Note,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Fab } from "@/components/Fab";
import { cn } from "@/lib/utils";

interface PatientDetailPageProps {
  patientId: string;
}

function formatDob(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function calculateAge(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function bodySnippet(body: string, max = 180): string {
  const oneLine = body.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function PatientDetailPage({ patientId }: PatientDetailPageProps) {
  const patientsQuery = useListPatients();
  const notesQuery = useListNotes({ patientId });

  const patient = patientsQuery.data?.data.find((p) => p.id === patientId);
  const notes = notesQuery.data?.data ?? [];

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-(--color-muted-foreground) hover:text-(--color-foreground)"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          All patients
        </Link>
      </div>

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-3">
          {patientsQuery.isPending ? (
            <Card className="relative overflow-hidden px-5 py-4">
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 w-1 bg-(--color-border)"
              />
              <div className="space-y-2 pl-2">
                <div className="h-6 w-2/3 animate-pulse rounded bg-(--color-muted)" />
                <div className="h-3 w-1/2 animate-pulse rounded bg-(--color-muted)" />
              </div>
            </Card>
          ) : patient ? (
            <Card className="relative overflow-hidden px-5 py-4">
              <span
                aria-hidden="true"
                className="absolute inset-y-0 left-0 w-1 bg-(--color-primary)"
              />
              <div className="space-y-1 pl-2">
                <h1 className="truncate text-2xl font-semibold leading-tight tracking-tight">
                  {patient.lastName}, {patient.firstName}
                </h1>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm text-(--color-muted-foreground)">
                  {(() => {
                    const age = calculateAge(patient.dateOfBirth);
                    return age != null ? (
                      <span>
                        <span className="font-medium text-(--color-foreground)">
                          {age}
                        </span>{" "}
                        yrs
                      </span>
                    ) : null;
                  })()}
                  <span className="tabular-nums">
                    DOB {formatDob(patient.dateOfBirth)}
                  </span>
                  <span className="font-mono text-xs tabular-nums">
                    {patient.mrn}
                  </span>
                </div>
              </div>
            </Card>
          ) : (
            <h1 className="text-3xl font-semibold tracking-tight text-(--color-destructive)">
              Patient not found
            </h1>
          )}
        </div>
        {patient ? (
          // Desktop "New note" — hidden on mobile in favor of the FAB.
          <Link
            href={`/patients/${patient.id}/notes/new`}
            className="hidden md:inline-block"
          >
            <Button size="lg">
              <Plus className="h-4 w-4" aria-hidden="true" />
              New note
            </Button>
          </Link>
        ) : null}
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-medium text-(--color-foreground)">
          Recent notes
        </h2>

        {notesQuery.isPending ? (
          <ul
            className="space-y-3"
            role="status"
            aria-label="Loading notes"
          >
            {[0, 1, 2].map((i) => (
              <li key={i}>
                <Card className="relative overflow-hidden p-5">
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 left-0 w-1 bg-(--color-border)"
                  />
                  <div className="space-y-2">
                    <div className="h-3 w-1/3 animate-pulse rounded bg-(--color-muted)" />
                    <div className="h-4 w-full animate-pulse rounded bg-(--color-muted)" />
                    <div className="h-4 w-4/5 animate-pulse rounded bg-(--color-muted)" />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        ) : notesQuery.isError ? (
          <p role="alert" className="text-(--color-destructive)">
            Couldn't load notes.{" "}
            {notesQuery.error instanceof Error
              ? notesQuery.error.message
              : ""}
          </p>
        ) : notes.length === 0 ? (
          <EmptyNotes patientId={patientId} />
        ) : (
          <ul className="space-y-3 pb-24 md:pb-0" aria-label="Recent notes">
            {notes.map((note) => {
              const withdrawn = note.status === "entered-in-error";
              const status = withdrawn ? "withdrawn" : ehrStatus(note);
              const railClass = NOTE_RAIL[status];
              return (
                <li key={note.id}>
                  <Link href={`/patients/${patientId}/notes/${note.id}`}>
                    <Card
                      className={cn(
                        "relative cursor-pointer overflow-hidden p-5 transition-colors hover:bg-(--color-muted)",
                        withdrawn && "opacity-60",
                      )}
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          "absolute inset-y-0 left-0 w-1",
                          railClass,
                        )}
                      />
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1.5 min-w-0 flex-1">
                          <div className="text-sm text-(--color-muted-foreground)">
                            {formatTimestamp(note.createdAt)}
                            {note.replacesNoteId ? (
                              <span className="ml-2 text-xs">· amends prior</span>
                            ) : null}
                          </div>
                          <p
                            className={cn(
                              "text-base leading-relaxed whitespace-pre-wrap break-words",
                              withdrawn && "line-through",
                            )}
                          >
                            {bodySnippet(note.body)}
                          </p>
                        </div>
                        {withdrawn ? (
                          <span className="shrink-0 rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-800 ring-1 ring-inset ring-red-200">
                            Entered in error
                          </span>
                        ) : (
                          <EhrBadge note={note} />
                        )}
                      </div>
                    </Card>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {patient ? (
        <Fab
          href={`/patients/${patient.id}/notes/new`}
          icon={Plus}
          label="New note"
        />
      ) : null}
    </div>
  );
}

function EmptyNotes({ patientId }: { patientId: string }) {
  const [, navigate] = useLocation();
  return (
    <Card className="flex flex-col items-center justify-center gap-3 p-10 text-center">
      <FileText
        className="h-8 w-8 text-(--color-muted-foreground)"
        aria-hidden="true"
      />
      <p className="text-(--color-muted-foreground)">No notes for this patient yet.</p>
      <Button
        variant="outline"
        onClick={() => navigate(`/patients/${patientId}/notes/new`)}
      >
        Write the first one
      </Button>
    </Card>
  );
}

type EhrStatus = "sent" | "failed" | "draft";

function ehrStatus(note: Note): EhrStatus {
  if (note.ehrPushedAt && note.ehrDocumentRef) return "sent";
  if (note.ehrError) return "failed";
  return "draft";
}

// Left accent rail per note status — mirrors the Today page's
// AppointmentCard rails so the visual grammar stays consistent across
// the app.
const NOTE_RAIL: Record<EhrStatus | "withdrawn", string> = {
  sent: "bg-emerald-500",
  failed: "bg-red-500",
  draft: "bg-(--color-border)",
  withdrawn: "bg-(--color-border)",
};

function EhrBadge({ note }: { note: Note }) {
  const status = ehrStatus(note);

  const styles: Record<EhrStatus, string> = {
    sent: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    failed: "bg-red-50 text-red-800 ring-red-200",
    draft: "bg-(--color-muted) text-(--color-muted-foreground) ring-(--color-border)",
  };

  const labels: Record<EhrStatus, string> = {
    sent: note.ehrProvider
      ? note.ehrProvider === "mock"
        ? "Sent · mock"
        : `Sent · ${note.ehrProvider}`
      : "Sent",
    failed: "Send failed",
    draft: "Draft",
  };

  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        styles[status],
      )}
      title={status === "failed" ? note.ehrError ?? undefined : undefined}
    >
      {labels[status]}
    </span>
  );
}
