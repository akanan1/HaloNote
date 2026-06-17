import { useCallback, useEffect, useRef, useState } from "react";
import {
  createRecording,
  finalizeRecording,
  getRecording,
  customFetch,
  type RecordingJob,
  type RecordingSegment,
} from "@workspace/api-client-react";
import type { AudioSegment } from "@/components/RecordingPanel";

// Lifecycle of the SPA-side flow that turns a list of captured
// AudioSegments into a structured note body via the backend pipeline:
//
//   idle → uploading(N of M) → finalizing → processing(<status>) → done
//
// `processing` mirrors the job's server-side status ("queued" |
// "transcribing" | "structuring") so the UI can show the right copy.
// Terminal states freeze the hook; call `reset()` to go back to idle.
export type RecordingProcessingState =
  | { phase: "idle" }
  | { phase: "uploading"; total: number; done: number }
  | { phase: "finalizing" }
  | { phase: "processing"; status: RecordingJob["status"] }
  | {
      phase: "done";
      structuredBody: string;
      transcript: string | null;
      /**
       * Set when the recording pipeline materialized + auto-pushed the
       * note server-side (autoPushMode === "after_transcription"). The
       * UI uses this to navigate the provider straight to the (already-
       * pushed) note instead of dropping the structured body into the
       * NewNote textarea.
       */
      noteId: string | null;
    }
  | { phase: "failed"; message: string };

interface UseRecordingToNoteArgs {
  patientId: string;
  segments: AudioSegment[];
}

const POLL_INTERVAL_MS = 1200;
// Job is "in flight" while it's anywhere up to done/failed/cancelled.
const ACTIVE_STATUSES = new Set<RecordingJob["status"]>([
  "queued",
  "transcribing",
  "structuring",
]);

async function uploadSegment(
  jobId: string,
  segment: AudioSegment,
): Promise<RecordingSegment> {
  return customFetch<RecordingSegment>(`/api/recordings/${jobId}/segments`, {
    method: "POST",
    headers: {
      // Use the segment's recorded MIME so the server sees the same
      // type the browser produced — picks the right file extension on
      // disk and stays compatible with the eventual transcription step.
      "Content-Type": segment.mimeType || "audio/webm",
      "X-Recording-Duration-Ms": String(Math.max(0, Math.round(segment.durationMs))),
    },
    body: segment.blob,
  });
}

export function useRecordingToNote({
  patientId,
  segments,
}: UseRecordingToNoteArgs) {
  const [state, setState] = useState<RecordingProcessingState>({
    phase: "idle",
  });
  // Snapshot of the segments at the moment `generate()` was called.
  // We freeze it so additional segments captured mid-flight don't
  // change the upload count and confuse progress display.
  const inFlightSegmentsRef = useRef<AudioSegment[]>([]);
  const cancelledRef = useRef(false);
  const pollTimerRef = useRef<number | null>(null);

  const reset = useCallback(() => {
    cancelledRef.current = true;
    if (pollTimerRef.current != null) {
      window.clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    inFlightSegmentsRef.current = [];
    setState({ phase: "idle" });
    cancelledRef.current = false;
  }, []);

  // Clean up the poll timer if the host unmounts mid-poll. We don't
  // cancel the job server-side — the worker can finish on its own; we
  // just stop listening.
  useEffect(
    () => () => {
      if (pollTimerRef.current != null) {
        window.clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    },
    [],
  );

  const pollUntilTerminal = useCallback(async (jobId: string) => {
    const tick = async () => {
      if (cancelledRef.current) return;
      try {
        const job = await getRecording(jobId);
        if (cancelledRef.current) return;
        if (job.status === "done") {
          setState({
            phase: "done",
            structuredBody: job.structuredBody ?? "",
            transcript: job.transcript ?? null,
            noteId: job.noteId ?? null,
          });
          return;
        }
        if (job.status === "failed" || job.status === "cancelled") {
          setState({
            phase: "failed",
            message:
              job.errorMessage ??
              (job.status === "cancelled"
                ? "Recording was cancelled."
                : "Couldn't process the recording."),
          });
          return;
        }
        if (ACTIVE_STATUSES.has(job.status)) {
          setState({ phase: "processing", status: job.status });
        }
        pollTimerRef.current = window.setTimeout(
          () => void tick(),
          POLL_INTERVAL_MS,
        );
      } catch (err) {
        setState({
          phase: "failed",
          message: err instanceof Error ? err.message : "Status poll failed.",
        });
      }
    };
    await tick();
  }, []);

  const generate = useCallback(async () => {
    if (segments.length === 0) return;
    cancelledRef.current = false;
    const snapshot = segments.slice();
    inFlightSegmentsRef.current = snapshot;

    setState({ phase: "uploading", total: snapshot.length, done: 0 });

    let job: RecordingJob;
    try {
      job = await createRecording({ patientId });
    } catch (err) {
      setState({
        phase: "failed",
        message:
          err instanceof Error ? err.message : "Couldn't create recording.",
      });
      return;
    }

    // Upload segments serially. Mobile networks (and the cloudflared
    // tunnel in dev) handle one-at-a-time uploads more reliably than a
    // parallel storm, and the progress counter stays meaningful.
    for (let i = 0; i < snapshot.length; i++) {
      if (cancelledRef.current) return;
      const segment = snapshot[i];
      if (!segment) continue;
      try {
        await uploadSegment(job.id, segment);
      } catch (err) {
        setState({
          phase: "failed",
          message:
            err instanceof Error
              ? `Upload failed: ${err.message}`
              : "Upload failed.",
        });
        return;
      }
      setState({ phase: "uploading", total: snapshot.length, done: i + 1 });
    }

    if (cancelledRef.current) return;
    setState({ phase: "finalizing" });

    try {
      await finalizeRecording(job.id);
    } catch (err) {
      setState({
        phase: "failed",
        message:
          err instanceof Error
            ? `Couldn't finalize: ${err.message}`
            : "Couldn't finalize the recording.",
      });
      return;
    }

    setState({ phase: "processing", status: "queued" });
    void pollUntilTerminal(job.id);
  }, [patientId, segments, pollUntilTerminal]);

  return { state, generate, reset };
}
