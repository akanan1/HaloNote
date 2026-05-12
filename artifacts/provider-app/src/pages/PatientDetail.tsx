import { Link, useLocation } from "wouter";
import { ArrowLeft, FileText, Plus } from "lucide-react";
import {
  useListNotes,
  useListPatients,
  type Note,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
          <ArrowLeft className="h-4 w-4" />
          All patients
        </Link>
      </div>

      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          {patientsQuery.isPending ? (
            <h1 className="text-3xl font-semibold tracking-tight text-(--color-muted-foreground)">
              Loading…
            </h1>
          ) : patient ? (
            <>
              <h1 className="text-3xl font-semibold tracking-tight">
                {patient.lastName}, {patient.firstName}
              </h1>
              <p className="text-(--color-muted-foreground)">
                DOB {formatDob(patient.dateOfBirth)}
                {(() => {
                  const age = calculateAge(patient.dateOfBirth);
                  return age != null ? ` · ${age} yrs` : "";
                })()}{" "}
                · MRN {patient.mrn}
              </p>
            </>
          ) : (
            <h1 className="text-3xl font-semibold tracking-tight text-(--color-destructive)">
              Patient not found
            </h1>
          )}
        </div>
        {patient ? (
          <Link href={`/patients/${patient.id}/notes/new`}>
            <Button size="lg">
              <Plus className="h-4 w-4" />
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
          <p className="text-(--color-muted-foreground)">Loading notes…</p>
        ) : notesQuery.isError ? (
          <p className="text-(--color-destructive)">
            Couldn't load notes.{" "}
            {notesQuery.error instanceof Error
              ? notesQuery.error.message
              : ""}
          </p>
        ) : notes.length === 0 ? (
          <EmptyNotes patientId={patientId} />
        ) : (
          <ul className="space-y-3">
            {notes.map((note) => (
              <li key={note.id}>
                <Link href={`/patients/${patientId}/notes/${note.id}`}>
                  <Card className="cursor-pointer p-5 transition-colors hover:bg-(--color-muted)">
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-1.5 min-w-0 flex-1">
                        <div className="text-sm text-(--color-muted-foreground)">
                          {formatTimestamp(note.createdAt)}
                        </div>
                        <p className="text-base leading-relaxed whitespace-pre-wrap break-words">
                          {bodySnippet(note.body)}
                        </p>
                      </div>
                      <EhrBadge note={note} />
                    </div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function EmptyNotes({ patientId }: { patientId: string }) {
  const [, navigate] = useLocation();
  return (
    <Card className="flex flex-col items-center justify-center gap-3 p-10 text-center">
      <FileText className="h-8 w-8 text-(--color-muted-foreground)" />
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
