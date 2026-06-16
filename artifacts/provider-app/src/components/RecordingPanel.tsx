import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, MicOff, Pause, Play, Square, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

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
  onSegmentsChange?: (segments: AudioSegment[]) => void;
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
  onSegmentsChange,
}: RecordingPanelProps) {
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
      setLevel(sum / buf.length / 255);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

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
        setSegments((s) => [...s, segment]);
      }
      chunksRef.current = [];
      accumulatedRef.current = 0;
      setElapsedMs(0);
      setLevel(0);
      setState("idle");
      teardownAudioGraph();
      recorderRef.current = null;
    };

    startTimeRef.current = performance.now();
    accumulatedRef.current = 0;
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
