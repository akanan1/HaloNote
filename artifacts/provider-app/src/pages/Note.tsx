import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  ArrowLeft,
  ClipboardCopy,
  Download,
  FilePlus2,
  Loader2,
  Pencil,
  Printer,
  Send,
  Share2,
  Trash2,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getGetNoteQueryKey,
  getListNotesQueryKey,
  useDeleteNote,
  useGetEhrConnectionStatus,
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
import {
  buildPdfFilename,
  copyAvailability,
  copyTextToClipboard,
  formatAssessmentAndPlanForCopy,
  formatFullForCopy,
  formatPatientInstructionsForCopy,
  formatSoapForCopy,
  parseNoteSections,
  type NoteExportMeta,
} from "@/lib/note-export";

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
  const [, navigate] = useLocation();
  const patientsQuery = useListPatients();
  const noteQuery = useGetNote(noteId);
  const sendNote = useSendNoteToEhr();
  const updateNote = useUpdateNote();
  const deleteNote = useDeleteNote();
  // Drives the "Use Copy, Print, or PDF export…" hint when the clinic
  // doesn't have a live EHR connection.
  const ehrStatusQuery = useGetEhrConnectionStatus();
  const ehrConnected = Boolean(
    ehrStatusQuery.data?.athenahealth?.connected ?? false,
  );

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

  async function handleDelete() {
    if (!note) return;
    if (
      !window.confirm(
        "Mark this note as entered-in-error?\n\nThe note will be hidden from active workflows but kept on file for audit (clinical data is never hard-deleted).",
      )
    ) {
      return;
    }
    try {
      await deleteNote.mutateAsync({ id: note.id });
      invalidateAllNoteQueries();
      toast.success("Note marked entered-in-error");
      navigate(`/patients/${patientId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete note");
    }
  }

  const withdrawn = note?.status === "entered-in-error";

  return (
    <div className="space-y-8">
      <div className="print:hidden">
        <Link
          href={`/patients/${patientId}`}
          className="inline-flex items-center gap-1.5 text-sm text-(--color-muted-foreground) hover:text-(--color-foreground)"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to patient
        </Link>
      </div>

      {noteQuery.isPending ? (
        <p role="status" className="text-(--color-muted-foreground)">
          Loading note…
        </p>
      ) : noteQuery.isError || !note ? (
        <p role="alert" className="text-(--color-destructive)">
          Couldn't load note.{" "}
          {noteQuery.error instanceof Error ? noteQuery.error.message : ""}
        </p>
      ) : (
        <>
          <header className="flex flex-wrap items-start justify-between gap-4 print:hidden">
            <div className="space-y-1">
              <div className="flex items-center gap-3">
                <h1 className="text-3xl font-semibold tracking-tight">Note</h1>
                {withdrawn ? (
                  <StatusPill tone="failed">Entered in error</StatusPill>
                ) : null}
              </div>
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
              {note.replacesNoteId ? (
                <p className="text-xs text-(--color-muted-foreground)">
                  Amends{" "}
                  <Link
                    href={`/patients/${patientId}/notes/${note.replacesNoteId}`}
                    className="font-mono underline-offset-2 hover:underline"
                  >
                    {note.replacesNoteId}
                  </Link>
                </p>
              ) : null}
            </div>
            {!editing && !withdrawn ? (
              <div className="flex flex-wrap items-center gap-2 print:hidden">
                <ExportMenu
                  note={note}
                  patientName={
                    patient ? `${patient.lastName}, ${patient.firstName}` : undefined
                  }
                  providerName={note.author?.displayName ?? undefined}
                />
                <Link
                  href={`/patients/${patientId}/notes/new?replaces=${note.id}`}
                >
                  <Button variant="outline" aria-label="Amend">
                    <FilePlus2 className="h-4 w-4" aria-hidden="true" />
                    <span className="hidden sm:inline">Amend</span>
                  </Button>
                </Link>
                <Button
                  variant="outline"
                  onClick={() => setEditing(true)}
                  aria-label="Edit"
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                  <span className="hidden sm:inline">Edit</span>
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void handleDelete()}
                  disabled={deleteNote.isPending}
                  aria-label="Delete"
                  className="text-(--color-destructive)"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                  <span className="hidden sm:inline">Delete</span>
                </Button>
              </div>
            ) : null}
          </header>

          {note.author ? (
            <p className="text-sm text-(--color-muted-foreground) print:hidden">
              By{" "}
              <span className="font-medium text-(--color-foreground)">
                {note.author.displayName}
              </span>
            </p>
          ) : null}

          {/* Print-only header block. Hidden on screen; appears at the
              top of the printed page or PDF. Deliberately omits DOB —
              the screen header doesn't show DOB, and the spec is
              explicit that the PDF must not include fields that
              aren't already visible. */}
          {!editing ? (
            <div className="hidden print:block print-header">
              <h1>Clinical Note</h1>
              <dl>
                {patient ? (
                  <>
                    <dt>Patient</dt>
                    <dd>
                      {patient.lastName}, {patient.firstName}
                    </dd>
                  </>
                ) : null}
                <dt>Date</dt>
                <dd>{formatFullTimestamp(note.createdAt)}</dd>
                {note.author ? (
                  <>
                    <dt>Provider</dt>
                    <dd>{note.author.displayName}</dd>
                  </>
                ) : null}
                {wasEdited(note) ? (
                  <>
                    <dt>Edited</dt>
                    <dd>{formatFullTimestamp(note.updatedAt)}</dd>
                  </>
                ) : null}
              </dl>
            </div>
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
              {/* Sticky action bar — mirrors NewNote so Save/Cancel stay
                  reachable on a long note with the mobile keyboard open.
                  Mobile offset clears the AppLayout tab bar
                  (min-h-[3.5rem] + safe-area-inset). The tab bar already
                  pads the iOS home indicator, so flat pb-4 on mobile and
                  fall back to the safe-area inset only at md+ where no
                  tab bar sits below. */}
              <div
                className="sticky bottom-[calc(env(safe-area-inset-bottom)+3.5rem)] md:bottom-0
                           -mx-4 flex items-center justify-end gap-3 md:-mx-6
                           border-t border-(--color-border) bg-(--color-background)/95
                           px-4 py-4 backdrop-blur md:px-6 supports-[backdrop-filter]:bg-(--color-background)/80
                           pb-4 md:pb-[max(1rem,env(safe-area-inset-bottom))] print:hidden"
              >
                <Button
                  variant="outline"
                  size="lg"
                  onClick={() => {
                    setEditing(false);
                    setEditError(null);
                  }}
                  disabled={updateNote.isPending}
                >
                  Cancel
                </Button>
                <Button
                  size="lg"
                  onClick={() => void handleSaveEdit()}
                  disabled={updateNote.isPending || !draftBody.trim()}
                >
                  {updateNote.isPending ? "Saving…" : "Save edit"}
                </Button>
              </div>
            </div>
          ) : (
            <Card
              className={cn(
                "p-7 print:border-0 print:p-0 print:shadow-none",
                withdrawn && "opacity-60",
              )}
            >
              <p className="whitespace-pre-wrap break-words text-base leading-relaxed print-note-body">
                {note.body}
              </p>
            </Card>
          )}

          {!withdrawn ? (
            <EhrSection
              note={note}
              onSend={handleSend}
              sending={sendNote.isPending}
              sendError={
                sendNote.error instanceof Error ? sendNote.error.message : null
              }
              ehrConnected={ehrConnected}
            />
          ) : null}

          <div className="hidden border-t border-(--color-border) pt-8 print:block">
            <div className="grid grid-cols-2 gap-12">
              <div>
                <div className="border-b border-black pb-1" />
                <p className="mt-1 text-xs">Provider signature</p>
              </div>
              <div>
                <div className="border-b border-black pb-1" />
                <p className="mt-1 text-xs">Date</p>
              </div>
            </div>
          </div>
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
  /** When false, the clinic isn't connected to an EHR — surface
   *  guidance toward the manual export flow. */
  ehrConnected: boolean;
}

function EhrSection({
  note,
  onSend,
  sending,
  sendError,
  ehrConnected,
}: EhrSectionProps) {
  const sent = Boolean(note.ehrPushedAt && note.ehrDocumentRef);
  const hasError = Boolean(note.ehrError);

  return (
    <section className="space-y-3 border-t border-(--color-border) pt-6 print:hidden">
      <h2 className="text-lg font-medium">EHR</h2>

      {!ehrConnected && !sent ? (
        <p
          className="rounded-md border border-(--color-border) bg-(--color-muted) px-3 py-2 text-sm text-(--color-muted-foreground)"
          role="note"
        >
          No EHR connected. Use Copy, Print, or PDF export to place this
          note into your EHR.
        </p>
      ) : null}

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
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  Sending…
                </>
              ) : (
                <>
                  <Send className="h-4 w-4" aria-hidden="true" />
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

interface ExportMenuProps {
  note: Note;
  patientName?: string | undefined;
  providerName?: string | undefined;
}

// All export entry points live inside one disclosure so the header
// doesn't grow six new buttons. Native `<details>`-style behavior via
// useState — same a11y, no new dependency.
//
// HIPAA posture:
//   - Every output formatter runs locally (clipboard or window.print).
//   - We never POST exported content anywhere.
//   - PDF generation is the browser's own print pipeline ("Save as
//     PDF" destination in the print dialog) — no PDF blob is created
//     in app code, nothing is stored.
function ExportMenu({ note, patientName, providerName }: ExportMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Close on outside click + Esc. Native disclosure-style.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (
        containerRef.current &&
        e.target instanceof Node &&
        !containerRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const parsed = useMemo(() => parseNoteSections(note.body), [note.body]);
  const avail = useMemo(() => copyAvailability(parsed), [parsed]);

  const meta: NoteExportMeta = {
    // note.createdAt is typed as Date in the generated client but in
    // practice arrives as an ISO string off the wire — handle both.
    createdAt:
      typeof note.createdAt === "string"
        ? note.createdAt
        : new Date(note.createdAt).toISOString(),
    ...(patientName ? { patientName } : {}),
    ...(providerName ? { providerName } : {}),
  };

  async function doCopy(text: string | null, label: string) {
    if (!text) {
      toast.error("Nothing to copy for that section.");
      return;
    }
    const ok = await copyTextToClipboard(text);
    if (ok) toast.success(`${label} copied`);
    else toast.error("Clipboard unavailable — try Print or PDF instead.");
    setOpen(false);
  }

  function doPrint() {
    setOpen(false);
    window.print();
  }

  // "Save as PDF" is sugar around window.print(). We temporarily set
  // document.title so the browser pre-fills a clinician-friendly
  // filename in the PDF destination of the print dialog. Restored
  // after the dialog closes (the afterprint event fires reliably on
  // every desktop browser and on iOS Safari).
  function doSaveAsPdf() {
    setOpen(false);
    const originalTitle = document.title;
    const filename = buildPdfFilename(patientName, meta.createdAt);
    // Strip the .pdf extension — most browsers append it themselves
    // when "Save as PDF" is the destination; doubling it is a common
    // bug ("…pdf.pdf").
    document.title = filename.replace(/\.pdf$/i, "");
    const restore = () => {
      document.title = originalTitle;
      window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);
    window.print();
  }

  return (
    <div ref={containerRef} className="relative">
      <Button
        variant="outline"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        aria-label="Export note"
      >
        <Share2 className="h-4 w-4" aria-hidden="true" />
        <span className="hidden sm:inline">Export</span>
      </Button>
      {open ? (
        <div
          role="menu"
          aria-label="Export note actions"
          className="absolute right-0 z-20 mt-2 w-72 overflow-hidden rounded-md border border-(--color-border) bg-(--color-card) shadow-lg"
        >
          <ExportMenuItem
            label="Copy full note"
            icon={<ClipboardCopy className="h-4 w-4" aria-hidden="true" />}
            onClick={() =>
              void doCopy(formatFullForCopy(parsed, meta), "Full note")
            }
          />
          <ExportMenuItem
            label="Copy SOAP note"
            sublabel={avail.soap ? undefined : "No SOAP sections detected"}
            disabled={!avail.soap}
            icon={<ClipboardCopy className="h-4 w-4" aria-hidden="true" />}
            onClick={() =>
              void doCopy(formatSoapForCopy(parsed, meta), "SOAP note")
            }
          />
          <ExportMenuItem
            label="Copy Assessment & Plan"
            sublabel={
              avail.assessmentAndPlan
                ? undefined
                : "No A&P section detected"
            }
            disabled={!avail.assessmentAndPlan}
            icon={<ClipboardCopy className="h-4 w-4" aria-hidden="true" />}
            onClick={() =>
              void doCopy(
                formatAssessmentAndPlanForCopy(parsed, meta),
                "Assessment & Plan",
              )
            }
          />
          <ExportMenuItem
            label="Copy patient instructions"
            sublabel={
              avail.patientInstructions
                ? undefined
                : "No patient instructions section detected"
            }
            disabled={!avail.patientInstructions}
            icon={<ClipboardCopy className="h-4 w-4" aria-hidden="true" />}
            onClick={() =>
              void doCopy(
                formatPatientInstructionsForCopy(parsed, meta),
                "Patient instructions",
              )
            }
          />
          <div className="my-1 border-t border-(--color-border)" />
          <ExportMenuItem
            label="Print"
            icon={<Printer className="h-4 w-4" aria-hidden="true" />}
            onClick={doPrint}
          />
          <ExportMenuItem
            label="Save as PDF"
            sublabel="Choose 'Save as PDF' in the print dialog"
            icon={<Download className="h-4 w-4" aria-hidden="true" />}
            onClick={doSaveAsPdf}
          />
        </div>
      ) : null}
    </div>
  );
}

interface ExportMenuItemProps {
  label: string;
  sublabel?: string | undefined;
  icon: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}

function ExportMenuItem({
  label,
  sublabel,
  icon,
  disabled,
  onClick,
}: ExportMenuItemProps) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-start gap-3 px-3 py-2 text-left text-sm hover:bg-(--color-muted) disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="mt-0.5 shrink-0 text-(--color-muted-foreground)">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        {sublabel ? (
          <span className="block text-xs text-(--color-muted-foreground)">
            {sublabel}
          </span>
        ) : null}
      </span>
    </button>
  );
}
