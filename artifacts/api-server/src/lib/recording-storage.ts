import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { logger } from "./logger";

// Storage backend for raw audio segments. Today: local filesystem
// under `RECORDINGS_LOCAL_ROOT` (defaults to `./recordings` next to
// the api-server process). Tomorrow: same interface, Supabase Storage
// (or S3) implementation behind a `RECORDINGS_BACKEND=supabase` env
// switch. Routes never touch the filesystem directly — they go through
// `getRecordingStorage()`.
export interface RecordingStorage {
  /**
   * Persist `bytes` for the given recording job + segment. Returns the
   * opaque `storageKey` written to the DB; on read, pass the same key
   * to read()/delete().
   */
  putSegment(args: {
    recordingJobId: string;
    segmentId: string;
    bytes: Buffer;
    mimeType: string;
  }): Promise<{ storageKey: string }>;

  /**
   * Read a previously-written segment. Used by the transcription
   * pipeline to feed audio into the STT vendor. Throws if the segment
   * is missing — the caller should treat that as a hard pipeline error
   * (the row points at a key that's no longer on disk).
   */
  readSegment(args: { storageKey: string }): Promise<Buffer>;

  /** Best-effort cleanup. Caller swallows errors; logging is the adapter's job. */
  deleteJob(recordingJobId: string): Promise<void>;
}

function pickExtension(mimeType: string): string {
  // Conservative mapping — the audio is opaque to us; the extension
  // is only there for human inspection of the recordings directory.
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("mp4")) return "m4a";
  if (mimeType.includes("aac")) return "aac";
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  return "bin";
}

class LocalFilesystemStorage implements RecordingStorage {
  constructor(private readonly root: string) {}

  async putSegment({
    recordingJobId,
    segmentId,
    bytes,
    mimeType,
  }: {
    recordingJobId: string;
    segmentId: string;
    bytes: Buffer;
    mimeType: string;
  }): Promise<{ storageKey: string }> {
    const ext = pickExtension(mimeType);
    const relPath = join(recordingJobId, `${segmentId}.${ext}`);
    const absPath = join(this.root, relPath);
    await mkdir(join(this.root, recordingJobId), { recursive: true });
    await writeFile(absPath, bytes);
    return { storageKey: relPath };
  }

  async readSegment({
    storageKey,
  }: {
    storageKey: string;
  }): Promise<Buffer> {
    const absPath = join(this.root, storageKey);
    return readFile(absPath);
  }

  async deleteJob(recordingJobId: string): Promise<void> {
    const dir = join(this.root, recordingJobId);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      logger.warn(
        { err, recordingJobId, dir },
        "recording-storage: deleteJob failed",
      );
    }
  }
}

let _instance: RecordingStorage | null = null;

export function getRecordingStorage(): RecordingStorage {
  if (_instance) return _instance;
  // Default to ./recordings next to the api-server process. Override
  // with `RECORDINGS_LOCAL_ROOT=/some/path` for ops setups (e.g. a
  // mounted volume in Docker).
  const root = resolve(
    process.env["RECORDINGS_LOCAL_ROOT"]?.trim() || "./recordings",
  );
  _instance = new LocalFilesystemStorage(root);
  logger.info({ root }, "recording-storage: using local filesystem");
  return _instance;
}

// Test helper — lets integration tests point storage at a tmp dir
// without leaking state across files.
export function _setRecordingStorageForTests(s: RecordingStorage | null) {
  _instance = s;
}
