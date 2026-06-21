// Shared internals for the Coder service split.
//
// These helpers were previously private to the (former) god-file
// services/coding.ts. Lifted out so generation / approval / refinement
// can sit in their own files without each importing the others.
// Module is internal — only the per-step service files should depend
// on it; route layer + external callers go through services/coding.ts
// (the barrel) instead.

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  billingSuggestionsTable,
  getDb,
  type BillingSuggestion,
  type SuggestionConfidence,
} from "@workspace/db";

// Max parallel pushes per bulk-approve. Athena's documented prod rate
// limit is 100/sec; this leaves headroom for the other Coder/Scribe
// surfaces that might be writing concurrently from other encounters.
export const PUSH_CONCURRENCY = 8;

export const CONFIDENCE_RANK: Record<SuggestionConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function suggestionHasBlocker(s: BillingSuggestion): boolean {
  const gaps = Array.isArray(s.documentationGaps)
    ? (s.documentationGaps as Array<{ severity?: string }>)
    : [];
  return gaps.some((g) => g.severity === "block");
}

export async function loadSessionSuggestions(
  sessionId: string,
  orgId: string,
): Promise<BillingSuggestion[]> {
  return getDb()
    .select()
    .from(billingSuggestionsTable)
    .where(
      and(
        eq(billingSuggestionsTable.codingSessionId, sessionId),
        eq(billingSuggestionsTable.organizationId, orgId),
      ),
    )
    .orderBy(
      billingSuggestionsTable.codeSystem,
      billingSuggestionsTable.createdAt,
    );
}
