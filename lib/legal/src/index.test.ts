// Tests for the legal-document registry. The hash-pinning story is
// only as good as the verification logic — if `verifyAcceptanceHash`
// silently returned `true` for a tampered file the whole compliance
// argument falls apart. These tests pin the behavior.

import { describe, expect, it } from "vitest";
import {
  getCurrentDocument,
  getCurrentRequiredDocuments,
  readDocument,
  verifyAcceptanceHash,
  REQUIRED_DOCUMENT_TYPES,
  _REGISTRY_FOR_TESTS,
  type LegalDocumentType,
} from "./index";

describe("legal registry", () => {
  it("declares the same set in REQUIRED_DOCUMENT_TYPES and REGISTRY", () => {
    for (const t of REQUIRED_DOCUMENT_TYPES) {
      expect(_REGISTRY_FOR_TESTS[t]).toBeDefined();
    }
  });

  it.each(REQUIRED_DOCUMENT_TYPES)(
    "loads a non-empty body and a stable hash for %s",
    (type: LegalDocumentType) => {
      const doc = getCurrentDocument(type);
      expect(doc.body.trim().length).toBeGreaterThan(0);
      // SHA-256 hex is exactly 64 chars
      expect(doc.contentHash).toMatch(/^[a-f0-9]{64}$/);
      // Reading twice gives the same hash — deterministic.
      const second = getCurrentDocument(type);
      expect(second.contentHash).toBe(doc.contentHash);
    },
  );

  it("returns every required document via getCurrentRequiredDocuments", () => {
    const all = getCurrentRequiredDocuments();
    expect(all.length).toBe(REQUIRED_DOCUMENT_TYPES.length);
    const seenTypes = new Set(all.map((d) => d.type));
    for (const t of REQUIRED_DOCUMENT_TYPES) {
      expect(seenTypes.has(t)).toBe(true);
    }
  });

  it("rejects unknown versions", () => {
    expect(() => readDocument("baa", "99.99")).toThrow();
  });

  describe("verifyAcceptanceHash", () => {
    it("returns true for an honest hash", () => {
      const doc = getCurrentDocument("baa");
      expect(
        verifyAcceptanceHash("baa", doc.currentVersion, doc.contentHash),
      ).toBe(true);
    });

    it("returns false for a tampered hash (caught drift)", () => {
      const doc = getCurrentDocument("baa");
      // Flip a single hex character — any drift should fail the check.
      const flipped = doc.contentHash.replace(/./, (c) =>
        c === "0" ? "1" : "0",
      );
      expect(
        verifyAcceptanceHash("baa", doc.currentVersion, flipped),
      ).toBe(false);
    });

    it("returns false for a missing version (no throw)", () => {
      expect(
        verifyAcceptanceHash("baa", "99.99", "deadbeef".repeat(8)),
      ).toBe(false);
    });
  });
});
