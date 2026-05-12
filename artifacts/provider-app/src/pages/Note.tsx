import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, Loader2, Pencil, Send } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getGetNoteQueryKey,
  getListNotesQueryKey,
  useGetNote,
  useListPatients,
  useSendNoteToEhr,
  useUpdateNote,
  type Note,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
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
  const updateNote = useUpdateNote();

  const patient = patientsQuery.data?.data.find((p) => p.id === patientId);
  const note = noteQuery.data;

  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  // Seed the draft buffer when entering edit mode.
  useEffect(() => {
    if (editing && note) setDraftBody(note.body);
  }, [editing, note]);

  function invalidateAllNoteQueries() {
    if (!note) return;
    void queryClient.invalidateQueries({ queryKey: getGetNoteQueryKey(note.id) });
    void queryClient.invalidateQueries({
      queryKey: getListNotesQueryKey({ patientId }),
    });
    void queryClient.invalidateQueries({ queryKey: getListNotesQueryKey() });
  }

  async function handleSend() {
    if (!note) return;
    try {
      const outcome = await sendNote.mutateAsync({ id: note.id });
      toast.success(
        outcome.mock ? "Sent to EHR (mock)" : `Sent to ${outcome.provider}`,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "EHR send failed",
      );
    }
    invalidateAllNoteQueries();
  }

  async function handleSaveEdit() {
    if (!note) return;
    if (!draftBody.trim()) {
      setEditError("Note body can't be empty.");
      return;
    }
    setEditError(null);
    try {
      await updateNote.mutateAsync({ id: note.id, data: { body: draftBody } });
      invalidateAllNoteQueries();
      setEditing(false);
      toast.success("Note updated");
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Couldn't save edit.");
    }
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
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
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
              {wasEdited(note) ? (
                <p className="text-xs text-(--color-muted-foreground)">
                  Edited {formatFullTimestamp(note.updatedAt)}
                </p>
              ) : null}
            </div>
            {!editing ? (
              <Button variant="outline" onClick={() => setEditing(true)}>
                <Pencil className="h-4 w-4" />
                Edit
              </Button>
            ) : null}
          </header>

          {note.author ? (
            <p className="text-sm text-(--color-muted-foreground)">
              By{" "}
              <span className="font-medium text-(--color-foreground)">
                {note.author.displayName}
              </span>
            </p>
          ) : null}

          {editing ? (
            <div className="space-y-3">
              <Textarea
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                rows={16}
                className="min-h-[50vh] text-base"
                disabled={updateNote.isPending}
                autoFocus
              />
              {editError ? (
                <p className="text-sm text-(--color-destructive)">{editError}</p>
              ) : null}
              <div className="flex justify-end gap-3">
                <Button
                  variant="outline"
                  onClick={() => {
                    setEditing(false);
                    setEditError(null);
                  }}
                  disabled={updateNote.isPending}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => void handleSaveEdit()}
                  disabled={updateNote.isPending || !draftBody.trim()}
                >
                  {updateNote.isPending ? "Saving…" : "Save edit"}
                </Button>
              </div>
            </div>
          ) : (
            <Card className="p-7">
              <p className="whitespace-pre-wrap break-words text-base leading-relaxed">
                {note.body}
              </p>
            </Card>
          )}

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

// updatedAt equals createdAt on a freshly-created note. Compare millis
// rather than strings — the server normalizes to ISO 8601 so the strings
// match exactly when unmodified, but be defensive about clock skew.
function wasEdited(note: Note): boolean {
  const created = new Date(note.createdAt).getTime();
  const updated = new Date(note.updatedAt).getTime();
  return Number.isFinite(created) && Number.isFinite(updated)
    ? updated - created > 1000
    : false;
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
