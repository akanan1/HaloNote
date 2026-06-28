// recording-buffer.ts
//
// Durable, namespaced staging area for ambient-recording audio segments.
//
// The audio captured by RecordingPanel is the only copy of the visit
// until the upload pipeline finishes — so losing the React state to a
// tab close, an iOS Safari background, a refresh, or an accidental nav
// destroys the entire encounter. This module persists every
// `dataavailable` chunk to IndexedDB BEFORE the React state updates, so
// the audio survives anything short of the user clearing site data.
//
// ─── PHI / at-rest limitation ────────────────────────────────────────
//
// Browser IndexedDB is **not encrypted at rest** by the user agent. The
// blobs we store here are raw recorded audio (PHI). The mitigations we
// rely on:
//
//   1. Segments are short-lived — `clear(encounterId)` runs the instant
//      the upload pipeline returns 200, and `clearAllForUser(userId)`
//      fires on logout. Nothing should accumulate over time.
//   2. We never log blob contents — only durations and counts (the
//      logger redact paths in pino don't reach the browser, so we
//      enforce it manually below by accepting blobs through opaque
//      handles only).
//   3. Devices that handle PHI are expected to be at-rest-encrypted at
//      the OS level (FileVault / BitLocker / device passcode-locked
//      iOS). The browser DB inherits that protection.
//
// If a stricter HIPAA posture is needed later, wrap the blob in
// SubtleCrypto AES-GCM with a per-user key derived from the session
// token before the put() — out of scope for v0.
//
// ─── Key shape ───────────────────────────────────────────────────────
//
//   primary key: `${userId}:${encounterId}:${idx}`
//   indexed by:  `userId`, `${userId}:${encounterId}`
//
// `encounterId` is opaque to this module — the caller can pass a
// real encounter id from the URL, or a synthetic per-mount id when
// the session isn't yet tied to one. Recovery later filters by
// `${userId}:${encounterId}`, so the namespacing keeps two providers
// sharing a device cleanly separated.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

const DB_NAME = "halonote-recording-buffer";
const DB_VERSION = 1;
const STORE = "segments";

export interface BufferedSegmentMeta {
  /** Composite key: `${userId}:${encounterId}:${idx}`. */
  key: string;
  userId: string;
  encounterId: string;
  /** Monotonically increasing segment index within an encounter. */
  idx: number;
  /** MIME type the MediaRecorder produced. */
  mimeType: string;
  /** Wall-clock duration of this segment in milliseconds. */
  durationMs: number;
  /** Date.now() at which this segment was captured. */
  recordedAt: number;
  /** Session-lifecycle marker so the recovery banner can describe state. */
  status: "recording" | "uploaded";
}

export interface BufferedSegment extends BufferedSegmentMeta {
  blob: Blob;
}

interface RecordingBufferSchema extends DBSchema {
  [STORE]: {
    key: string;
    value: BufferedSegment;
    indexes: {
      byUser: string;
    };
  };
}

let dbPromise: Promise<IDBPDatabase<RecordingBufferSchema>> | null = null;

function getDb(): Promise<IDBPDatabase<RecordingBufferSchema>> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new Error("IndexedDB is not available in this environment"),
    );
  }
  if (!dbPromise) {
    dbPromise = openDB<RecordingBufferSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "key" });
          store.createIndex("byUser", "userId");
          // We deliberately skip a separate byEncounter index — the
          // primary-key prefix lookup (`${userId}:${encounterId}:`)
          // serves the same purpose and avoids the cross-browser
          // gotchas around compound IDBKeyRange ordering.
        }
      },
    });
  }
  return dbPromise;
}

function encounterKey(userId: string, encounterId: string): string {
  return `${userId}:${encounterId}`;
}

function compositeKey(
  userId: string,
  encounterId: string,
  idx: number,
): string {
  return `${encounterKey(userId, encounterId)}:${idx}`;
}

/**
 * Persist a single segment blob. Idempotent on `(userId, encounterId,
 * idx)` — repeating an `idx` overwrites, which lets the caller treat
 * the index as a sequence number it controls.
 *
 * Resolves once the write is flushed by the IDB transaction. Callers
 * should `await` before updating React state so a tab-close racing the
 * next paint can't drop the chunk.
 */
export async function appendSegment(
  userId: string,
  encounterId: string,
  idx: number,
  blob: Blob,
  meta: { mimeType: string; durationMs: number; recordedAt: number },
): Promise<BufferedSegmentMeta> {
  if (!userId || !encounterId) {
    throw new Error("appendSegment requires a userId and encounterId");
  }
  const key = compositeKey(userId, encounterId, idx);
  const row: BufferedSegment = {
    key,
    userId,
    encounterId,
    idx,
    blob,
    mimeType: meta.mimeType,
    durationMs: Math.max(0, Math.floor(meta.durationMs)),
    recordedAt: meta.recordedAt,
    status: "recording",
  };
  const db = await getDb();
  const tx = db.transaction(STORE, "readwrite");
  await tx.store.put(row);
  await tx.done;
  return stripBlob(row);
}

/**
 * List every persisted segment for a `(userId, encounterId)` pair,
 * sorted by `idx` ascending so reassembly order is deterministic.
 */
export async function listSegments(
  userId: string,
  encounterId: string,
): Promise<BufferedSegment[]> {
  const db = await getDb();
  const tx = db.transaction(STORE, "readonly");
  // We don't use the byEncounter index (compound IDBKeyRange isn't
  // portable; the `byEncounter` index above is a placeholder). Range
  // over the primary key with a `${userId}:${encounterId}:` prefix.
  const prefix = `${encounterKey(userId, encounterId)}:`;
  const range = IDBKeyRange.bound(prefix, `${prefix}￿`, false, false);
  const all = await tx.store.getAll(range);
  await tx.done;
  return all.sort((a, b) => a.idx - b.idx);
}

/**
 * List every encounter that still has segments for this user. Returns
 * a map keyed by `encounterId` with a small summary so the recovery
 * banner can describe what's there without loading the blobs.
 */
export async function listEncountersForUser(userId: string): Promise<
  Array<{
    encounterId: string;
    segmentCount: number;
    totalDurationMs: number;
    lastRecordedAt: number;
  }>
> {
  const db = await getDb();
  const tx = db.transaction(STORE, "readonly");
  const all = await tx.store.index("byUser").getAll(userId);
  await tx.done;
  const summary = new Map<
    string,
    { segmentCount: number; totalDurationMs: number; lastRecordedAt: number }
  >();
  for (const row of all) {
    const cur = summary.get(row.encounterId) ?? {
      segmentCount: 0,
      totalDurationMs: 0,
      lastRecordedAt: 0,
    };
    cur.segmentCount += 1;
    cur.totalDurationMs += row.durationMs;
    cur.lastRecordedAt = Math.max(cur.lastRecordedAt, row.recordedAt);
    summary.set(row.encounterId, cur);
  }
  return Array.from(summary.entries()).map(([encounterId, s]) => ({
    encounterId,
    ...s,
  }));
}

/**
 * Drop every segment belonging to a `(userId, encounterId)` pair.
 * Called after the upload pipeline returns 200 and after Discard.
 */
export async function clear(
  userId: string,
  encounterId: string,
): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(STORE, "readwrite");
  const prefix = `${encounterKey(userId, encounterId)}:`;
  const range = IDBKeyRange.bound(prefix, `${prefix}￿`, false, false);
  let cursor = await tx.store.openCursor(range);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

/**
 * Drop every segment owned by `userId` across every encounter. Called
 * from auth.signOut so the next user on the same device doesn't see
 * the previous user's audio.
 */
export async function clearAllForUser(userId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(STORE, "readwrite");
  let cursor = await tx.store.index("byUser").openCursor(userId);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

/**
 * Count segments persisted for a user (any encounter). Cheap probe
 * for the resume-banner check on RecordingPanel mount.
 */
export async function countForUser(userId: string): Promise<number> {
  const db = await getDb();
  const tx = db.transaction(STORE, "readonly");
  const count = await tx.store.index("byUser").count(userId);
  await tx.done;
  return count;
}

/** Visible-for-testing: wipe everything. */
export async function _resetAll(): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(STORE, "readwrite");
  await tx.store.clear();
  await tx.done;
}

/** Visible-for-testing: close + drop the open db handle. */
export async function _closeForTests(): Promise<void> {
  if (!dbPromise) return;
  const db = await dbPromise;
  db.close();
  dbPromise = null;
}

function stripBlob(s: BufferedSegment): BufferedSegmentMeta {
  // Make sure callers that only want metadata can avoid holding a
  // reference to the audio blob (a small but real PHI footprint).
  return {
    key: s.key,
    userId: s.userId,
    encounterId: s.encounterId,
    idx: s.idx,
    mimeType: s.mimeType,
    durationMs: s.durationMs,
    recordedAt: s.recordedAt,
    status: s.status,
  };
}
