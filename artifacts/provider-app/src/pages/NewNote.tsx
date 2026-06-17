import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  ArrowLeft,
  Check,
  Cloud,
  CloudOff,
  Loader2,
  Send,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListNotesQueryKey,
  getListTemplatesQueryKey,
  getNote,
  useListPatients,
  useListTemplates,
  useSendNoteToEhr,
  type Note,
  type NoteTemplate,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PatientContextPanel } from "@/components/PatientContextPanel";
import {
  RecordingPanel,
  type AudioSegment,
} from "@/components/RecordingPanel";
import {
  useRecordingToNote,
  type RecordingProcessingState,
} from "@/lib/use-recording-to-note";
import {
  useNoteAutosave,
  type AutosaveStatus,
} from "@/lib/use-note-autosave";
import { useSmartPhraseAutocomplete } from "@/lib/use-smart-phrase-autocomplete";
import { SmartPhraseDropdown } from "@/components/SmartPhraseDropdown";
import { useAuth } from "@/lib/auth";

interface NewNotePageProps {
  patientId: string;
}

type SendState =
  | { phase: "idle" }
  | { phase: "saving" }
  | { phase: "sending"; noteId: string }
  | { phase: "sent"; noteId: string; mock: boolean; provider: string }
  | { phase: "error"; message: string };

function getReplacesQueryParam(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const id = new URLSearchParams(window.location.search).get("replaces");
  return id?.trim() || undefined;
}

function getEhrIdQueryParam(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const id = new URLSearchParams(window.location.search).get("ehrId");
  return id?.trim() || undefined;
}

// When the page is opened from EncounterReview's "Record" CTA (or any
// other encounter-rooted nav), the encounter id rides on the URL so the
// autosaved draft can link itself to that encounter. The server verifies
// patient + tenant; we just pass it through.
function getEncounterIdQueryParam(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const id = new URLSearchParams(window.location.search).get("encounterId");
  return id?.trim() || undefined;
}

// True when the page was opened from a "Start note" tap on the Today
// schedule. The schedule row navigates here with `?autostart=1` so the
// RecordingPanel kicks off `getUserMedia` immediately — the provider
// taps once on Today instead of taps-Start-note + lands-here +
// taps-mic. Falls back to manual start if the mic isn't pre-granted
// (browsers require a user gesture for the first permission prompt).
function getAutoStartQueryParam(): boolean {
  if (typeof window === "undefined") return false;
  const v = new URLSearchParams(window.location.search).get("autostart");
  return v === "1" || v === "true";
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function NewNotePage({ patientId }: NewNotePageProps) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const patientsQuery = useListPatients();
  const sendNote = useSendNoteToEhr();
  const templatesQuery = useListTemplates({
    query: { queryKey: getListTemplatesQueryKey() },
  });
  const templates = useMemo<NoteTemplate[]>(
    () => templatesQuery.data?.data ?? [],
    [templatesQuery.data],
  );

  // Snapshot the ?replaces= id on mount so subsequent URL changes don't
  // jump the page out of amend mode.
  const replacesNoteId = useMemo(() => getReplacesQueryParam(), []);
  // EHR patient id forwarded from the Today page — when present we can
  // fetch the chart-context panel (active problems / meds / allergies).
  const ehrPatientId = useMemo(() => getEhrIdQueryParam(), []);
  // ?autostart=1 from the Today "Start note" tap → kick the mic on mount.
  const autoStartRecording = useMemo(() => getAutoStartQueryParam(), []);
  // ?encounterId=enc_… — links the resulting draft to a specific encounter
  // so the EncounterReview page surfaces it without any extra wiring.
  const encounterId = useMemo(() => getEncounterIdQueryParam(), []);

  // When amending, fetch the predecessor via the bare client (not the
  // generated hook — its option types require a queryKey that we'd have
  // to fabricate just to satisfy the type checker). A manual useEffect
  // keeps the fetch conditional on amend mode and runs at most once.
  const [predecessor, setPredecessor] = useState<Note | null>(null);
  useEffect(() => {
    if (!replacesNoteId) return;
    let cancelled = false;
    getNote(replacesNoteId)
      .then((n) => {
        if (!cancelled) setPredecessor(n);
      })
      .catch(() => {
        // Soft-fail: amend banner is best-effort. Form still posts with
        // replacesNoteId so the server enforces the chain.
      });
    return () => {
      cancelled = true;
    };
  }, [replacesNoteId]);

  const [body, setBody] = useState("");
  const [bodyPrefilled, setBodyPrefilled] = useState(false);
  const [silenceStopped, setSilenceStopped] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const silenceAutoStopMs =
    user?.silenceAutoStopSec && user.silenceAutoStopSec > 0
      ? user.silenceAutoStopSec * 1000
      : undefined;
  const [sendState, setSendState] = useState<SendState>({ phase: "idle" });
  const [templateId, setTemplateId] = useState<string>("");
  // Audio segments captured by the ambient-recording panel above the
  // note body. `useRecordingToNote` runs the upload → finalize → poll
  // pipeline when the provider taps "Generate note".
  const [audioSegments, setAudioSegments] = useState<AudioSegment[]>([]);
  const recording = useRecordingToNote({ patientId, segments: audioSegments });

  const isBusyState =
    sendState.phase === "saving" || sendState.phase === "sending";

  const smartPhrases = useSmartPhraseAutocomplete({
    textareaRef,
    value: body,
    setValue: setBody,
    enabled: !sendState || sendState.phase !== "sent",
  });

  // Debounced autosave. Disabled while a manual save / send is in flight
  // so the explicit button click is what actually persists.
  const autosave = useNoteAutosave({
    body,
    patientId,
    replacesNoteId,
    encounterId,
    enabled: !isBusyState && sendState.phase !== "sent",
  });

  // Prefill the body once the predecessor loads. Don't overwrite manual
  // edits — only seed if the textarea is still empty.
  useEffect(() => {
    if (!predecessor || bodyPrefilled) return;
    setBody(predecessor.body);
    setBodyPrefilled(true);
  }, [predecessor, bodyPrefilled]);

  // When the recording pipeline lands, drop the structured body into
  // the textarea — but only if the textarea is empty. A provider who's
  // already typed something keeps their work; they can manually paste
  // from the recorded transcript instead.
  useEffect(() => {
    if (recording.state.phase !== "done") return;
    const generated = recording.state.structuredBody;
    setBody((current) => (current.trim() === "" ? generated : current));
  }, [recording.state]);

  // Apply a template's skeleton to the textarea. Only fires when the
  // body is empty — refuses to overwrite a note in progress.
  const applyTemplate = useCallback(
    (template: NoteTemplate | null) => {
      setTemplateId(template?.id ?? "");
      if (!template) return;
      setBody((current) => (current.trim() === "" ? template.body : current));
    },
    [],
  );

  const patient = patientsQuery.data?.data.find((p) => p.id === patientId);

  function invalidateNotes() {
    void queryClient.invalidateQueries({
      queryKey: getListNotesQueryKey({ patientId }),
    });
    void queryClient.invalidateQueries({
      queryKey: getListNotesQueryKey(),
    });
  }

  async function handleSaveDraft() {
    if (!body.trim()) return;
    try {
      await autosave.flush();
      invalidateNotes();
    } catch (err) {
      setSendState({
        phase: "error",
        message: err instanceof Error ? err.message : "Save failed.",
      });
    }
  }

  async function handleSaveAndSend() {
    if (!body.trim() || !patient) return;
    setSendState({ phase: "saving" });
    try {
      const noteId = await autosave.flush();
      if (!noteId) {
        setSendState({
          phase: "error",
          message: "Save failed.",
        });
        return;
      }
      setSendState({ phase: "sending", noteId });

      const outcome = await sendNote.mutateAsync({ id: noteId });
      setSendState({
        phase: "sent",
        noteId,
        mock: outcome.mock,
        provider: outcome.provider,
      });
      invalidateNotes();

      // Short hold so the provider sees the success state before navigating away.
      setTimeout(() => navigate(`/patients/${patientId}`), 1100);
    } catch (err) {
      invalidateNotes();
      setSendState({
        phase: "error",
        message: err instanceof Error ? err.message : "Send failed.",
      });
    }
  }

  const isBusy = isBusyState;
  const amending = Boolean(replacesNoteId);

  return (
    <div className="space-y-8">
      <div>
        <Link
          href={`/patients/${patientId}`}
          className="inline-flex items-center gap-1.5 text-sm text-(--color-muted-foreground) hover:text-(--color-foreground)"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to patient
        </Link>
      </div>

      <header className="space-y-3">
        <h1 className="text-3xl font-semibold tracking-tight">
          {amending ? "Amend note" : "New note"}
        </h1>
        {patientsQuery.isPending ? (
          <p className="text-(--color-muted-foreground)">Loading patient…</p>
        ) : patient ? (
          <Card className="relative overflow-hidden px-5 py-4">
            <span
              aria-hidden="true"
              className="absolute inset-y-0 left-0 w-1 bg-(--color-primary)"
            />
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 pl-2">
              <span className="text-lg font-semibold leading-tight">
                {patient.lastName}, {patient.firstName}
              </span>
              <span className="text-sm text-(--color-muted-foreground) tabular-nums">
                MRN {patient.mrn}
              </span>
            </div>
          </Card>
        ) : (
          <p className="text-(--color-destructive)">
            Patient not found ({patientId}).
          </p>
        )}
      </header>

      <RecordingPanel
        disabled={isBusy}
        autoStart={autoStartRecording}
        {...(silenceAutoStopMs ? { silenceAutoStopMs } : {})}
        onAutoStop={() => setSilenceStopped(true)}
        onSegmentsChange={setAudioSegments}
      />

      {silenceStopped && user?.silenceAutoStopSec ? (
        <p
          role="status"
          className="text-sm text-(--color-muted-foreground)"
        >
          Stopped automatically after {user.silenceAutoStopSec}s of
          silence.
        </p>
      ) : null}

      <RecordingPipelineStatus
        state={recording.state}
        segmentCount={audioSegments.length}
        onGenerate={() => void recording.generate()}
        onReset={recording.reset}
        disabled={isBusy}
      />

      {ehrPatientId ? (
        <PatientContextPanel ehrPatientId={ehrPatientId} />
      ) : null}

      {amending ? (
        <Card className="border-amber-300 bg-amber-50 p-5 text-sm text-amber-900">
          <p>
            Amending the note{" "}
            {predecessor ? (
              <>
                from{" "}
                <span className="font-medium">
                  {formatDate(predecessor.createdAt)}
                </span>
              </>
            ) : (
              <span className="font-mono text-xs">{replacesNoteId}</span>
            )}
            . The original stays on file unchanged; this note will be linked
            via <code className="font-mono">relatesTo: replaces</code> when
            sent to the EHR.
          </p>
        </Card>
      ) : null}

      <Card className="space-y-4 p-5">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-(--color-border) pb-3">
          <Label htmlFor="note-body" className="text-base font-semibold">
            Note
          </Label>
          <AutosaveIndicator
            status={autosave.status}
            lastSavedAt={autosave.lastSavedAt}
            error={autosave.error}
          />
        </div>

        {/* Native <select> here on purpose: the OS picker on phones is
            faster and more accessible than a custom dropdown. */}
        <select
          value={templateId}
          onChange={(e) => {
            const next = templates.find((t) => t.id === e.target.value) ?? null;
            applyTemplate(next);
          }}
          disabled={isBusy || templatesQuery.isPending}
          aria-label="Note template"
          className="h-11 min-w-[10rem] rounded-md border border-(--color-border) bg-(--color-card) px-3 text-base sm:h-9 sm:text-sm"
        >
          <option value="">
            {templatesQuery.isPending ? "Loading…" : "Template…"}
          </option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>

        <div className="relative">
          <Textarea
            id="note-body"
            ref={textareaRef}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={smartPhrases.onKeyDown}
            placeholder="Type or pick a template above. Type .shortcut for smart phrases. Use the recorder for the visit conversation."
            rows={16}
            className="min-h-[55vh] border-0 bg-transparent px-0 py-2 text-base leading-relaxed shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
            autoFocus
            disabled={isBusy}
          />
          <SmartPhraseDropdown
            open={smartPhrases.open}
            suggestions={smartPhrases.suggestions}
            activeIndex={smartPhrases.activeIndex}
            onPick={smartPhrases.pick}
            onHover={smartPhrases.setActiveIndex}
          />
        </div>

      </Card>

      <SendStatus state={sendState} draftSavedId={autosave.draftId} />

      {/* Sticky bottom action bar — primary actions stay reachable when
          the mobile soft keyboard is open. On mobile the bottom offset
          clears the AppLayout tab bar (min-h-[3.5rem] + safe-area-inset
          + 1px border ≈ calc(3.5rem + safe-area-inset)) so Save+Send
          aren't hidden behind it. The tab bar already pads for the iOS
          home indicator, so we just use a flat pb-4 on mobile and only
          fall back to the safe-area inset on desktop (where no tab bar
          sits below us). */}
      <div
        className="sticky bottom-[calc(env(safe-area-inset-bottom)+3.5rem)] md:bottom-0
                   -mx-4 flex items-center gap-3 md:-mx-6 md:justify-end
                   border-t border-(--color-border) bg-(--color-background)/95
                   px-4 py-4 backdrop-blur md:px-6 supports-[backdrop-filter]:bg-(--color-background)/80
                   pb-4 md:pb-[max(1rem,env(safe-area-inset-bottom))] print:hidden"
      >
        {/* On mobile (default): Save draft is compact + secondary; the
            primary Save & send fills the remaining width. On md+: both
            buttons return to their natural size, right-aligned. */}
        <Button
          variant="outline"
          size="lg"
          onClick={handleSaveDraft}
          disabled={isBusy || !body.trim()}
          className="shrink-0"
        >
          <span className="md:hidden" aria-label="Save draft">Draft</span>
          <span className="hidden md:inline">Save draft</span>
        </Button>
        <Button
          size="lg"
          onClick={handleSaveAndSend}
          disabled={isBusy || !body.trim() || !patient}
          className="flex-1 md:flex-none"
        >
          {sendState.phase === "saving" || sendState.phase === "sending" ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {sendState.phase === "saving" ? "Saving…" : "Sending…"}
            </>
          ) : (
            <>
              <Send className="h-4 w-4" aria-hidden="true" />
              <span className="md:hidden">Send to EHR</span>
              <span className="hidden md:inline">Save &amp; send to EHR</span>
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function AutosaveIndicator({
  status,
  lastSavedAt,
  error,
}: {
  status: AutosaveStatus;
  lastSavedAt: string | null;
  error: string | null;
}) {
  if (status === "saving") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-(--color-muted-foreground)">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        Saving…
      </span>
    );
  }
  if (status === "saved" && lastSavedAt) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-(--color-muted-foreground)">
        <Cloud className="h-3.5 w-3.5" aria-hidden="true" />
        Saved {formatRelative(lastSavedAt)}
      </span>
    );
  }
  if (status === "dirty") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-(--color-muted-foreground)">
        Unsaved changes
      </span>
    );
  }
  if (status === "error") {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs text-(--color-destructive)"
        title={error ?? undefined}
      >
        <CloudOff className="h-3.5 w-3.5" aria-hidden="true" />
        Couldn't autosave
      </span>
    );
  }
  return null;
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "just now";
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function SendStatus({
  state,
  draftSavedId,
}: {
  state: SendState;
  draftSavedId: string | null;
}) {
  if (state.phase === "error") {
    return (
      <p role="alert" className="text-sm text-(--color-destructive)">
        {state.message}
      </p>
    );
  }
  if (state.phase === "sent") {
    return (
      <p
        role="status"
        className="inline-flex items-center gap-1.5 text-sm text-(--color-foreground)"
      >
        <Check className="h-4 w-4" aria-hidden="true" />
        Sent to EHR ({state.provider}
        {state.mock ? " — mock" : ""}).
      </p>
    );
  }
  if (state.phase === "idle" && draftSavedId) {
    return (
      <p
        role="status"
        className="inline-flex items-center gap-1.5 text-sm text-(--color-foreground)"
      >
        <Check className="h-4 w-4" aria-hidden="true" />
        Draft saved.
      </p>
    );
  }
  return null;
}

function processingStatusCopy(status: string): string {
  switch (status) {
    case "queued":
      return "Queued for processing…";
    case "transcribing":
      return "Transcribing the conversation…";
    case "structuring":
      return "Structuring the clinical note…";
    default:
      return "Processing…";
  }
}

function RecordingPipelineStatus({
  state,
  segmentCount,
  onGenerate,
  onReset,
  disabled,
}: {
  state: RecordingProcessingState;
  segmentCount: number;
  onGenerate: () => void;
  onReset: () => void;
  disabled: boolean;
}) {
  if (state.phase === "idle" && segmentCount === 0) return null;

  if (state.phase === "idle") {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-5">
        <div className="text-sm">
          <span className="font-medium">{segmentCount}</span>{" "}
          {segmentCount === 1 ? "segment" : "segments"} ready
          <span className="text-(--color-muted-foreground)">
            {" "}
            · tap to turn into a draft note
          </span>
        </div>
        <Button
          size="lg"
          onClick={onGenerate}
          disabled={disabled}
          aria-label="Generate note from recording"
        >
          <Sparkles className="h-5 w-5" aria-hidden="true" />
          Generate note
        </Button>
      </Card>
    );
  }

  if (state.phase === "uploading") {
    const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : 0;
    return (
      <Card className="space-y-2 px-4 py-3 md:px-5">
        <div className="flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Uploading segment {Math.min(state.done + 1, state.total)} of{" "}
          {state.total}…
        </div>
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-(--color-muted)"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full bg-(--color-primary) transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        </div>
      </Card>
    );
  }

  if (state.phase === "finalizing" || state.phase === "processing") {
    const label =
      state.phase === "finalizing"
        ? "Finalizing recording…"
        : processingStatusCopy(state.status);
    return (
      <Card className="flex items-center gap-2 px-4 py-3 text-sm md:px-5">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        {label}
      </Card>
    );
  }

  if (state.phase === "done") {
    return (
      <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-5">
        <div className="inline-flex items-center gap-2 text-sm">
          <Check className="h-4 w-4 text-emerald-600" aria-hidden="true" />
          Draft note generated below — review and edit before sending.
        </div>
        <Button variant="ghost" size="sm" onClick={onReset} disabled={disabled}>
          Discard recording
        </Button>
      </Card>
    );
  }

  // phase === "failed"
  return (
    <Card className="space-y-2 px-4 py-3 md:px-5">
      <div className="inline-flex items-center gap-2 text-sm text-(--color-destructive)">
        <XCircle className="h-4 w-4" aria-hidden="true" />
        Couldn't generate the note.
      </div>
      <p className="text-sm text-(--color-muted-foreground)">{state.message}</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={onGenerate} disabled={disabled}>
          Try again
        </Button>
        <Button variant="ghost" size="sm" onClick={onReset} disabled={disabled}>
          Discard
        </Button>
      </div>
    </Card>
  );
}
