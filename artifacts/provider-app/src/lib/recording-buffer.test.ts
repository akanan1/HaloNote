import "fake-indexeddb/auto";
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// jsdom's `Blob` doesn't round-trip through structuredClone (used
// internally by fake-indexeddb) — the deserialized object loses both
// `size` and any way to read its bytes. Node's native Blob from
// node:buffer DOES clone cleanly. Swap the global before the suite
// runs so every `new Blob(...)` constructs a clone-safe one.
globalThis.Blob = NodeBlob as unknown as typeof Blob;

import {
  _closeForTests,
  _resetAll,
  appendSegment,
  clear,
  clearAllForUser,
  countForUser,
  listEncountersForUser,
  listSegments,
} from "./recording-buffer";

function makeBlob(text: string): Blob {
  return new Blob([text], { type: "audio/webm" });
}

// Compares blob sizes — jsdom + fake-indexeddb structured-clone
// doesn't preserve Blob readers across the roundtrip, so we assert on
// size (which IS preserved as the stored byte count) rather than
// reading the bytes back. Real browsers preserve the Blob faithfully.
function blobSize(b: Blob | { size?: number }): number {
  return (b as Blob).size ?? (b as { size?: number }).size ?? 0;
}

describe("recording-buffer", () => {
  beforeEach(async () => {
    await _resetAll();
  });

  afterEach(async () => {
    await _resetAll();
    await _closeForTests();
  });

  it("appends and lists segments in idx order", async () => {
    await appendSegment("user_a", "enc_1", 1, makeBlob("two"), {
      mimeType: "audio/webm",
      durationMs: 1500,
      recordedAt: 1700000001,
    });
    await appendSegment("user_a", "enc_1", 0, makeBlob("one"), {
      mimeType: "audio/webm",
      durationMs: 1000,
      recordedAt: 1700000000,
    });
    await appendSegment("user_a", "enc_1", 2, makeBlob("three"), {
      mimeType: "audio/webm",
      durationMs: 2000,
      recordedAt: 1700000002,
    });

    const segs = await listSegments("user_a", "enc_1");
    expect(segs.map((s) => s.idx)).toEqual([0, 1, 2]);
    expect(segs.map((s) => s.durationMs)).toEqual([1000, 1500, 2000]);
    expect(segs.map((s) => blobSize(s.blob))).toEqual([
      makeBlob("one").size,
      makeBlob("two").size,
      makeBlob("three").size,
    ]);
  });

  it("isolates segments by user and encounter", async () => {
    await appendSegment("user_a", "enc_1", 0, makeBlob("a-1"), {
      mimeType: "audio/webm",
      durationMs: 500,
      recordedAt: 1,
    });
    await appendSegment("user_a", "enc_2", 0, makeBlob("a-2"), {
      mimeType: "audio/webm",
      durationMs: 500,
      recordedAt: 2,
    });
    await appendSegment("user_b", "enc_1", 0, makeBlob("b-1"), {
      mimeType: "audio/webm",
      durationMs: 500,
      recordedAt: 3,
    });

    const aEnc1 = await listSegments("user_a", "enc_1");
    const aEnc2 = await listSegments("user_a", "enc_2");
    const bEnc1 = await listSegments("user_b", "enc_1");
    expect(aEnc1).toHaveLength(1);
    expect(aEnc2).toHaveLength(1);
    expect(bEnc1).toHaveLength(1);
    expect(blobSize(aEnc1[0]!.blob)).toBe(makeBlob("a-1").size);
    expect(blobSize(bEnc1[0]!.blob)).toBe(makeBlob("b-1").size);
    expect(blobSize(aEnc2[0]!.blob)).toBe(makeBlob("a-2").size);

    // user_a sees only their encounters; user_b is invisible to them.
    const aEncounters = await listEncountersForUser("user_a");
    expect(aEncounters.map((e) => e.encounterId).sort()).toEqual([
      "enc_1",
      "enc_2",
    ]);
    expect(await countForUser("user_a")).toBe(2);
    expect(await countForUser("user_b")).toBe(1);
  });

  it("clear() drops only the target encounter", async () => {
    await appendSegment("user_a", "enc_1", 0, makeBlob("x"), {
      mimeType: "audio/webm",
      durationMs: 100,
      recordedAt: 1,
    });
    await appendSegment("user_a", "enc_2", 0, makeBlob("y"), {
      mimeType: "audio/webm",
      durationMs: 100,
      recordedAt: 2,
    });

    await clear("user_a", "enc_1");
    expect(await listSegments("user_a", "enc_1")).toHaveLength(0);
    expect(await listSegments("user_a", "enc_2")).toHaveLength(1);
  });

  it("clearAllForUser() wipes every encounter for that user only", async () => {
    await appendSegment("user_a", "enc_1", 0, makeBlob("x"), {
      mimeType: "audio/webm",
      durationMs: 100,
      recordedAt: 1,
    });
    await appendSegment("user_a", "enc_2", 0, makeBlob("y"), {
      mimeType: "audio/webm",
      durationMs: 100,
      recordedAt: 2,
    });
    await appendSegment("user_b", "enc_1", 0, makeBlob("z"), {
      mimeType: "audio/webm",
      durationMs: 100,
      recordedAt: 3,
    });

    await clearAllForUser("user_a");
    expect(await countForUser("user_a")).toBe(0);
    expect(await countForUser("user_b")).toBe(1);
  });

  it("appendSegment with the same idx overwrites", async () => {
    await appendSegment("user_a", "enc_1", 0, makeBlob("first"), {
      mimeType: "audio/webm",
      durationMs: 100,
      recordedAt: 1,
    });
    await appendSegment("user_a", "enc_1", 0, makeBlob("second"), {
      mimeType: "audio/webm",
      durationMs: 200,
      recordedAt: 2,
    });
    const segs = await listSegments("user_a", "enc_1");
    expect(segs).toHaveLength(1);
    expect(blobSize(segs[0]!.blob)).toBe(makeBlob("second").size);
    expect(segs[0]!.durationMs).toBe(200);
  });

  it("rejects empty userId / encounterId", async () => {
    await expect(
      appendSegment("", "enc_1", 0, makeBlob("x"), {
        mimeType: "audio/webm",
        durationMs: 0,
        recordedAt: 0,
      }),
    ).rejects.toThrow();
    await expect(
      appendSegment("user_a", "", 0, makeBlob("x"), {
        mimeType: "audio/webm",
        durationMs: 0,
        recordedAt: 0,
      }),
    ).rejects.toThrow();
  });
});
