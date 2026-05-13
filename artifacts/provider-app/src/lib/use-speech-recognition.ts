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
  /** True between start() and stop()/end. */
  listening: boolean;
  /** Last error code from the API (e.g. "not-allowed", "no-speech"). */
  error: string | null;
  /**
   * Start listening. The handler is called once per finalized chunk
   * with the new transcript text (single utterance, not the cumulative
   * total). The hook itself doesn't buffer text — the caller decides
   * how to merge new fragments into wherever they belong.
   */
  start(onFinal: (text: string) => void, onInterim?: (text: string) => void): void;
  stop(): void;
}

/**
 * Thin wrapper around the browser SpeechRecognition API.
 *
 * Note: this ships the audio off-device to whoever the browser uses
 * (Apple / Google). For HIPAA workloads, swap to a BAA-friendly STT
 * provider (Whisper via a BAA'd host, AWS Transcribe Medical,
 * Deepgram) — the public API of this hook stays the same.
 */
export function useSpeechRecognition(): UseSpeechRecognitionResult {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recRef = useRef<SpeechRecognitionInstance | null>(null);

  useEffect(() => {
    setSupported(getCtor() !== null);
  }, []);

  const start = useCallback(
    (
      onFinal: (text: string) => void,
      onInterim?: (text: string) => void,
    ) => {
      const Ctor = getCtor();
      if (!Ctor) {
        setError("unsupported");
        return;
      }
      // Always end any prior session before starting fresh — Chrome
      // throws "InvalidStateError" if start() is called on an active
      // instance.
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
        if (final) onFinal(final);
        if (interim && onInterim) onInterim(interim);
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
        setListening(false);
        recRef.current = null;
      };

      try {
        rec.start();
        recRef.current = rec;
        setListening(true);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "start_failed");
        setListening(false);
      }
    },
    [],
  );

  const stop = useCallback(() => {
    if (recRef.current) {
      try {
        recRef.current.stop();
      } catch {
        // ignore
      }
      recRef.current = null;
    }
    setListening(false);
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

  return { supported, listening, error, start, stop };
}
