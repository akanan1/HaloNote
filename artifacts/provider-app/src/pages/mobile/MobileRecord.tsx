// Mobile record screen — the second (and currently last) screen in the
// mobile PWA flow. Schedule → tap patient → land here.
//
// Responsibilities:
//   - Auto-fire RecordingPanel on mount (the navigating tap from
//     MobileSchedule IS the user gesture browsers want for
//     getUserMedia; wouter's nav is synchronous so the autorun lands
//     in the same task continuation while the gesture window is still
//     open).
//   - Drive the existing useRecordingToNote pipeline that does
//     upload → finalize → poll → done.
//   - When the user's autoPushMode is "after_transcription" (set by
//     POST /m/initialize), the server materializes + pushes the note
//     inline; useRecordingToNote surfaces `noteId` in its "done" state
//     once the server-side path finishes.
//   - Server-side auto-fire ALSO runs the orders chain (suggest +
//     non-med auto-approve+push). The mobile UI doesn't need to do
//     anything for orders — it just shows what happened.
//   - Auto-navigate back to /m after the success state lingers briefly.
//
// What this page deliberately doesn't have: editable textarea, save
// drafts, template picker, smart phrases, vitals extractor, summary
// generator. All of that lives on desktop. Mobile is the record button.

import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import {
  ArrowLeft,
  CheckCircle2,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";
import {
  RecordingPanel,
  type AudioSegment,
} from "@/components/RecordingPanel";
import { useRecordingToNote } from "@/lib/use-recording-to-note";
import { Button } from "@/components/ui/button";

interface Props {
  patientId: string;
}

// How long the "✓ Pushed to chart" success screen stays before
// auto-navigating back to /m. Two seconds is enough for the doctor
// to read the confirmation without being parked on a terminal screen.
const SUCCESS_LINGER_MS = 2000;

export function MobileRecordPage({ patientId }: Props) {
  const [, navigate] = useLocation();
  const [audioSegments, setAudioSegments] = useState<AudioSegment[]>([]);
  const [activeStream, setActiveStream] = useState<MediaStream | null>(null);
  const recording = useRecordingToNote({ patientId, segments: audioSegments });

  // Patient display name is passed in via ?name= so we don't have to
  // round-trip a /api/patients lookup just to populate the header
  // (there's no useGetPatient single-patient hook today; useListPatients
  // would over-fetch). MobileSchedule has the display name in hand
  // before navigating and writes it to the URL.
  const patientName =
    new URLSearchParams(window.location.search).get("name") ?? "Recording";

  // Auto-generate as soon as the recording stream ends + we have at
  // least one segment. Same trigger pattern as desktop NewNote (which
  // we don't reuse here — that page is much denser, with template
  // pickers, autosave, vitals extractors, etc. Mobile only does the
  // happy path: record → done.)
  useEffect(() => {
    if (audioSegments.length === 0) return;
    if (activeStream) return;
    if (recording.state.phase !== "idle") return;
    void recording.generate();
  }, [audioSegments, activeStream, recording]);

  // On done: toast + auto-navigate back to schedule.
  useEffect(() => {
    if (recording.state.phase !== "done") return;
    const t = window.setTimeout(() => {
      navigate("/m");
    }, SUCCESS_LINGER_MS);
    return () => window.clearTimeout(t);
  }, [recording.state, navigate]);

  const phase = recording.state.phase;
  const isCapturing = activeStream !== null || phase === "idle";
  const isProcessing =
    phase === "uploading" || phase === "finalizing" || phase === "processing";
  const isDone = phase === "done";
  const isFailed = phase === "failed";

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col bg-(--color-background) text-(--color-foreground)">
      {/* Top bar — back arrow + patient name. Safe-area-aware so the
          iOS notch composes cleanly with the back button. */}
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-(--color-border) bg-(--color-background)/95 px-3 pb-3 pt-[max(env(safe-area-inset-top),0.75rem)] backdrop-blur">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => navigate("/m")}
          disabled={isProcessing}
          aria-label="Back to schedule"
        >
          <ArrowLeft className="h-5 w-5" aria-hidden="true" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-medium">{patientName}</div>
          <div className="text-xs text-(--color-muted-foreground)">
            {phaseCopy(phase)}
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 py-4">
        {/* Recording UI shows during capture (idle/recording with a
            live stream). Hidden once the pipeline takes over so the
            doctor sees a clean status screen, not a stale waveform. */}
        {isCapturing ? (
          <RecordingPanel
            autoStart
            onStreamChange={setActiveStream}
            onSegmentsChange={setAudioSegments}
          />
        ) : isProcessing ? (
          <ProcessingState state={recording.state} />
        ) : isDone ? (
          <DoneState />
        ) : isFailed ? (
          <FailedState
            message={
              recording.state.phase === "failed"
                ? recording.state.message
                : "Recording failed"
            }
            onRetry={() => {
              recording.reset();
              setAudioSegments([]);
            }}
          />
        ) : null}
      </main>

      {/* Bottom hint — reminds the doctor what happens after stop.
          Hidden during processing/done so we're not noisy at the
          payoff moment. */}
      {isCapturing ? (
        <footer className="border-t border-(--color-border) bg-(--color-muted)/30 px-4 pb-[max(env(safe-area-inset-bottom),1rem)] pt-3 text-xs text-(--color-muted-foreground)">
          <p>
            When you tap stop, the note auto-pushes to the chart.
            Non-medication orders push too. Medications stay queued for
            your desktop review.
          </p>
        </footer>
      ) : null}
    </div>
  );
}

function phaseCopy(phase: string): string {
  switch (phase) {
    case "idle":
      return "Recording";
    case "uploading":
      return "Uploading audio…";
    case "finalizing":
      return "Finalizing recording…";
    case "processing":
      return "Drafting your note…";
    case "done":
      return "Done";
    case "failed":
      return "Recording failed";
    default:
      return "";
  }
}

function ProcessingState({
  state,
}: {
  state: ReturnType<typeof useRecordingToNote>["state"];
}) {
  const subline =
    state.phase === "uploading"
      ? `Uploading audio (${state.done} of ${state.total})…`
      : state.phase === "finalizing"
        ? "Finalizing recording…"
        : state.phase === "processing"
          ? processingSubline(state.status)
          : "Working…";
  return (
    <div className="mt-12 flex flex-col items-center gap-4 px-6 text-center">
      <Loader2
        className="h-10 w-10 animate-spin text-(--color-primary)"
        aria-hidden="true"
      />
      <p className="text-base font-medium">{subline}</p>
      <p className="text-sm text-(--color-muted-foreground)">
        Hang tight — pushing to the chart when this finishes.
      </p>
    </div>
  );
}

function processingSubline(status: string): string {
  switch (status) {
    case "queued":
      return "Queued for transcription…";
    case "transcribing":
      return "Transcribing audio…";
    case "structuring":
      return "Structuring the note…";
    default:
      return "Working…";
  }
}

function DoneState() {
  return (
    <div className="mt-12 flex flex-col items-center gap-4 px-6 text-center">
      <CheckCircle2
        className="h-12 w-12 text-emerald-600"
        aria-hidden="true"
      />
      <p className="text-lg font-medium">Pushed to chart</p>
      <p className="text-sm text-(--color-muted-foreground)">
        Returning to your schedule.
      </p>
    </div>
  );
}

function FailedState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  // Don't auto-bounce on failure — the doctor needs to decide whether
  // to re-record or give up. Toast surfaces the reason too in case
  // they swipe away from this screen.
  useEffect(() => {
    toast.error(message);
  }, [message]);
  return (
    <div className="mt-12 flex flex-col items-center gap-4 px-6 text-center">
      <TriangleAlert
        className="h-10 w-10 text-(--color-destructive)"
        aria-hidden="true"
      />
      <p className="text-base font-medium">Recording didn't make it</p>
      <p className="text-sm text-(--color-muted-foreground)">{message}</p>
      <Button size="lg" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
