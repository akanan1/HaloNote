import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  ArrowLeft,
  Check,
  Cloud,
  CloudOff,
  Loader2,
  Mic,
  MicOff,
  Pause,
  Play,
  Send,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListNotesQueryKey,
  getNote,
  useListPatients,
  useSendNoteToEhr,
  type Note,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PatientContextPanel } from "@/components/PatientContextPanel";
import {
  useNoteAutosave,
  type AutosaveStatus,
} from "@/lib/use-note-autosave";
import {
  NOTE_TEMPLATES,
  detectTemplateFromVoice,
  stripCueFromTranscript,
  type NoteTemplate,
} from "@/lib/note-templates";
import { useSpeechRecognition } from "@/lib/use-speech-recognition";

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
  const patientsQuery = useListPatients();
  const sendNote = useSendNoteToEhr();

  // Snapshot the ?replaces= id on mount so subsequent URL changes don't
  // jump the page out of amend mode.
  const replacesNoteId = useMemo(() => getReplacesQueryParam(), []);
  // EHR patient id forwarded from the Today page — when present we can
  // fetch the chart-context panel (active problems / meds / allergies).
  const ehrPatientId = useMemo(() => getEhrIdQueryParam(), []);

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
  const [sendState, setSendState] = useState<SendState>({ phase: "idle" });
  const [templateId, setTemplateId] = useState<string>("");
  const [interimSpeech, setInterimSpeech] = useState("");
  // Track whether the *next* finalized dictation chunk should be
  // inspected for a template cue. Reset to true whenever the user
  // restarts dictation against an empty / freshly-templated body.
  const cueCheckRef = useRef(true);
  const speech = useSpeechRecognition();

  const isBusyState =
    sendState.phase === "saving" || sendState.phase === "sending";

  // Debounced autosave. Disabled while a manual save / send is in flight
  // so the explicit button click is what actually persists.
  const autosave = useNoteAutosave({
    body,
    patientId,
    replacesNoteId,
    enabled: !isBusyState && sendState.phase !== "sent",
  });

  // Prefill the body once the predecessor loads. Don't overwrite manual
  // edits — only seed if the textarea is still empty.
  useEffect(() => {
    if (!predecessor || bodyPrefilled) return;
    setBody(predecessor.body);
    setBodyPrefilled(true);
  }, [predecessor, bodyPrefilled]);

  // Apply a template's skeleton to the textarea. Only fires when the
  // body is empty — refuses to overwrite a note in progress.
  const applyTemplate = useCallback(
    (template: NoteTemplate | null) => {
      setTemplateId(template?.id ?? "");
      if (!template) return;
      setBody((current) => (current.trim() === "" ? template.body : current));
      cueCheckRef.current = true;
    },
    [],
  );

  // Voice dictation handler. First finalized chunk gets cue-checked
  // for a template ("soap note", "history and physical", etc.).
  // Subsequent chunks are appended verbatim.
  const handleFinalSpeech = useCallback(
    (text: string) => {
      let chunk = text;
      if (cueCheckRef.current) {
        cueCheckRef.current = false;
        const detected = detectTemplateFromVoice(chunk);
        if (detected) {
          chunk = stripCueFromTranscript(chunk, detected);
          setTemplateId(detected.id);
          // Drop the template skeleton in only if the textarea is
          // empty — protects pre-typed content.
          setBody((current) =>
            current.trim() === "" ? detected.body + chunk : current + chunk,
          );
          setInterimSpeech("");
          return;
        }
      }
      setBody((current) => {
        const sep = current.length === 0 || /\s$/.test(current) ? "" : " ";
        return current + sep + chunk;
      });
      setInterimSpeech("");
    },
    [],
  );

  function toggleDictation() {
    if (speech.active) {
      speech.stop();
      setInterimSpeech("");
      return;
    }
    cueCheckRef.current = body.trim() === "" && !templateId;
    speech.start(handleFinalSpeech, (interim) => setInterimSpeech(interim));
  }

  function togglePause() {
    if (speech.paused) {
      speech.resume();
      return;
    }
    if (speech.listening) {
      speech.pause();
      setInterimSpeech("");
    }
  }

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

      <header className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">
          {amending ? "Amend note" : "New note"}
        </h1>
        {patientsQuery.isPending ? (
          <p className="text-(--color-muted-foreground)">Loading patient…</p>
        ) : patient ? (
          <p className="text-(--color-muted-foreground)">
            For{" "}
            <span className="font-medium text-(--color-foreground)">
              {patient.lastName}, {patient.firstName}
            </span>{" "}
            · MRN {patient.mrn}
          </p>
        ) : (
          <p className="text-(--color-destructive)">
            Patient not found ({patientId}).
          </p>
        )}
      </header>

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

      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <Label htmlFor="note-body" className="text-base">
            Note
          </Label>
          <AutosaveIndicator
            status={autosave.status}
            lastSavedAt={autosave.lastSavedAt}
            error={autosave.error}
          />
        </div>

        {/* Template selector + dictation button — sit above the textarea
            so a provider can decide structure before typing. Native
            <select> here on purpose: the OS picker on phones is faster
            and more accessible than a custom dropdown. */}
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={templateId}
            onChange={(e) => {
              const next = NOTE_TEMPLATES.find((t) => t.id === e.target.value) ?? null;
              applyTemplate(next);
            }}
            disabled={isBusy}
            aria-label="Note template"
            className="h-11 min-w-[10rem] rounded-md border border-(--color-border) bg-(--color-card) px-3 text-sm sm:h-9"
          >
            <option value="">Template…</option>
            {NOTE_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>

          {speech.supported ? (
            <Button
              type="button"
              variant={speech.active ? "default" : "outline"}
              size="sm"
              onClick={toggleDictation}
              disabled={isBusy}
              aria-pressed={speech.active}
              aria-label={speech.active ? "Stop dictation" : "Start dictation"}
            >
              {speech.active ? (
                <>
                  <MicOff className="h-4 w-4" aria-hidden="true" />
                  Stop
                </>
              ) : (
                <>
                  <Mic className="h-4 w-4" aria-hidden="true" />
                  Dictate
                </>
              )}
            </Button>
          ) : null}

          {speech.supported && speech.active ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={togglePause}
              disabled={isBusy}
              aria-pressed={speech.paused}
              aria-label={speech.paused ? "Resume dictation" : "Pause dictation"}
            >
              {speech.paused ? (
                <>
                  <Play className="h-4 w-4" aria-hidden="true" />
                  Resume
                </>
              ) : (
                <>
                  <Pause className="h-4 w-4" aria-hidden="true" />
                  Pause
                </>
              )}
            </Button>
          ) : null}

          {speech.supported ? (
            <span className="text-xs text-(--color-muted-foreground)">
              Experimental — uses browser speech API (not HIPAA-grade).
            </span>
          ) : null}
        </div>

        <Textarea
          id="note-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Type, dictate, or pick a template above."
          rows={16}
          className="min-h-[50vh] text-base"
          autoFocus
          disabled={isBusy}
        />

        {speech.listening && interimSpeech ? (
          <p
            role="status"
            aria-live="polite"
            className="text-sm italic text-(--color-muted-foreground)"
          >
            …{interimSpeech}
          </p>
        ) : null}

        {speech.error && speech.error !== "no-speech" ? (
          <p role="alert" className="text-sm text-(--color-destructive)">
            {speech.error === "not-allowed"
              ? "Microphone permission denied. Enable it in your browser settings."
              : speech.error === "unsupported"
                ? "Your browser doesn't support dictation."
                : `Dictation error: ${speech.error}`}
          </p>
        ) : null}
      </div>

      <SendStatus state={sendState} draftSavedId={autosave.draftId} />

      {/* Sticky bottom action bar — primary actions stay reachable when
          the mobile soft keyboard is open. On desktop the page typically
          isn't long enough to overflow, so it just sits at the natural
          end. pb-[env(safe-area-inset-bottom)] respects iOS home-bar inset. */}
      <div
        className="sticky bottom-0 -mx-6 flex items-center justify-end gap-3
                   border-t border-(--color-border) bg-(--color-background)/95
                   px-6 py-4 backdrop-blur supports-[backdrop-filter]:bg-(--color-background)/80
                   pb-[max(1rem,env(safe-area-inset-bottom))] print:hidden"
      >
        <Button
          variant="outline"
          size="lg"
          onClick={handleSaveDraft}
          disabled={isBusy || !body.trim()}
        >
          Save draft
        </Button>
        <Button
          size="lg"
          onClick={handleSaveAndSend}
          disabled={isBusy || !body.trim() || !patient}
        >
          {sendState.phase === "saving" || sendState.phase === "sending" ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {sendState.phase === "saving" ? "Saving…" : "Sending…"}
            </>
          ) : (
            <>
              <Send className="h-4 w-4" aria-hidden="true" />
              Save &amp; send to EHR
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
