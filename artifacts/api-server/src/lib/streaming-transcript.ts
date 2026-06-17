import type { IncomingMessage, Server as HttpServer } from "node:http";
import {
  createClient as createDeepgramClient,
  LiveTranscriptionEvents,
  type ListenLiveClient,
} from "@deepgram/sdk";
import { WebSocketServer, type WebSocket } from "ws";
import { SESSION_COOKIE, lookupSession } from "./auth";
import { logger } from "./logger";

// Default list of phrases that end a visit. Matched case-insensitively
// against each `is_final` transcript event. The match is *substring* —
// "thanks for coming in today, Mrs. Smith" hits the "thanks for coming in"
// rule. Tighter regex per-cue would catch edge cases (e.g. a doctor
// reading those words off a previous note) but is overkill for v1.
const DEFAULT_END_CUES = [
  "have a great day",
  "have a wonderful day",
  "take care now",
  "take care of yourself",
  "see you next time",
  "see you in",
  "follow up in",
  "thanks for coming in",
  "thank you for coming in",
  "goodbye",
] as const;

// Messages sent from the server to the browser over the WS bridge.
type ServerEvent =
  | { type: "ready" }
  | { type: "partial"; text: string }
  | { type: "final"; text: string }
  | { type: "auto_stop"; reason: "verbal_cue"; cue: string }
  | { type: "error"; message: string };

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const piece of header.split(";")) {
    const idx = piece.indexOf("=");
    if (idx < 0) continue;
    const k = piece.slice(0, idx).trim();
    const v = decodeURIComponent(piece.slice(idx + 1).trim());
    if (k) out[k] = v;
  }
  return out;
}

// Cookie-based auth on the upgrade request. We cannot reuse the
// express requireAuth middleware here — the upgrade path doesn't go
// through the Express pipeline. Mirrors what requireAuth does: pull
// the session cookie, look up the row, return the user. Returns null
// when missing/expired so the caller can 401 the upgrade cleanly.
async function authenticateUpgrade(req: IncomingMessage): Promise<{
  userId: string;
  organizationId: string | null;
} | null> {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;
  try {
    const lookup = await lookupSession(sessionId);
    if (!lookup) return null;
    // The active org isn't on the session row; org membership is
    // resolved per-request in Express via getActiveOrgId. For the
    // streaming bridge we keep the userId only — Deepgram doesn't
    // care about tenant scope, and cue detection is per-user.
    return { userId: lookup.user.id, organizationId: null };
  } catch (err) {
    logger.warn({ err }, "streaming: session lookup failed");
    return null;
  }
}

/**
 * Per-browser-connection bridge: pipe audio frames to Deepgram, push
 * transcripts back. Cue detection runs on the server so the verbal
 * end-phrase decision stays inside the perimeter (and so a future
 * tamper-resistant audit can prove the auto-stop was triggered by a
 * specific transcript word).
 */
function attachBridge(browserWs: WebSocket, userId: string): void {
  const apiKey = process.env["DEEPGRAM_API_KEY"];
  if (!apiKey) {
    browserWs.send(
      JSON.stringify({
        type: "error",
        message: "streaming_disabled",
      } satisfies ServerEvent),
    );
    browserWs.close(1011, "deepgram_unconfigured");
    return;
  }

  const deepgram = createDeepgramClient(apiKey);
  // linear16 PCM matches what the AudioWorklet on the client emits.
  // 16 kHz / mono keeps bandwidth low; medical recall is unchanged.
  // interim_results gives the partials that drive the live ribbon;
  // endpointing 300ms is Deepgram's default and feels right for visit
  // dictation (long sentences with brief pauses).
  let live: ListenLiveClient | null = deepgram.listen.live({
    model: "nova-3-medical",
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    interim_results: true,
    smart_format: true,
    punctuate: true,
    endpointing: 300,
  });

  // Cue list lookup. Currently the global default; per-user
  // customization is queued for the next phase.
  const cues = DEFAULT_END_CUES;
  let cueTriggered = false;

  function send(event: ServerEvent): void {
    if (browserWs.readyState === browserWs.OPEN) {
      browserWs.send(JSON.stringify(event));
    }
  }

  live.on(LiveTranscriptionEvents.Open, () => {
    send({ type: "ready" });
  });

  live.on(LiveTranscriptionEvents.Transcript, (msg: unknown) => {
    // Deepgram event payload shape:
    // { is_final, channel: { alternatives: [{ transcript, ... }] }, ... }
    const m = msg as {
      is_final?: boolean;
      channel?: { alternatives?: Array<{ transcript?: string }> };
    };
    const text = m.channel?.alternatives?.[0]?.transcript ?? "";
    if (!text) return;
    if (m.is_final) {
      send({ type: "final", text });
      if (!cueTriggered) {
        const lower = text.toLowerCase();
        const hit = cues.find((c) => lower.includes(c));
        if (hit) {
          cueTriggered = true;
          send({ type: "auto_stop", reason: "verbal_cue", cue: hit });
          logger.info(
            { userId, cue: hit },
            "streaming: verbal end-cue detected",
          );
        }
      }
    } else {
      send({ type: "partial", text });
    }
  });

  live.on(LiveTranscriptionEvents.Error, (err: unknown) => {
    logger.error({ err, userId }, "streaming: deepgram error");
    send({
      type: "error",
      message: err instanceof Error ? err.message : "deepgram_error",
    });
  });

  live.on(LiveTranscriptionEvents.Close, () => {
    if (browserWs.readyState === browserWs.OPEN) {
      browserWs.close(1000, "deepgram_closed");
    }
  });

  browserWs.on("message", (data, isBinary) => {
    if (!live) return;
    if (!isBinary) {
      // Browser can send a text "stop" sentinel to flush. Anything
      // unrecognized is ignored — we don't want to leak ws errors
      // back to the client on a stray text frame.
      try {
        const text = (data as Buffer).toString("utf8");
        if (text === "close") {
          live.requestClose();
        }
      } catch {
        // ignore
      }
      return;
    }
    // Binary frame = PCM. Forward verbatim. The SDK's send signature
    // wants ArrayBuffer-flavored types, so we pass a fresh
    // Uint8Array view sliced from the underlying Buffer.
    const buf =
      data instanceof Buffer
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data as ArrayBuffer);
    const ab = buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
    live.send(ab);
  });

  browserWs.on("close", () => {
    live?.requestClose();
    live = null;
  });

  browserWs.on("error", (err) => {
    logger.warn({ err, userId }, "streaming: browser socket error");
    live?.requestClose();
    live = null;
  });
}

let wssSingleton: WebSocketServer | null = null;
const STREAM_PATH = "/api/recordings/stream";

/**
 * Wire the streaming bridge onto the given http.Server. Call once at
 * boot from index.ts. Subsequent calls are no-ops so a test harness
 * that boots the app twice doesn't pile on duplicate upgrade handlers.
 */
export function attachStreamingTranscriptHandler(server: HttpServer): void {
  if (wssSingleton) return;
  const wss = new WebSocketServer({ noServer: true });
  wssSingleton = wss;

  server.on("upgrade", (req, socket, head) => {
    if (!req.url) {
      socket.destroy();
      return;
    }
    // Strip query string before matching so future params (e.g.
    // ?jobId=...) don't break the route.
    const path = req.url.split("?")[0];
    if (path !== STREAM_PATH) {
      // Not our endpoint — leave the socket alone. Some other handler
      // (none today) may pick it up; otherwise it'll time out.
      return;
    }
    void authenticateUpgrade(req).then((auth) => {
      if (!auth) {
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n",
        );
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachBridge(ws, auth.userId);
      });
    });
  });
}
