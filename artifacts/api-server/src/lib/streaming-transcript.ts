import type { IncomingMessage, Server as HttpServer } from "node:http";
import {
  createClient as createDeepgramClient,
  LiveTranscriptionEvents,
  type ListenLiveClient,
} from "@deepgram/sdk";
import { WebSocketServer, type WebSocket } from "ws";
import { eq } from "drizzle-orm";
import {
  getDb,
  patientsTable,
  providerVerbalCuesTable,
  recordingJobsTable,
} from "@workspace/db";
import { SESSION_COOKIE, lookupSession } from "./auth";
import { getPatientHistory } from "./ehr-history";
import { logger } from "./logger";
import { suggestLiveCodes, type LiveCode } from "./live-billing-suggester";
import {
  suggestLiveCdsWarnings,
  type LiveCdsChart,
  type LiveCdsWarning,
} from "./live-cds";
import { suggestLiveNudges, type LiveNudge } from "./live-nudges";

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
  | { type: "billing_suggestion"; codes: LiveCode[] }
  | { type: "nudge"; nudges: LiveNudge[] }
  | { type: "cds_warning"; warnings: LiveCdsWarning[] }
  | { type: "error"; message: string };

// Run a live-billing pass every Nth new final line. Higher = fewer
// LLM calls + more transcript per call (better recall); lower =
// faster reactivity. 5 lines is roughly one suggestion call every
// 15-30 seconds of speech.
const LIVE_BILLING_LINES_PER_PASS = 5;

// Hard cap on CDS passes per session. CDS is patient-safety code and
// runs the most expensive prompt (chart context + transcript every
// call), so an unbounded session shouldn't spam the API or blow the
// LLM budget. 20 passes is enough for a long visit (~100 final lines
// at the every-5 cadence). We log when hit so an operator can tune.
const LIVE_CDS_MAX_CALLS_PER_SESSION = 20;

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

async function loadCues(userId: string): Promise<readonly string[]> {
  try {
    const rows = await getDb()
      .select({ phrase: providerVerbalCuesTable.phrase })
      .from(providerVerbalCuesTable)
      .where(eq(providerVerbalCuesTable.userId, userId));
    if (rows.length === 0) return DEFAULT_END_CUES;
    return rows.map((r) => r.phrase.toLowerCase());
  } catch (err) {
    logger.warn(
      { err, userId },
      "streaming: cue load failed; using defaults",
    );
    return DEFAULT_END_CUES;
  }
}

/**
 * Fetch the patient chart for the CDS pipe. Returns null when no
 * jobId, no patient linked, no ehr_patient_id, or the EHR fetch fails
 * — any of those mean CDS is opt-out for this session (no LLM calls,
 * the rest of the bridge keeps streaming). Best-effort by design.
 *
 * Exported so a unit test can verify the failure path returns null
 * (and the bridge therefore skips CDS, keeps streaming) without
 * having to spin up the whole upgrade pipeline.
 */
export async function loadCdsChart(
  jobId: string | null,
  userId: string,
): Promise<LiveCdsChart | null> {
  if (!jobId) return null;
  try {
    const rows = await getDb()
      .select({
        ehrPatientId: patientsTable.ehrPatientId,
      })
      .from(recordingJobsTable)
      .leftJoin(
        patientsTable,
        eq(recordingJobsTable.patientId, patientsTable.id),
      )
      .where(eq(recordingJobsTable.id, jobId))
      .limit(1);
    const ehrPatientId = rows[0]?.ehrPatientId;
    if (!ehrPatientId) return null;
    const history = await getPatientHistory(ehrPatientId, userId);
    return {
      activeMeds: history.medications.map((m) => {
        const dose = m.dosage ? ` — ${m.dosage}` : "";
        return truncateWords(`${m.text}${dose}`, 12);
      }),
      allergies: history.allergies.map((a) => {
        const tail: string[] = [];
        if (a.severity) tail.push(a.severity);
        if (a.reactions.length > 0) tail.push(a.reactions.join(", "));
        const qual = tail.length > 0 ? ` (${tail.join("; ")})` : "";
        return truncateWords(`${a.text}${qual}`, 12);
      }),
      conditions: history.problems.map((p) => truncateWords(p.text, 12)),
    };
  } catch (err) {
    logger.warn(
      { err, jobId, userId },
      "streaming: CDS chart fetch failed; CDS disabled for session",
    );
    return null;
  }
}

function truncateWords(s: string, maxWords: number): string {
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return s.trim();
  return `${words.slice(0, maxWords).join(" ")}…`;
}

async function persistLiveTranscript(
  jobId: string,
  text: string,
): Promise<void> {
  if (!text.trim()) return;
  try {
    await getDb()
      .update(recordingJobsTable)
      .set({ liveTranscript: text })
      .where(eq(recordingJobsTable.id, jobId));
  } catch (err) {
    logger.warn({ err, jobId }, "streaming: live transcript persist failed");
  }
}

/**
 * Per-browser-connection bridge: pipe audio frames to Deepgram, push
 * transcripts back. Cue detection runs on the server so the verbal
 * end-phrase decision stays inside the perimeter (and so a future
 * tamper-resistant audit can prove the auto-stop was triggered by a
 * specific transcript word).
 *
 * When a `jobId` is provided (the browser passes it as a query param
 * on the upgrade URL), accumulated `is_final` lines are flushed to
 * recording_jobs.live_transcript on close — useful for audit and for
 * confirming which exact phrase triggered the auto-stop.
 */
function attachBridge(
  browserWs: WebSocket,
  userId: string,
  jobId: string | null,
): void {
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

  // Cue list. Starts with defaults — replaced by the user's curated
  // list once loadCues resolves. Race-safe: if a cue match happens
  // before the load completes, it just checks against defaults.
  let cues: readonly string[] = DEFAULT_END_CUES;
  void loadCues(userId).then((list) => {
    cues = list;
  });
  let cueTriggered = false;
  // Append every `is_final` line here so we can flush on close.
  const finalLines: string[] = [];
  // Live billing state.
  let billingInFlight = false;
  let linesSinceLastBilling = 0;
  const alreadySuggested: { codeSystem: string; code: string }[] = [];
  // Live nudge state — same debounce cadence as billing, runs in
  // parallel against the same transcript snapshot.
  let nudgesInFlight = false;
  let linesSinceLastNudge = 0;
  const alreadyNudged: { category: string; message: string }[] = [];
  // Live CDS state. `cdsChart` is resolved once at open: if it's
  // still null when the cadence fires we skip the LLM entirely (no
  // patient/EHR data = nothing to check against). The cap stops a
  // 30-minute visit from blowing the LLM budget.
  let cdsChart: LiveCdsChart | null = null;
  let cdsChartResolved = false;
  let cdsInFlight = false;
  let linesSinceLastCds = 0;
  let cdsCallsThisSession = 0;
  let cdsCapLogged = false;
  const alreadyFired: { kind: string; message: string }[] = [];
  void loadCdsChart(jobId, userId).then((chart) => {
    cdsChart = chart;
    cdsChartResolved = true;
    if (!chart) {
      logger.info(
        { jobId, userId },
        "streaming: CDS disabled (no chart context)",
      );
    }
  });

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
      finalLines.push(text);
      linesSinceLastBilling++;
      linesSinceLastNudge++;
      linesSinceLastCds++;
      if (
        cdsChartResolved &&
        cdsChart &&
        !cdsInFlight &&
        linesSinceLastCds >= LIVE_BILLING_LINES_PER_PASS
      ) {
        if (cdsCallsThisSession >= LIVE_CDS_MAX_CALLS_PER_SESSION) {
          if (!cdsCapLogged) {
            cdsCapLogged = true;
            logger.info(
              { jobId, userId, cap: LIVE_CDS_MAX_CALLS_PER_SESSION },
              "streaming: CDS per-session cap reached; further passes suppressed",
            );
          }
        } else {
          linesSinceLastCds = 0;
          cdsInFlight = true;
          cdsCallsThisSession++;
          const snapshot = finalLines.join("\n");
          const knownFired = alreadyFired.slice();
          const chartSnapshot = cdsChart;
          void suggestLiveCdsWarnings({
            transcript: snapshot,
            chart: chartSnapshot,
            alreadyFired: knownFired,
          })
            .then((warnings) => {
              // Dedupe at the bridge layer too — model can ignore the
              // hint, and a recurring allergy banner during a long
              // visit is its own safety hazard (alarm fatigue).
              const fresh = warnings.filter(
                (w) =>
                  !alreadyFired.some(
                    (k) => k.kind === w.kind && k.message === w.message,
                  ),
              );
              if (fresh.length > 0) {
                for (const w of fresh) {
                  alreadyFired.push({ kind: w.kind, message: w.message });
                  // Incident-review trail. This bridge bypasses the
                  // Express audit-log middleware, so explicit info
                  // lines are how a post-incident review proves what
                  // the system flagged and when. Message is short and
                  // not PHI by itself — it's a clinical rule statement.
                  logger.info(
                    {
                      jobId,
                      userId,
                      kind: w.kind,
                      severity: w.severity,
                      message: w.message,
                    },
                    "streaming: CDS warning fired",
                  );
                }
                send({ type: "cds_warning", warnings: fresh });
              }
            })
            .finally(() => {
              cdsInFlight = false;
            });
        }
      }
      if (
        !nudgesInFlight &&
        linesSinceLastNudge >= LIVE_BILLING_LINES_PER_PASS
      ) {
        linesSinceLastNudge = 0;
        nudgesInFlight = true;
        const snapshot = finalLines.join("\n");
        const knownNudges = alreadyNudged.slice();
        void suggestLiveNudges({
          transcript: snapshot,
          alreadyNudged: knownNudges,
        })
          .then((nudges) => {
            // Strict dedupe against (category, message) so a retry
            // of the same nudge doesn't repaint the panel.
            const fresh = nudges.filter(
              (n) =>
                !alreadyNudged.some(
                  (k) =>
                    k.category === n.category && k.message === n.message,
                ),
            );
            if (fresh.length > 0) {
              for (const n of fresh) {
                alreadyNudged.push({
                  category: n.category,
                  message: n.message,
                });
              }
              send({ type: "nudge", nudges: fresh });
            }
          })
          .finally(() => {
            nudgesInFlight = false;
          });
      }
      if (
        !billingInFlight &&
        linesSinceLastBilling >= LIVE_BILLING_LINES_PER_PASS
      ) {
        linesSinceLastBilling = 0;
        billingInFlight = true;
        const snapshot = finalLines.join("\n");
        const knownKeys = alreadySuggested.slice();
        void suggestLiveCodes({
          transcript: snapshot,
          alreadySuggested: knownKeys,
        })
          .then((codes) => {
            // Filter out anything we've already sent in case the
            // model didn't honor the dedupe hint.
            const fresh = codes.filter(
              (c) =>
                !alreadySuggested.some(
                  (k) =>
                    k.codeSystem === c.codeSystem && k.code === c.code,
                ),
            );
            if (fresh.length > 0) {
              for (const c of fresh) {
                alreadySuggested.push({
                  codeSystem: c.codeSystem,
                  code: c.code,
                });
              }
              send({ type: "billing_suggestion", codes: fresh });
            }
          })
          .finally(() => {
            billingInFlight = false;
          });
      }
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
    if (jobId && finalLines.length > 0) {
      void persistLiveTranscript(jobId, finalLines.join("\n"));
    }
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
    // Parse out path + query. The browser passes ?jobId=rec_… so the
    // bridge can persist the streamed transcript onto the matching
    // recording_jobs row when the session ends.
    const [path, query] = req.url.split("?");
    if (path !== STREAM_PATH) {
      // Not our endpoint — leave the socket alone. Some other handler
      // (none today) may pick it up; otherwise it'll time out.
      return;
    }
    const jobIdRaw = query
      ? new URLSearchParams(query).get("jobId")
      : null;
    const jobId = jobIdRaw && /^rec_[a-zA-Z0-9-]+$/.test(jobIdRaw)
      ? jobIdRaw
      : null;
    void authenticateUpgrade(req).then((auth) => {
      if (!auth) {
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n",
        );
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachBridge(ws, auth.userId, jobId);
      });
    });
  });
}
