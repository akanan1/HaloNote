import { Router, type IRouter } from "express";
import { respondInvalidBody } from "../http";
import express from "express";
import { and, asc, count, eq } from "drizzle-orm";
import { CreateRecordingBody } from "@workspace/api-zod";
import {
  getDb,
  patientsTable,
  recordingJobsTable,
  recordingSegmentsTable,
  type RecordingJob,
  type RecordingSegment,
} from "@workspace/db";
import { getRecordingStorage } from "../lib/recording-storage";
import { getRecordingPipeline } from "../lib/recording-pipeline";
import { logger } from "../lib/logger";
import { getActiveOrgId } from "../lib/active-org";

const router: IRouter = Router();

// Max single-segment upload size. A 60s clip in opus is typically
// under 1MB; we leave headroom for longer pauses + lossless codecs.
// Server-enforced separately from express.json's 1MB global limit.
const MAX_SEGMENT_BYTES = 25 * 1024 * 1024; // 25 MB
const ACCEPTABLE_AUDIO_PREFIXES = ["audio/", "video/webm"];

function serializeJob(row: typeof recordingJobsTable.$inferSelect): RecordingJob {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    patientId: row.patientId,
    encounterId: row.encounterId,
    noteId: row.noteId,
    status: row.status,
    transcript: row.transcript,
    liveTranscript: row.liveTranscript,
    structuredBody: row.structuredBody,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

function serializeSegment(
  row: typeof recordingSegmentsTable.$inferSelect,
): RecordingSegment {
  return {
    id: row.id,
    recordingJobId: row.recordingJobId,
    ordinal: row.ordinal,
    storageKey: row.storageKey,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    durationMs: row.durationMs,
    uploadedAt: row.uploadedAt,
  };
}

// Look up a job by id AND owner AND org so any handler that returns 404
// also hides existence of cross-user OR cross-org rows.
async function getOwnedJob(jobId: string, userId: string, organizationId: string) {
  const [row] = await getDb()
    .select()
    .from(recordingJobsTable)
    .where(
      and(
        eq(recordingJobsTable.id, jobId),
        eq(recordingJobsTable.userId, userId),
        eq(recordingJobsTable.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

router.post("/recordings", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = CreateRecordingBody.safeParse(req.body ?? {});
  if (!parsed.success) return respondInvalidBody(res, parsed.error);

  const patientId = parsed.data.patientId ?? null;
  if (patientId) {
    // Scope by org so a leaked patient id from another tenant returns 404.
    const [p] = await getDb()
      .select({ id: patientsTable.id })
      .from(patientsTable)
      .where(
        and(
          eq(patientsTable.id, patientId),
          eq(patientsTable.organizationId, orgId),
        ),
      )
      .limit(1);
    if (!p) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
  }

  const [row] = await getDb()
    .insert(recordingJobsTable)
    .values({
      organizationId: orgId,
      userId: user.id,
      patientId,
    })
    .returning();
  if (!row) {
    res.status(500).json({ error: "insert_failed" });
    return;
  }
  res.status(201).json(serializeJob(row));
});

router.post(
  "/recordings/:id/segments",
  // Apply the raw-body parser at the route level (not globally) so big
  // binary uploads don't open every endpoint up to 25MB requests. The
  // type matcher accepts the codecs-suffixed variants browsers actually
  // send (audio/webm;codecs=opus, audio/mp4;codecs=mp4a.40.2, etc).
  express.raw({
    type: (req) => {
      const ct = req.headers["content-type"]?.toString().toLowerCase() ?? "";
      return ACCEPTABLE_AUDIO_PREFIXES.some((p) => ct.startsWith(p)) ||
        ct === "application/octet-stream";
    },
    limit: MAX_SEGMENT_BYTES,
  }),
  async (req, res) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const orgId = getActiveOrgId(req, res);
    if (!orgId) return;
    const job = await getOwnedJob(req.params["id"] ?? "", user.id, orgId);
    if (!job) {
      res.status(404).json({ error: "recording_not_found" });
      return;
    }
    if (job.status !== "capturing") {
      res.status(409).json({ error: "recording_not_capturing", status: job.status });
      return;
    }

    const durHeader = req.header("x-recording-duration-ms");
    const durationMs = durHeader != null ? Number(durHeader) : NaN;
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      res.status(400).json({ error: "invalid_duration_ms" });
      return;
    }

    const bytes = req.body;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      res.status(400).json({ error: "empty_body" });
      return;
    }
    const mimeType =
      req.header("content-type")?.split(";")[0]?.trim() ?? "application/octet-stream";

    // Server-assigned ordinal — next index after whatever's already
    // there. Concurrent uploads on the same job aren't expected
    // (the browser serializes Stop → upload → Start) but in a race
    // this picks the smaller index first and the row's unique key
    // constraint isn't required.
    const [counted] = await getDb()
      .select({ n: count() })
      .from(recordingSegmentsTable)
      .where(eq(recordingSegmentsTable.recordingJobId, job.id));
    const ordinal = Number(counted?.n ?? 0);

    // Pre-insert with a placeholder storageKey so we have a row id to
    // name the file with, then write bytes, then patch the storageKey.
    // (Avoids `crypto.randomUUID()` here for the file name; keeps the
    // canonical id in the DB.)
    const [inserted] = await getDb()
      .insert(recordingSegmentsTable)
      .values({
        recordingJobId: job.id,
        ordinal,
        storageKey: "_pending",
        mimeType,
        sizeBytes: bytes.length,
        durationMs: Math.floor(durationMs),
      })
      .returning();
    if (!inserted) {
      res.status(500).json({ error: "insert_failed" });
      return;
    }

    try {
      const { storageKey } = await getRecordingStorage().putSegment({
        recordingJobId: job.id,
        segmentId: inserted.id,
        bytes,
        mimeType,
      });
      const [updated] = await getDb()
        .update(recordingSegmentsTable)
        .set({ storageKey })
        .where(eq(recordingSegmentsTable.id, inserted.id))
        .returning();
      // Touch the job so updatedAt reflects activity.
      await getDb()
        .update(recordingJobsTable)
        .set({ updatedAt: new Date() })
        .where(eq(recordingJobsTable.id, job.id));
      res.status(201).json(serializeSegment(updated ?? inserted));
    } catch (err) {
      // Best-effort row cleanup so we don't leave _pending rows lying
      // around. The bytes either never landed or are orphaned — either
      // way the client retries from scratch.
      await getDb()
        .delete(recordingSegmentsTable)
        .where(eq(recordingSegmentsTable.id, inserted.id));
      logger.error(
        { err, jobId: job.id, segmentId: inserted.id },
        "recordings: putSegment failed",
      );
      res.status(500).json({ error: "storage_write_failed" });
    }
  },
);

router.post("/recordings/:id/finalize", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const job = await getOwnedJob(req.params["id"] ?? "", user.id, orgId);
  if (!job) {
    res.status(404).json({ error: "recording_not_found" });
    return;
  }
  if (job.status !== "capturing") {
    res.status(409).json({ error: "recording_already_finalized", status: job.status });
    return;
  }

  const [counted] = await getDb()
    .select({ n: count() })
    .from(recordingSegmentsTable)
    .where(eq(recordingSegmentsTable.recordingJobId, job.id));
  if (Number(counted?.n ?? 0) === 0) {
    res.status(422).json({ error: "no_segments_uploaded" });
    return;
  }

  const [queued] = await getDb()
    .update(recordingJobsTable)
    .set({ status: "queued", updatedAt: new Date() })
    .where(eq(recordingJobsTable.id, job.id))
    .returning();
  if (!queued) {
    res.status(500).json({ error: "update_failed" });
    return;
  }

  // Kick off the pipeline without awaiting it — the client polls
  // GET /recordings/{id} to learn when it lands. The pipeline
  // implementation is selected at boot by `getRecordingPipeline()`:
  // placeholder in dev/CI without keys, real Deepgram+Claude when
  // `RECORDING_PIPELINE=real` (or `auto` + both keys present).
  void getRecordingPipeline()
    .run(queued.id)
    .catch((err) => {
      logger.error({ err, jobId: queued.id }, "recordings: pipeline crashed");
    });

  res.json(serializeJob(queued));
});

router.get("/recordings/:id", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const job = await getOwnedJob(req.params["id"] ?? "", user.id, orgId);
  if (!job) {
    res.status(404).json({ error: "recording_not_found" });
    return;
  }
  const segments = await getDb()
    .select()
    .from(recordingSegmentsTable)
    .where(eq(recordingSegmentsTable.recordingJobId, job.id))
    .orderBy(asc(recordingSegmentsTable.ordinal));
  res.json({
    ...serializeJob(job),
    segments: segments.map(serializeSegment),
  });
});

export default router;
