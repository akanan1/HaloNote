import { Link } from "wouter";
import { ArrowLeft, Loader2, Send } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetNoteQueryKey,
  getListNotesQueryKey,
  useGetNote,
  useListPatients,
  useSendNoteToEhr,
  type Note,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface NotePageProps {
  patientId: string;
  noteId: string;
}

function formatFullTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function NotePage({ patientId, noteId }: NotePageProps) {
  const queryClient = useQueryClient();
  const patientsQuery = useListPatients();
  const noteQuery = useGetNote(noteId);
  const sendNote = useSendNoteToEhr();

  const patient = patientsQuery.data?.data.find((p) => p.id === patientId);
  const note = noteQuery.data;

  async function handleSend() {
    if (!note) return;
    try {
      await sendNote.mutateAsync({ id: note.id });
    } catch {
      // error surfaces via mutation state below
    }
    void queryClient.invalidateQueries({ queryKey: getGetNoteQueryKey(note.id) });
    void queryClient.invalidateQueries({
      queryKey: getListNotesQueryKey({ patientId }),
    });
    void queryClient.invalidateQueries({ queryKey: getListNotesQueryKey() });
  }

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`/patients/${patientId}`}
          className="inline-flex items-center gap-1.5 text-sm text-(--color-muted-foreground) hover:text-(--color-foreground)"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to patient
        </Link>
      </div>

      {noteQuery.isPending ? (
        <p className="text-(--color-muted-foreground)">Loading note…</p>
      ) : noteQuery.isError || !note ? (
        <p className="text-(--color-destructive)">
          Couldn't load note.{" "}
          {noteQuery.error instanceof Error ? noteQuery.error.message : ""}
        </p>
      ) : (
        <>
          <header className="space-y-1">
            <h1 className="text-3xl font-semibold tracking-tight">Note</h1>
            {patient ? (
              <p className="text-(--color-muted-foreground)">
                For{" "}
                <span className="font-medium text-(--color-foreground)">
                  {patient.lastName}, {patient.firstName}
                </span>{" "}
                · {formatFullTimestamp(note.createdAt)}
              </p>
            ) : (
              <p className="text-(--color-muted-foreground)">
                {formatFullTimestamp(note.createdAt)}
              </p>
            )}
          </header>

          {note.author ? (
            <p className="text-sm text-(--color-muted-foreground)">
              By{" "}
              <span className="font-medium text-(--color-foreground)">
                {note.author.displayName}
              </span>
            </p>
          ) : null}

          <Card className="p-7">
            <p className="whitespace-pre-wrap break-words text-base leading-relaxed">
              {note.body}
            </p>
          </Card>

          <EhrSection
            note={note}
            onSend={handleSend}
            sending={sendNote.isPending}
            sendError={
              sendNote.error instanceof Error ? sendNote.error.message : null
            }
          />
        </>
      )}
    </div>
  );
}

interface EhrSectionProps {
  note: Note;
  onSend: () => void;
  sending: boolean;
  sendError: string | null;
}

function EhrSection({ note, onSend, sending, sendError }: EhrSectionProps) {
  const sent = Boolean(note.ehrPushedAt && note.ehrDocumentRef);
  const hasError = Boolean(note.ehrError);

  return (
    <section className="space-y-3 border-t border-(--color-border) pt-6">
      <h2 className="text-lg font-medium">EHR</h2>

      {sent ? (
        <div className="space-y-2">
          <StatusPill tone="sent">
            Sent{note.ehrProvider ? ` · ${note.ehrProvider}` : ""}
          </StatusPill>
          <p className="text-sm text-(--color-muted-foreground)">
            {note.ehrPushedAt ? formatFullTimestamp(note.ehrPushedAt) : ""}
          </p>
          {note.ehrDocumentRef ? (
            <p className="text-sm font-mono break-all text-(--color-muted-foreground)">
              {note.ehrDocumentRef}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="space-y-3">
          <StatusPill tone={hasError ? "failed" : "draft"}>
            {hasError ? "Send failed" : "Not sent yet"}
          </StatusPill>
          {hasError && note.ehrError ? (
            <p className="text-sm text-(--color-destructive) whitespace-pre-wrap break-words">
              {note.ehrError}
            </p>
          ) : null}
          {sendError && !hasError ? (
            <p className="text-sm text-(--color-destructive)">{sendError}</p>
          ) : null}
          <div>
            <Button onClick={onSend} disabled={sending} size="lg">
              {sending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Sending…
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" />
                  {hasError ? "Retry send to EHR" : "Send to EHR"}
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

type Tone = "sent" | "failed" | "draft";

function StatusPill({
  tone,
  children,
}: {
  tone: Tone;
  children: React.ReactNode;
}) {
  const styles: Record<Tone, string> = {
    sent: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    failed: "bg-red-50 text-red-800 ring-red-200",
    draft:
      "bg-(--color-muted) text-(--color-muted-foreground) ring-(--color-border)",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        styles[tone],
      )}
    >
      {children}
    </span>
  );
}
