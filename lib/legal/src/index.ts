// Versioned legal-document registry.
//
// The acceptance-of-record story has two halves:
//
//   1. The agreement TEXT lives in this package, one Markdown file
//      per version. Files are append-only — you never edit a published
//      version; you ship a new file (e.g. `baa-v2.md`) and bump the
//      currentVersion below. The deployed image therefore has every
//      version anyone might have ever accepted.
//
//   2. Each acceptance row in the DB carries the version + a SHA-256
//      hash of the exact bytes the user saw. On read-back, we
//      recompute the hash and compare; a mismatch means someone (or
//      something) altered the file under our feet, and the record is
//      no longer trustworthy.
//
// Bumping a document:
//   - Add `<type>-vN.md` with the new text.
//   - Update `REGISTRY[<type>].currentVersion` to N.
//   - Add the new version to `REGISTRY[<type>].versions`.
//   - Existing acceptances now reference an older version; users will
//     be prompted to accept the new version on their next sign-in.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DOCUMENTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "documents",
);

export type LegalDocumentType = "baa" | "terms" | "privacy";

export interface LegalDocumentMetadata {
  type: LegalDocumentType;
  /** Human title shown in the acceptance UI. */
  title: string;
  /** Short one-line teaser shown above the checkbox. */
  summary: string;
  /** Currently-required version. Acceptances of older versions don't count. */
  currentVersion: string;
  /** All shipped versions in the deployed image (oldest → newest). */
  versions: ReadonlyArray<string>;
}

export interface LegalDocument extends LegalDocumentMetadata {
  /** The Markdown body for `currentVersion`. */
  body: string;
  /** SHA-256 (hex) of `body`. Stored on every acceptance row. */
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const REGISTRY: Record<LegalDocumentType, LegalDocumentMetadata> = {
  baa: {
    type: "baa",
    title: "Business Associate Agreement",
    summary:
      "Required by HIPAA before HaloNote may process Protected Health Information on your behalf.",
    currentVersion: "1.0",
    versions: ["1.0"],
  },
  terms: {
    type: "terms",
    title: "Terms of Service",
    summary:
      "Your responsibilities and ours as you use the HaloNote service.",
    currentVersion: "1.0",
    versions: ["1.0"],
  },
  privacy: {
    type: "privacy",
    title: "Privacy Policy",
    summary:
      "What HaloNote collects about you as a provider. Patient PHI is governed by the BAA, not this Policy.",
    currentVersion: "1.0",
    versions: ["1.0"],
  },
};

// Document types we require every provider to accept before they can
// use the Service. Listed in display order. BAA is non-negotiable
// because PHI cannot be processed without it; the others are
// effectively required as well — keeping a separate list now means we
// can add an optional category (e.g. marketing-emails opt-in) later
// without restructuring.
export const REQUIRED_DOCUMENT_TYPES: ReadonlyArray<LegalDocumentType> = [
  "baa",
  "terms",
  "privacy",
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read a specific version of a document from disk. Used by the
 * acceptance endpoint to recompute the hash for record-keeping, and
 * by the audit verifier to check existing rows.
 */
export function readDocument(
  type: LegalDocumentType,
  version: string,
): { body: string; contentHash: string } {
  const meta = REGISTRY[type];
  if (!meta.versions.includes(version)) {
    throw new Error(
      `legal: unknown version "${version}" for document "${type}"`,
    );
  }
  const path = join(DOCUMENTS_DIR, `${type}-v${version}.md`);
  const body = readFileSync(path, "utf-8");
  const contentHash = createHash("sha256").update(body, "utf-8").digest("hex");
  return { body, contentHash };
}

/** Convenience accessor for the current required version of a document. */
export function getCurrentDocument(type: LegalDocumentType): LegalDocument {
  const meta = REGISTRY[type];
  const { body, contentHash } = readDocument(type, meta.currentVersion);
  return { ...meta, body, contentHash };
}

/** List the metadata + body for every currently-required document. */
export function getCurrentRequiredDocuments(): LegalDocument[] {
  return REQUIRED_DOCUMENT_TYPES.map((t) => getCurrentDocument(t));
}

/**
 * Re-verify an acceptance row against the on-disk text. Returns true
 * iff the hash matches what we computed when the record was created.
 * Used by the periodic audit script and by the Settings page when
 * showing the provider their acceptance history.
 */
export function verifyAcceptanceHash(
  type: LegalDocumentType,
  version: string,
  recordedHash: string,
): boolean {
  try {
    const { contentHash } = readDocument(type, version);
    return contentHash === recordedHash;
  } catch {
    return false;
  }
}

export { REGISTRY as _REGISTRY_FOR_TESTS };
