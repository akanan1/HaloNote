import { useCallback, useEffect, useRef, useState } from "react";

// The browser SpeechRecognition API isn't in lib.dom.d.ts in older TS;
// declare the bits we use. Both `SpeechRecognition` and the
// webkit-prefixed variant exist depending on the browser (Chrome/Edge
// only expose the prefixed one).
interface SpeechRecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechRecognitionEvent extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechRecognitionResult>;
}
interface SpeechRecognitionErrorEvent extends Event {
  error: string;
  message?: string;
}
interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: SpeechRecognitionEvent) => void) | null;
  onerror: ((e: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export interface UseSpeechRecognitionResult {
  /** True when the SpeechRecognition API is available in this browser. */
  supported: boolean;
  /** True between start() and stop()/end, AND not paused. */
  listening: boolean;
  /** True when a session is suspended via pause() but not torn down. */
  paused: boolean;
  /** True when there is an active session (listening or paused). */
  active: boolean;
  /** Last error code from the API (e.g. "not-allowed", "no-speech"). */
  error: string | null;
  /**
   * Start listening. The handler is called once per finalized chunk
   * with the new transcript text (single utterance, not the cumulative
   * total). The hook itself doesn't buffer text — the caller decides
   * how to merge new fragments into wherever they belong.
   */
  start(onFinal: (text: string) => void, onInterim?: (text: string) => void): void;
  /** Suspend without ending the session. Handlers stick around so resume() can pick up. */
  pause(): void;
  /** Resume a paused session. No-op if not paused. */
  resume(): void;
  /** Fully terminate the session. */
  stop(): void;
}

/**
 * Thin wrapper around the browser SpeechRecognition API.
 *
 * The browser SpeechRecognition has no native pause — we emulate it by
 * stopping the underlying recognizer while keeping the user-facing
 * handlers stashed in refs, so resume() can restart cleanly with the
 * same callbacks. The provider sees one continuous "session" with a
 * pause/resume affordance, which matches how a dictation pedal feels.
 *
 * Note: this ships the audio off-device to whoever the browser uses
 * (Apple / Google). For HIPAA workloads, swap to a BAA-friendly STT
 * provider (Whisper via a BAA'd host, AWS Transcribe Medical,
 * Deepgram) — the public API of this hook stays the same.
 */
export function useSpeechRecognition(): UseSpeechRecognitionResult {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SpeechRecognitionInstance | null>(null);
  const onFinalRef = useRef<((text: string) => void) | null>(null);
  const onInterimRef = useRef<((text: string) => void) | null>(null);
  // Distinguishes "the recognizer stopped because the user paused" from
  // "it ended on its own". Without this, onend would clear the session
  // and prevent resume from re-attaching the same handlers.
  const pauseRequestedRef = useRef(false);

  useEffect(() => {
    setSupported(getCtor() !== null);
  }, []);

  const startInternal = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor) {
      setError("unsupported");
      return;
    }
    if (recRef.current) {
      try {
        recRef.current.stop();
      } catch {
        // best effort
      }
      recRef.current = null;
    }

    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "en-US";

    rec.onresult = (e: SpeechRecognitionEvent) => {
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        if (!result) continue;
        const text = result[0].transcript;
        if (result.isFinal) {
          final += text;
        } else {
          interim += text;
        }
      }
      if (final && onFinalRef.current) onFinalRef.current(final);
      if (interim && onInterimRef.current) onInterimRef.current(interim);
    };

    rec.onerror = (e: SpeechRecognitionErrorEvent) => {
      setError(e.error);
      // "no-speech" is benign and fires on every silent pause —
      // don't kill the listening state for it.
      if (e.error !== "no-speech") {
        setListening(false);
      }
    };

    rec.onend = () => {
      // If the user asked for a pause, keep handlers attached and just
      // flip the visible state so the UI shows "paused", not "idle".
      if (pauseRequestedRef.current) {
        pauseRequestedRef.current = false;
        setListening(false);
        setPaused(true);
        recRef.current = null;
        return;
      }
      setListening(false);
      setPaused(false);
      recRef.current = null;
      // Session truly ended — clear stashed handlers so a stale start()
      // doesn't accidentally hand them text from a new mount.
      onFinalRef.current = null;
      onInterimRef.current = null;
    };

    try {
      rec.start();
      recRef.current = rec;
      setListening(true);
      setPaused(false);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "start_failed");
      setListening(false);
    }
  }, []);

  const start = useCallback(
    (
      onFinal: (text: string) => void,
      onInterim?: (text: string) => void,
    ) => {
      onFinalRef.current = onFinal;
      onInterimRef.current = onInterim ?? null;
      startInternal();
    },
    [startInternal],
  );

  const pause = useCallback(() => {
    if (!recRef.current) return;
    pauseRequestedRef.current = true;
    try {
      recRef.current.stop();
    } catch {
      // ignore — onend will still fire and flip state
    }
  }, []);

  const resume = useCallback(() => {
    if (!paused) return;
    if (!onFinalRef.current) return;
    startInternal();
  }, [paused, startInternal]);

  const stop = useCallback(() => {
    pauseRequestedRef.current = false;
    if (recRef.current) {
      try {
        recRef.current.stop();
      } catch {
        // ignore
      }
      recRef.current = null;
    }
    onFinalRef.current = null;
    onInterimRef.current = null;
    setListening(false);
    setPaused(false);
  }, []);

  // Stop the recognizer on unmount so it doesn't keep the mic open.
  useEffect(() => {
    return () => {
      if (recRef.current) {
        try {
          recRef.current.stop();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  return {
    supported,
    listening,
    paused,
    active: listening || paused,
    error,
    start,
    pause,
    resume,
    stop,
  };
}
