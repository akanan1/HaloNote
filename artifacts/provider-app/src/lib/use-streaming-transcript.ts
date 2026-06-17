import { useCallback, useEffect, useRef, useState } from "react";

// Mirrors the server's LiveCode shape. Kept in lockstep with the
// suggester output so the client can render verbatim.
export interface LiveBillingCode {
  codeSystem: "icd10" | "cpt" | "em" | "modifier";
  code: string;
  description: string;
  rationale: string;
  confidence: "low" | "medium" | "high";
}

// Events the api-server bridge sends back over the WebSocket.
type ServerEvent =
  | { type: "ready" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "auto_stop"; reason: "verbal_cue"; cue: string }
  | { type: "billing_suggestion"; codes: LiveBillingCode[] }
  | { type: "error"; message: string };

export interface StreamingTranscriptState {
  /** Lines that Deepgram has finalized (is_final=true). Append-only. */
  finals: string[];
  /** Most recent unconfirmed partial; cleared when a final arrives. */
  partial: string;
  /** Server-side connection lifecycle indicator. */
  status: "idle" | "connecting" | "open" | "closed" | "error";
  /** Error message when status === "error". */
  error: string | null;
  /** Phrase that triggered an auto-stop, if any. */
  endCue: string | null;
  /** Billing suggestions surfaced during the visit so far. Append-only
   *  within a single session; cleared on stream teardown. */
  billingSuggestions: LiveBillingCode[];
}

export interface UseStreamingTranscriptParams {
  /**
   * The mic stream from RecordingPanel. The hook attaches an
   * AudioWorklet to it for PCM extraction. Setting to null tears down
   * the pipeline.
   */
  stream: MediaStream | null;
  /**
   * Fired when the server detects a verbal end-cue ("have a great
   * day", etc). The host should call its own stop-recording path —
   * the hook itself doesn't touch the MediaStream lifecycle.
   */
  onAutoStop?: (cue: string) => void;
}

const STREAM_URL_PATH = "/api/recordings/stream";

function buildStreamUrl(): string {
  // Same origin as the SPA so the existing session cookie flows on
  // the upgrade. Vite proxies /api/* to the api-server in dev; in
  // prod the SPA is served from the api-server itself, also same
  // origin. ws:// vs wss:// is chosen from the page protocol.
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${STREAM_URL_PATH}`;
}

/**
 * Live transcription pipe. Opens a WebSocket to the api-server bridge,
 * forwards mic PCM frames, and surfaces partial + final transcripts.
 * Verbal end-cues are detected server-side; the `onAutoStop` callback
 * fires once when a cue is matched.
 *
 * The hook is idle until `stream` becomes non-null. Setting it back
 * to null tears down both the WS and the AudioWorklet so a paused
 * recording doesn't keep streaming silence to Deepgram.
 */
export function useStreamingTranscript({
  stream,
  onAutoStop,
}: UseStreamingTranscriptParams): StreamingTranscriptState {
  const [finals, setFinals] = useState<string[]>([]);
  const [partial, setPartial] = useState("");
  const [status, setStatus] = useState<StreamingTranscriptState["status"]>(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [endCue, setEndCue] = useState<string | null>(null);
  const [billingSuggestions, setBillingSuggestions] = useState<
    LiveBillingCode[]
  >([]);

  const wsRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const onAutoStopRef = useRef(onAutoStop);

  useEffect(() => {
    onAutoStopRef.current = onAutoStop;
  }, [onAutoStop]);

  const teardown = useCallback(() => {
    try {
      workletRef.current?.disconnect();
    } catch {
      // already disconnected
    }
    try {
      sourceRef.current?.disconnect();
    } catch {
      // already disconnected
    }
    workletRef.current = null;
    sourceRef.current = null;
    const ctx = audioCtxRef.current;
    audioCtxRef.current = null;
    if (ctx && ctx.state !== "closed") {
      void ctx.close().catch(() => {});
    }
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send("close");
      } catch {
        // ignore
      }
      try {
        ws.close(1000, "client_done");
      } catch {
        // ignore
      }
    }
  }, []);

  useEffect(() => {
    if (!stream) {
      teardown();
      setStatus("idle");
      setPartial("");
      setFinals([]);
      setEndCue(null);
      setError(null);
      setBillingSuggestions([]);
      return;
    }

    let cancelled = false;
    setStatus("connecting");
    setError(null);
    setEndCue(null);

    const ws = new WebSocket(buildStreamUrl());
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.addEventListener("open", () => {
      if (cancelled) return;
      setStatus("open");
    });

    ws.addEventListener("message", (evt) => {
      if (cancelled) return;
      try {
        const parsed = JSON.parse(evt.data as string) as ServerEvent;
        switch (parsed.type) {
          case "ready":
            // server has the deepgram channel up; nothing else to do
            return;
          case "partial":
            setPartial(parsed.text);
            return;
          case "final":
            setFinals((cur) => [...cur, parsed.text]);
            setPartial("");
            return;
          case "auto_stop":
            setEndCue(parsed.cue);
            onAutoStopRef.current?.(parsed.cue);
            return;
          case "billing_suggestion":
            setBillingSuggestions((cur) => [...cur, ...parsed.codes]);
            return;
          case "error":
            setStatus("error");
            setError(parsed.message);
            return;
        }
      } catch {
        // Non-JSON frames are ignored; the server only sends JSON.
      }
    });

    ws.addEventListener("close", () => {
      if (cancelled) return;
      setStatus("closed");
    });

    ws.addEventListener("error", () => {
      if (cancelled) return;
      setStatus("error");
      setError("connection_failed");
    });

    // Audio graph: MediaStream → AudioContext → AudioWorklet (PCM out)
    // → ws.send. The worklet is loaded the first time it's needed; the
    // resulting AudioWorklet module is cached by the browser.
    let teardownGraph: (() => void) | null = null;
    (async () => {
      const Ctx =
        (typeof AudioContext !== "undefined" && AudioContext) ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctx) {
        setStatus("error");
        setError("audiocontext_unsupported");
        return;
      }
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      try {
        await ctx.audioWorklet.addModule("/pcm-worklet.js");
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setError(
          err instanceof Error ? err.message : "worklet_load_failed",
        );
        return;
      }
      if (cancelled) {
        void ctx.close().catch(() => {});
        return;
      }
      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "pcm-downsampler");
      source.connect(node);
      // The worklet doesn't drive an audio output — connect to
      // ctx.destination only if we wanted the user to hear the mic
      // back. We don't, so leave the node unconnected to the
      // destination but keep the worklet running by virtue of the
      // active source connection.
      node.port.onmessage = (evt: MessageEvent<ArrayBuffer>) => {
        if (cancelled) return;
        const sock = wsRef.current;
        if (sock && sock.readyState === WebSocket.OPEN) {
          sock.send(evt.data);
        }
      };
      sourceRef.current = source;
      workletRef.current = node;
      teardownGraph = () => {
        try {
          node.disconnect();
        } catch {}
        try {
          source.disconnect();
        } catch {}
      };
    })().catch(() => {
      // surfaced above via setStatus
    });

    return () => {
      cancelled = true;
      teardownGraph?.();
      teardown();
    };
  }, [stream, teardown]);

  return { finals, partial, status, error, endCue, billingSuggestions };
}
