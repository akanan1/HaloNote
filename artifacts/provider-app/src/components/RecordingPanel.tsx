import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Pause, Play, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  appendSegment as bufferAppendSegment,
  clear as bufferClear,
  listSegments as bufferListSegments,
} from "@/lib/recording-buffer";

export interface AudioSegment {
  id: string;
  blob: Blob;
  mimeType: string;
  durationMs: number;
  recordedAt: number;
}

interface RecordingPanelProps {
  disabled?: boolean;
  /**
   * If true, attempt to begin recording immediately on mount. Set by the
   * Today schedule's "Start note" tap so the provider doesn't have to
   * tap the mic again on arrival. Browsers gate `getUserMedia` on a
   * user gesture for the first permission prompt — if the mic isn't
   * pre-granted the call will throw `NotAllowedError` and we fall back
   * to the manual button. We only fire the auto-start once per mount.
   */
  autoStart?: boolean;
  /**
   * When set, the recorder auto-stops after this many milliseconds of
   * continuous silence (audio RMS below `silenceLevelThreshold`).
   * Approximates "doctor walked out of the room" without needing a
   * streaming transcript. Off when undefined or <=0. The countdown
   * resets the instant audio rises above the threshold again, so a
   * brief pause mid-conversation doesn't end the visit.
   */
  silenceAutoStopMs?: number;
  /**
   * Normalized 0..1 RMS level under which the mic counts as silent.
   * Default 0.02 works for typical room noise floors; bump for noisy
   * environments. Compared against the same averaged-byte-frequency
   * `level` value that drives the EKG strip — no extra analysis pass.
   */
  silenceLevelThreshold?: number;
  /**
   * Fired exactly once when an auto-stop is triggered by silence. The
   * recorder still calls its usual onstop path; this is purely a
   * notification so the parent can surface "Stopped automatically
   * after N seconds of silence" copy. Reset on the next start.
   */
  onAutoStop?: () => void;
  /**
   * Hands the active MediaStream to the parent so a streaming-
   * transcript pipeline can tap PCM from it in parallel with the
   * existing MediaRecorder upload. Fires with `null` on stop/teardown.
   */
  onStreamChange?: (stream: MediaStream | null) => void;
  /**
   * Programmatic stop signal. When this value changes to a truthy
   * key, the recorder calls its usual stop path. Lets a parent end
   * the visit on a verbal end-cue from the streaming transcript
   * without needing a ref into the panel. The actual value isn't
   * inspected — just the change.
   */
  externalStopSignal?: number;
  onSegmentsChange?: (segments: AudioSegment[]) => void;
  /**
   * Enable IndexedDB-backed recovery of in-progress audio. When BOTH
   * `userId` and `encounterId` are provided, every recorded segment is
   * persisted to the browser's IndexedDB buffer before it's exposed to
   * the parent — so a tab close, iOS Safari background, or accidental
   * navigation mid-encounter doesn't destroy the visit. On mount the
   * component checks the buffer for that `${userId}:${encounterId}`
   * pair; if it finds unsent segments it surfaces them via the Resume
   * banner. Without these props the component degrades cleanly to its
   * pre-buffer behavior (in-memory state only).
   */
  userId?: string;
  encounterId?: string;
  /**
   * Called once when the parent's upload pipeline confirms the
   * segments landed on the server. Tells the buffer it's safe to
   * `clear` the row — the audio is no longer the only copy. Without
   * it, segments persist until the user logs out (clearAllForUser is
   * called from the auth tear-down). Idempotent.
   */
  onSegmentsUploaded?: () => void;
}

type RecorderState = "idle" | "recording" | "paused";

// Browser permission states for the microphone. "unknown" covers
// browsers that don't support `navigator.permissions.query({ name:
// "microphone" })` — Safari historically didn't, though it's been
// improving. Treat unknown the same as "prompt" for messaging: assume
// the user hasn't seen the OS prompt yet.
type MicPermission = "unknown" | "prompt" | "granted" | "denied";

// Pick the most compatible audio MIME type the browser exposes. Safari /
// iOS refuse webm and want mp4-AAC; Chromium prefers webm-opus. Fall back
// to the browser default (empty string passed to MediaRecorder) if none
// of the named candidates are recognized.
function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4;codecs=mp4a.40.2",
    "audio/mp4",
    "audio/aac",
  ];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function isSupported(): boolean {
  if (typeof window === "undefined") return false;
  // Touch the method via `typeof === "function"` so the compiler doesn't
  // narrow this to "always truthy" — the type defs assume getUserMedia
  // exists, but real-world insecure-context browsers omit `mediaDevices`
  // entirely (https://example only on http).
  const hasGUM =
    Boolean(navigator.mediaDevices) &&
    typeof navigator.mediaDevices.getUserMedia === "function";
  return (
    hasGUM &&
    typeof MediaRecorder !== "undefined" &&
    (typeof AudioContext !== "undefined" ||
      typeof (window as unknown as { webkitAudioContext?: unknown })
        .webkitAudioContext !== "undefined")
  );
}

function getAudioContextCtor(): typeof AudioContext | null {
  if (typeof AudioContext !== "undefined") return AudioContext;
  const w = window as unknown as { webkitAudioContext?: typeof AudioContext };
  return w.webkitAudioContext ?? null;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function RecordingPanel({
  disabled,
  autoStart,
  silenceAutoStopMs,
  silenceLevelThreshold = 0.02,
  onAutoStop,
  onStreamChange,
  externalStopSignal,
  onSegmentsChange,
  userId,
  encounterId,
  onSegmentsUploaded,
}: RecordingPanelProps) {
  // Recovery banner state. `null` = nothing to recover (or we haven't
  // checked yet); the array = unsent segments found in IndexedDB for
  // the current ${userId}:${encounterId} pair. Cleared on Resume,
  // Discard, or a successful upload. Only meaningful when both
  // userId AND encounterId are provided — otherwise the component
  // can't safely look up its own past state.
  const [recovered, setRecovered] = useState<AudioSegment[] | null>(null);
  const persistenceEnabled = Boolean(userId && encounterId);
  const [supported] = useState(isSupported);
  const [permission, setPermission] = useState<MicPermission>("unknown");
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [state, setState] = useState<RecorderState>("idle");
  const [segments, setSegments] = useState<AudioSegment[]>([]);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);

  // Query the browser-cached permission state on mount, and listen for
  // changes (the user can flip it in browser settings while the page
  // is open). The Permissions API doesn't universally support the
  // "microphone" descriptor — Safari can throw, in which case we leave
  // permission at "unknown" and let the first getUserMedia call settle
  // it. After grant, subsequent visits short-circuit to "granted" and
  // the explainer is hidden.
  useEffect(() => {
    if (!supported) return;
    const perms = navigator.permissions as
      | (Permissions & {
          query: (
            d: PermissionDescriptor,
          ) => Promise<PermissionStatus>;
        })
      | undefined;
    if (!perms || typeof perms.query !== "function") return;
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const handler = () => {
      if (!cancelled && status) {
        setPermission(status.state as MicPermission);
      }
    };
    perms
      .query({ name: "microphone" as PermissionName })
      .then((s) => {
        if (cancelled) return;
        status = s;
        setPermission(s.state as MicPermission);
        s.addEventListener("change", handler);
      })
      .catch(() => {
        // Safari pre-16 / older Firefox throw on the microphone
        // descriptor — leave as "unknown".
      });
    return () => {
      cancelled = true;
      status?.removeEventListener("change", handler);
    };
  }, [supported]);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);
  // Segment-duration accounting: `startTimeRef` is the performance.now()
  // at the most recent start/resume; `accumulatedRef` is the wall-clock
  // already spent recording in earlier resume windows.
  const startTimeRef = useRef<number>(0);
  const accumulatedRef = useRef<number>(0);

  const teardownAudioGraph = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (tickRef.current != null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {
        // disconnect throws if already disconnected — harmless.
      }
      sourceRef.current = null;
    }
    analyserRef.current = null;
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx && ctx.state !== "closed") {
      void ctx.close().catch(() => {});
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(
    () => () => {
      // Best-effort: if we unmount mid-recording, abort cleanly and drop
      // the in-progress segment. Saving it would require flushing the
      // state set after the page is gone.
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") {
        rec.onstop = null;
        try {
          rec.stop();
        } catch {
          // already stopped
        }
      }
      teardownAudioGraph();
    },
    [teardownAudioGraph],
  );

  // Notify parent whenever the segment list changes. Effect (not inline
  // callback) so React batching gets the post-state segments.
  const onSegmentsChangeRef = useRef(onSegmentsChange);
  useEffect(() => {
    onSegmentsChangeRef.current = onSegmentsChange;
  }, [onSegmentsChange]);
  useEffect(() => {
    onSegmentsChangeRef.current?.(segments);
  }, [segments]);

  // Silence tracking state. silenceStartRef is the performance.now() at
  // which the mic first dropped below the threshold in the current
  // continuous quiet stretch (null = currently above threshold or never
  // started). autoStopFiredRef is a one-shot latch so a single silent
  // stretch doesn't trigger handleStop twice if the rAF tick lands on
  // the boundary multiple times before state updates settle.
  const silenceStartRef = useRef<number | null>(null);
  const autoStopFiredRef = useRef(false);

  const startLevelLoop = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const buf = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      const cur = analyserRef.current;
      if (!cur) return;
      cur.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] ?? 0;
      const normalized = sum / buf.length / 255;
      setLevel(normalized);

      // Silence accounting. Only counts while actually recording (paused
      // shouldn't accrue silence) and only when a threshold > 0 is
      // configured. The recorder ref is the authority — `state` is one
      // tick behind because rAF runs faster than React state flushes.
      if (
        silenceAutoStopMs &&
        silenceAutoStopMs > 0 &&
        recorderRef.current?.state === "recording" &&
        !autoStopFiredRef.current
      ) {
        if (normalized < silenceLevelThreshold) {
          if (silenceStartRef.current == null) {
            silenceStartRef.current = performance.now();
          } else if (
            performance.now() - silenceStartRef.current >= silenceAutoStopMs
          ) {
            autoStopFiredRef.current = true;
            // Defer to a microtask so we don't reentrantly call
            // MediaRecorder.stop() inside the rAF callback — that
            // confuses some browsers about whether onstop has run.
            queueMicrotask(() => {
              const rec = recorderRef.current;
              if (rec && rec.state !== "inactive") {
                onAutoStop?.();
                if (rec.state === "paused") rec.resume();
                rec.stop();
              }
            });
          }
        } else {
          silenceStartRef.current = null;
        }
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [silenceAutoStopMs, silenceLevelThreshold, onAutoStop]);

  const startTicker = useCallback(() => {
    if (tickRef.current != null) return;
    tickRef.current = window.setInterval(() => {
      if (recorderRef.current?.state === "recording") {
        setElapsedMs(
          accumulatedRef.current + (performance.now() - startTimeRef.current),
        );
      }
    }, 100);
  }, []);

  const handleStart = useCallback(async () => {
    if (!supported || disabled) return;
    setPermissionError(null);
    setElapsedMs(0);
    setLevel(0);

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      // Mirror permission state into our local copy in case the
      // Permissions API didn't tell us (Safari) or hasn't fired its
      // change event yet.
      if (name === "NotAllowedError" || name === "SecurityError") {
        setPermission("denied");
      }
      setPermissionError(
        name === "NotAllowedError" || name === "SecurityError"
          ? "Microphone permission denied. Enable it in your browser settings, then try again."
          : name === "NotFoundError"
            ? "No microphone found on this device."
            : err instanceof Error
              ? err.message
              : "Couldn't access the microphone.",
      );
      return;
    }

    setPermission("granted");
    streamRef.current = stream;
    // Surface the active stream to the parent so a streaming
    // transcript hook can tap PCM from it. Cleared in onstop.
    onStreamChange?.(stream);

    const Ctx = getAudioContextCtor();
    if (Ctx) {
      const audioCtx = new Ctx();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      audioCtxRef.current = audioCtx;
      sourceRef.current = source;
      analyserRef.current = analyser;
    }

    const mimeType = pickMimeType();
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream);
    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const totalMs =
        accumulatedRef.current + (performance.now() - startTimeRef.current);
      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || mimeType || "audio/webm",
      });
      // Drop empty / stop-without-data noise (some browsers fire onstop
      // even when no audio frames were emitted).
      if (blob.size > 0) {
        const segment: AudioSegment = {
          id: `seg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          blob,
          mimeType: blob.type,
          durationMs: totalMs,
          recordedAt: Date.now(),
        };
        setSegments((s) => {
          const next = [...s, segment];
          // Persist on the same tick the state update goes out, so a
          // tab-close that lands before the next React commit still has
          // the audio safe in IndexedDB. Promise is fire-and-forget —
          // the next render won't await it, but the put resolves before
          // most teardown paths anyway.
          if (persistenceEnabled && userId && encounterId) {
            void bufferAppendSegment(
              userId,
              encounterId,
              next.length - 1,
              segment.blob,
              {
                mimeType: segment.mimeType,
                durationMs: segment.durationMs,
                recordedAt: segment.recordedAt,
              },
            ).catch(() => {
              // Silent fallback: persistence is defense-in-depth, not
              // a hard requirement. Logging the blob would leak PHI.
            });
          }
          return next;
        });
      }
      chunksRef.current = [];
      accumulatedRef.current = 0;
      setElapsedMs(0);
      setLevel(0);
      setState("idle");
      teardownAudioGraph();
      recorderRef.current = null;
      // Signal stream gone to the parent so the streaming-transcript
      // pipeline can tear its WebSocket down.
      onStreamChange?.(null);
    };

    startTimeRef.current = performance.now();
    accumulatedRef.current = 0;
    silenceStartRef.current = null;
    autoStopFiredRef.current = false;
    recorder.start(250);
    setState("recording");
    startLevelLoop();
    startTicker();
  }, [supported, disabled, teardownAudioGraph, startLevelLoop, startTicker]);

  // Auto-start once per mount when the parent (e.g. Today → "Start
  // note") asks for it. Runs after `handleStart` is defined so the
  // closure captures the latest callbacks. Guard with a ref so a parent
  // re-render that flips `autoStart` back doesn't re-trigger us.
  const autoStartFiredRef = useRef(false);
  useEffect(() => {
    if (!autoStart) return;
    if (autoStartFiredRef.current) return;
    if (!supported || disabled) return;
    if (state !== "idle") return;
    autoStartFiredRef.current = true;
    void handleStart();
  }, [autoStart, supported, disabled, state, handleStart]);

  const handlePause = useCallback(() => {
    const rec = recorderRef.current;
    if (rec?.state !== "recording") return;
    accumulatedRef.current += performance.now() - startTimeRef.current;
    rec.pause();
    setState("paused");
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setLevel(0);
  }, []);

  const handleResume = useCallback(() => {
    const rec = recorderRef.current;
    if (rec?.state !== "paused") return;
    rec.resume();
    startTimeRef.current = performance.now();
    setState("recording");
    startLevelLoop();
  }, [startLevelLoop]);

  const handleStop = useCallback(() => {
    const rec = recorderRef.current;
    if (!rec) return;
    // MediaRecorder.stop() while paused fires onstop without producing
    // a final dataavailable in some browsers. Resume first so the last
    // chunk flushes.
    if (rec.state === "paused") rec.resume();
    rec.stop();
  }, []);

  const handleDeleteSegment = useCallback((id: string) => {
    setSegments((s) => s.filter((seg) => seg.id !== id));
  }, []);

  // Lifecycle flush: when the page is being hidden (tab switch, iOS
  // home, OS sleep) or unloaded (refresh, nav, browser quit), tell the
  // recorder to flush its current buffer NOW. MediaRecorder.stop is
  // async and would race the page going away; requestData() emits the
  // pending dataavailable synchronously enough to land in IndexedDB
  // before teardown. Only attached while persistence is enabled so we
  // don't add lifecycle work to the dev-mode use case.
  useEffect(() => {
    if (!persistenceEnabled) return;
    const flush = () => {
      const rec = recorderRef.current;
      if (!rec || rec.state === "inactive") return;
      try {
        rec.requestData();
      } catch {
        // Some Safari versions throw when no data is buffered — harmless.
      }
    };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", flush);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", flush);
    };
  }, [persistenceEnabled]);

  // On mount, look up any unsent segments for this user+encounter and
  // surface them as a Resume / Discard banner. Runs once; subsequent
  // re-mounts (a route swap back into the same encounter) re-check.
  // No-op when persistence is disabled.
  useEffect(() => {
    if (!persistenceEnabled || !userId || !encounterId) return;
    let cancelled = false;
    void bufferListSegments(userId, encounterId)
      .then((buffered) => {
        if (cancelled || buffered.length === 0) return;
        const hydrated: AudioSegment[] = buffered.map((b) => ({
          id: `recovered_${b.idx}_${b.recordedAt}`,
          blob: b.blob,
          mimeType: b.mimeType,
          durationMs: b.durationMs,
          recordedAt: b.recordedAt,
        }));
        setRecovered(hydrated);
      })
      .catch(() => {
        // IndexedDB blocked / quota exceeded — fall through silently.
      });
    return () => {
      cancelled = true;
    };
  }, [persistenceEnabled, userId, encounterId]);

  // When the parent confirms upload landed, clear the buffer row.
  // useEffect-based so the parent doesn't have to await our promise.
  const lastUploadSignalRef = useRef(onSegmentsUploaded);
  useEffect(() => {
    if (!persistenceEnabled || !userId || !encounterId) return;
    if (onSegmentsUploaded === lastUploadSignalRef.current) return;
    lastUploadSignalRef.current = onSegmentsUploaded;
    if (!onSegmentsUploaded) return;
    void bufferClear(userId, encounterId).catch(() => {});
  }, [onSegmentsUploaded, persistenceEnabled, userId, encounterId]);

  const handleResumeRecovered = useCallback(() => {
    if (!recovered) return;
    setSegments((s) => [...recovered, ...s]);
    setRecovered(null);
  }, [recovered]);

  const handleDiscardRecovered = useCallback(() => {
    setRecovered(null);
    if (persistenceEnabled && userId && encounterId) {
      void bufferClear(userId, encounterId).catch(() => {});
    }
  }, [persistenceEnabled, userId, encounterId]);

  // External stop trigger (verbal end-cue from the streaming
  // transcript bridge). The host bumps a counter; we ignore the
  // initial value and stop on every subsequent change.
  const lastStopSignalRef = useRef<number | undefined>(externalStopSignal);
  useEffect(() => {
    if (externalStopSignal === lastStopSignalRef.current) return;
    lastStopSignalRef.current = externalStopSignal;
    if (externalStopSignal !== undefined) {
      handleStop();
    }
  }, [externalStopSignal, handleStop]);

  if (!supported) {
    return (
      <Card className="px-4 py-3 text-sm text-(--color-muted-foreground)">
        Voice recording isn't supported in this browser. Try the latest
        Chrome, Edge, or Safari over HTTPS.
      </Card>
    );
  }

  const recording = state === "recording";
  const paused = state === "paused";
  const active = recording || paused;
  // Cap the level-reactive scale so a loud transient doesn't make the
  // button jump out of the layout.
  const pulseScale = recording ? 1 + Math.min(level, 1) * 0.18 : 1;
  // Show the first-time-use explainer only when permission hasn't been
  // granted yet AND the user hasn't started recording. Once the browser
  // remembers the grant, this never appears again — it's only a
  // first-encounter affordance.
  const showPreGrantHint =
    !active && segments.length === 0 && permission !== "granted" && permission !== "denied";
  const denied = permission === "denied";

  if (denied) {
    return (
      <Card className="space-y-2 px-4 py-5 md:px-6">
        <div className="flex items-center gap-2 text-(--color-destructive)">
          <MicOff className="h-5 w-5" aria-hidden="true" />
          <span className="font-medium">Microphone blocked</span>
        </div>
        <p className="text-sm text-(--color-muted-foreground)">
          HaloNote needs your microphone to record visits. Re-enable
          access in your browser's site settings, then refresh.
        </p>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      {recovered && recovered.length > 0 ? (
        <div
          role="alertdialog"
          aria-label="Recovered recording"
          className="border-b border-(--color-border) bg-amber-50 px-4 py-3 text-sm text-amber-900 md:px-6"
        >
          <p className="font-medium">
            We recovered an in-progress recording from earlier on this
            device.
          </p>
          <p className="mt-1">
            {recovered.length} segment{recovered.length === 1 ? "" : "s"}
            {" "}
            (about {formatDuration(
              recovered.reduce((sum, s) => sum + s.durationMs, 0),
            )}
            ) — left over from a tab that closed before the visit was
            uploaded.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" onClick={handleResumeRecovered}>
              Resume
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleDiscardRecovered}
            >
              Discard
            </Button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-col items-center gap-4 px-4 py-6 md:px-6">
        <div className="relative grid h-24 w-24 place-items-center">
          {!active ? (
            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={disabled}
              aria-label={
                segments.length > 0
                  ? "Record another segment"
                  : "Start recording"
              }
              className={cn(
                "relative grid h-24 w-24 place-items-center rounded-full",
                "bg-(--color-primary) text-(--color-primary-foreground)",
                "shadow-lg transition-transform active:scale-95",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring) focus-visible:ring-offset-2",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              <Mic className="h-10 w-10" aria-hidden="true" />
            </button>
          ) : (
            <div
              className={cn(
                "relative grid h-24 w-24 place-items-center rounded-full",
                recording
                  ? "bg-emerald-500 text-white shadow-[0_0_24px_rgba(16,185,129,0.55)]"
                  : "bg-(--color-muted) text-(--color-foreground)",
                "shadow-lg",
              )}
              style={{
                transform: `scale(${pulseScale})`,
                transition: "transform 80ms linear",
              }}
            >
              <Mic className="h-10 w-10" aria-hidden="true" />
            </div>
          )}
        </div>

        <EkgStrip active={recording} level={level} />

        <div className="text-center">
          <div
            className={cn(
              "text-2xl font-semibold tabular-nums tracking-tight",
              recording && "text-emerald-600",
            )}
            aria-live="polite"
          >
            {formatDuration(active ? elapsedMs : 0)}
          </div>
          <div className="text-sm text-(--color-muted-foreground)">
            {recording
              ? "Recording…"
              : paused
                ? "Paused"
                : segments.length > 0
                  ? `${segments.length} segment${segments.length === 1 ? "" : "s"} captured · tap to add another`
                  : showPreGrantHint
                    ? "Tap to enable microphone & start recording"
                    : "Tap the microphone to start"}
          </div>
        </div>

        {showPreGrantHint ? (
          <p className="max-w-sm text-center text-xs text-(--color-muted-foreground)">
            Your browser will ask once for microphone access. After you
            allow it, recording starts on this and future visits without
            another prompt.
          </p>
        ) : null}

        {active ? (
          <div className="flex gap-2">
            {recording ? (
              <Button
                onClick={handlePause}
                variant="outline"
                size="lg"
                aria-label="Pause recording"
              >
                <Pause className="h-5 w-5" aria-hidden="true" />
                Pause
              </Button>
            ) : (
              <Button
                onClick={handleResume}
                variant="outline"
                size="lg"
                aria-label="Resume recording"
              >
                <Play className="h-5 w-5" aria-hidden="true" />
                Resume
              </Button>
            )}
            <Button
              onClick={handleStop}
              variant="destructive"
              size="lg"
              aria-label="Stop recording"
            >
              <Square className="h-5 w-5" aria-hidden="true" />
              Stop
            </Button>
          </div>
        ) : null}

        {permissionError ? (
          <p
            role="alert"
            className="max-w-md text-center text-sm text-(--color-destructive)"
          >
            {permissionError}
          </p>
        ) : null}
      </div>

      {segments.length > 0 ? (
        <div className="border-t border-(--color-border) bg-(--color-muted) px-4 py-3 md:px-6">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-(--color-muted-foreground)">
            Recorded segments
          </div>
          <ul className="space-y-2">
            {segments.map((seg, idx) => (
              <li
                key={seg.id}
                className="flex items-center gap-2 rounded-md border border-(--color-border) bg-(--color-card) px-3 py-2"
              >
                <div className="w-6 shrink-0 text-sm font-medium tabular-nums text-(--color-muted-foreground)">
                  #{idx + 1}
                </div>
                <SegmentPlayer segment={seg} />
                <span className="shrink-0 text-xs tabular-nums text-(--color-muted-foreground)">
                  {formatDuration(seg.durationMs)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDeleteSegment(seg.id)}
                  aria-label={`Delete segment ${idx + 1}`}
                  className="text-(--color-destructive)"
                >
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}

// ICU/EKG-monitor styled audio waveform. Dark canvas, glowing green
// line, scrolls right-to-left at 60 fps. When `active`, samples come
// from the live AnalyserNode (passed in as `level`); when inactive the
// strip flatlines but the buffer keeps shifting, so on resume the new
// activity rolls in cleanly without a jump. The visual is voice-driven
// rather than literal cardiac PQRS, but the aesthetic matches a
// clinical monitor.
function EkgStrip({ active, level }: { active: boolean; level: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const samplesRef = useRef<number[]>([]);
  const levelRef = useRef(level);
  const activeRef = useRef(active);

  useEffect(() => {
    levelRef.current = level;
  }, [level]);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof window === "undefined") return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = window.devicePixelRatio || 1;

    function resize() {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const tick = () => {
      // Always shift the buffer so the trace scrolls even when paused;
      // a fully-zero stretch reads as "mic muted" which is what we want.
      const newSample = activeRef.current ? levelRef.current : 0;
      const samples = samplesRef.current;
      samples.push(newSample);
      // Keep ~2px per sample so density looks right at common widths.
      const targetSamples = Math.max(80, Math.floor(width / 2));
      while (samples.length > targetSamples) samples.shift();

      if (width === 0 || height === 0) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }

      const c = ctx;
      if (!c) return;
      c.clearRect(0, 0, width, height);

      // Background grid — faint horizontal centerline + light vertical
      // bars every 30px gives the "graph paper" feel without screaming.
      c.lineWidth = 1;
      c.shadowBlur = 0;
      c.strokeStyle = activeRef.current
        ? "rgba(16, 185, 129, 0.10)"
        : "rgba(100, 116, 139, 0.10)";
      for (let x = ((Date.now() / 20) % 30) - 30; x < width; x += 30) {
        c.beginPath();
        c.moveTo(x, 0);
        c.lineTo(x, height);
        c.stroke();
      }
      c.beginPath();
      c.moveTo(0, height / 2);
      c.lineTo(width, height / 2);
      c.stroke();

      // Waveform line. Non-linear amplitude (^0.65) so quiet voice
      // still draws visible peaks instead of crawling along the
      // baseline.
      const lineColor = activeRef.current
        ? "rgb(16, 185, 129)"
        : "rgba(100, 116, 139, 0.55)";
      c.strokeStyle = lineColor;
      c.lineWidth = activeRef.current ? 2.25 : 1.5;
      c.lineJoin = "round";
      c.lineCap = "round";
      if (activeRef.current) {
        c.shadowColor = "rgba(16, 185, 129, 0.85)";
        c.shadowBlur = 12;
      } else {
        c.shadowBlur = 0;
      }

      const step = width / Math.max(1, targetSamples);
      c.beginPath();
      for (let i = 0; i < samples.length; i++) {
        const x = width - (samples.length - i) * step;
        const raw = samples[i] ?? 0;
        const amp = Math.pow(Math.min(1, raw), 0.65);
        const y = height / 2 - amp * (height / 2 - 6);
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.stroke();

      // Leading-edge dot — small bright pip at the rightmost sample,
      // sells the "this is alive" feeling on a clinical monitor.
      if (activeRef.current && samples.length > 0) {
        const last = samples[samples.length - 1] ?? 0;
        const amp = Math.pow(Math.min(1, last), 0.65);
        const y = height / 2 - amp * (height / 2 - 6);
        c.fillStyle = "rgb(16, 185, 129)";
        c.shadowColor = "rgba(16, 185, 129, 0.95)";
        c.shadowBlur = 16;
        c.beginPath();
        c.arc(width - 2, y, 2.5, 0, Math.PI * 2);
        c.fill();
        c.shadowBlur = 0;
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      ro.disconnect();
    };
  }, []);

  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-md bg-slate-950 transition-shadow",
        active &&
          "shadow-[inset_0_0_20px_rgba(16,185,129,0.18),0_0_18px_-4px_rgba(16,185,129,0.5)]",
      )}
    >
      <canvas
        ref={canvasRef}
        className="block h-20 w-full"
        aria-hidden="true"
      />
    </div>
  );
}

function SegmentPlayer({ segment }: { segment: AudioSegment }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(segment.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [segment.blob]);
  if (!url) return null;
  return (
    <audio
      controls
      preload="metadata"
      src={url}
      className="h-8 min-w-0 flex-1"
    />
  );
}
