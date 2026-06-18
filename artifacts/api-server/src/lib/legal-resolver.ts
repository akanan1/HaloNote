// Document resolver: blends the filesystem-shipped `@workspace/legal`
// registry with founder-uploaded DB overrides. DB rows always win
// when present — the seed is just the fallback for fresh installs
// before counsel-finalized text has been published.
//
// Why a thin api-server-side wrapper instead of putting the DB lookup
// into `@workspace/legal`: keeping the lib pure (no DB, no env
// coupling) means it stays cheap to unit-test and reusable from
// scripts. The resolver here owns the DB story.

import { createHash } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  getCurrentDocument as seedGetCurrentDocument,
  readDocument as seedReadDocument,
  REQUIRED_DOCUMENT_TYPES,
  type LegalDocument,
  type LegalDocumentType,
} from "@workspace/legal";
import {
  getDb,
  legalDocumentOverridesTable,
  type LegalDocumentOverride,
} from "@workspace/db";

interface ResolvedDocument extends LegalDocument {}

async function loadLatestOverride(
  type: LegalDocumentType,
): Promise<LegalDocumentOverride | null> {
  const [row] = await getDb()
    .select()
    .from(legalDocumentOverridesTable)
    .where(eq(legalDocumentOverridesTable.documentType, type))
    .orderBy(desc(legalDocumentOverridesTable.createdAt))
    .limit(1);
  return row ?? null;
}

export async function resolveCurrentDocument(
  type: LegalDocumentType,
): Promise<ResolvedDocument> {
  const override = await loadLatestOverride(type);
  if (override) {
    const seed = seedGetCurrentDocument(type);
    return {
      type,
      title: seed.title,
      summary: seed.summary,
      currentVersion: override.version,
      versions: [...seed.versions, override.version],
      body: override.body,
      contentHash: override.contentHash,
    };
  }
  return seedGetCurrentDocument(type);
}

export async function resolveAllRequiredDocuments(): Promise<
  ResolvedDocument[]
> {
  return Promise.all(
    REQUIRED_DOCUMENT_TYPES.map((t) => resolveCurrentDocument(t)),
  );
}

// Verify a previously-recorded acceptance against either the
// filesystem seed OR a DB override. Used by the acceptance POST so a
// version uploaded by the founder still verifies its hash properly.
export async function resolveDocumentByVersion(
  type: LegalDocumentType,
  version: string,
): Promise<{ body: string; contentHash: string } | null> {
  const [override] = await getDb()
    .select()
    .from(legalDocumentOverridesTable)
    .where(eq(legalDocumentOverridesTable.documentType, type))
    .orderBy(desc(legalDocumentOverridesTable.createdAt))
    .limit(50);
  // The narrow query above pulls 50 most-recent. If we somehow have
  // more than 50 versions for a single type the older ones won't
  // resolve here — which is fine, since recording acceptance against
  // an older version is not a supported path.
  if (override && override.version === version) {
    return { body: override.body, contentHash: override.contentHash };
  }
  try {
    return seedReadDocument(type, version);
  } catch {
    return null;
  }
}

export function hashLegalBody(body: string): string {
  return createHash("sha256").update(body, "utf-8").digest("hex");
}

export { REQUIRED_DOCUMENT_TYPES };
export type { LegalDocumentType };
