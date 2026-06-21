// Per-code and bulk refinement passes. Three operations:
//
//   refineSuggestion       — single-code preview. Read-only; returns
//                            ranked alternatives but doesn't mutate.
//   refineAllInSession     — bulk refine over every editable
//                            icd10/cpt suggestion in a session. Real
//                            Anthropic call per suggestion, so capped
//                            at REFINE_CONCURRENCY in flight.
//   applyRefinement        — provider picks one option and we set
//                            editedCode + editedDescription, bumping
//                            hccCategory when the refinement unlocks
//                            a new bucket. Original values stay for audit.

import { and, eq } from "drizzle-orm";
import {
  billingSuggestionsTable,
  encounterCodingSessionsTable,
  getDb,
  type BillingSuggestion,
} from "@workspace/db";
import { recordCoderAuditEvent } from "../lib/audit-events";
import { refineCode, type RefinementOption } from "../lib/code-refiner";
import { mapWithLimit } from "../lib/concurrency";
import { loadSessionSuggestions } from "./coding-internals";

// Tighter cap than push concurrency — each refine is a real Anthropic
// call (~1-3s, 2k tokens). 4 in flight balances throughput vs cost.
const REFINE_CONCURRENCY = 4;

export type RefineSuggestionResult =
  | {
      kind: "ok";
      options: RefinementOption[];
      source: "ai" | "stub";
    }
  | { kind: "not_found" }
  | { kind: "not_refinable" }
  | { kind: "session_lost" };

export type RefineAllResult =
  | {
      kind: "ok";
      items: Array<{
        suggestionId: string;
        originalCode: string;
        options: RefinementOption[];
      }>;
      hccUnlockCount: number;
      source: "ai" | "stub";
    }
  | { kind: "not_found" };

export type ApplyRefinementResult =
  | { kind: "ok"; suggestion: BillingSuggestion }
  | { kind: "not_found" }
  | { kind: "not_editable" };

export async function refineSuggestion(args: {
  suggestionId: string;
  orgId: string;
}): Promise<RefineSuggestionResult> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(billingSuggestionsTable)
    .where(
      and(
        eq(billingSuggestionsTable.id, args.suggestionId),
        eq(billingSuggestionsTable.organizationId, args.orgId),
      ),
    )
    .limit(1);
  if (!row) return { kind: "not_found" };
  // Only icd10 + cpt refine meaningfully. E&M is a 5-level ladder
  // surfaced elsewhere; modifiers either apply or they don't.
  if (row.codeSystem !== "icd10" && row.codeSystem !== "cpt") {
    return { kind: "not_refinable" };
  }

  if (!row.codingSessionId) return { kind: "session_lost" };
  const [session] = await db
    .select({
      parsedSections: encounterCodingSessionsTable.parsedSections,
    })
    .from(encounterCodingSessionsTable)
    .where(
      and(
        eq(encounterCodingSessionsTable.id, row.codingSessionId),
        eq(encounterCodingSessionsTable.organizationId, args.orgId),
      ),
    )
    .limit(1);
  if (!session) return { kind: "session_lost" };

  const sections =
    (session.parsedSections as Record<string, string> | null) ?? {};

  const { result, source } = await refineCode({
    originalCode: row.editedCode ?? row.code,
    originalDescription: row.editedDescription ?? row.description,
    originalHccCategory: row.hccCategory,
    codeSystem: row.codeSystem as "icd10" | "cpt",
    sections,
  });

  return { kind: "ok", options: result.options, source };
}

export async function refineAllInSession(args: {
  sessionId: string;
  orgId: string;
}): Promise<RefineAllResult> {
  const db = getDb();
  const [session] = await db
    .select({
      id: encounterCodingSessionsTable.id,
      parsedSections: encounterCodingSessionsTable.parsedSections,
    })
    .from(encounterCodingSessionsTable)
    .where(
      and(
        eq(encounterCodingSessionsTable.id, args.sessionId),
        eq(encounterCodingSessionsTable.organizationId, args.orgId),
      ),
    )
    .limit(1);
  if (!session) return { kind: "not_found" };

  const suggestions = await loadSessionSuggestions(session.id, args.orgId);
  // Only refinable systems + only rows the provider can still edit.
  // Skip exported / approved rows — refine would be cosmetic noise.
  const targets = suggestions.filter(
    (s) =>
      (s.codeSystem === "icd10" || s.codeSystem === "cpt") &&
      (s.status === "ai_suggested" || s.status === "needs_review"),
  );

  if (targets.length === 0) {
    return {
      kind: "ok",
      items: [],
      hccUnlockCount: 0,
      source: "stub",
    };
  }

  const sections =
    (session.parsedSections as Record<string, string> | null) ?? {};

  const settled = await mapWithLimit(targets, REFINE_CONCURRENCY, (s) =>
    refineCode({
      originalCode: s.editedCode ?? s.code,
      originalDescription: s.editedDescription ?? s.description,
      originalHccCategory: s.hccCategory,
      codeSystem: s.codeSystem as "icd10" | "cpt",
      sections,
    }),
  );

  // If at least one call succeeded as real-AI source, the batch is AI.
  // A mixed batch degrades to 'stub' so the UI can warn appropriately.
  let source: "ai" | "stub" = "stub";
  let hccUnlockCount = 0;
  const items = targets.map((s, i) => {
    const r = settled[i]!;
    const opts = r.status === "fulfilled" ? r.value!.result.options : [];
    if (r.status === "fulfilled" && r.value!.source === "ai") source = "ai";
    hccUnlockCount += opts.filter((o) => o.hccUnlocked).length;
    return {
      suggestionId: s.id,
      originalCode: s.editedCode ?? s.code,
      options: opts,
    };
  });

  return { kind: "ok", items, hccUnlockCount, source };
}

export async function applyRefinement(args: {
  suggestionId: string;
  orgId: string;
  reviewerId: string;
  // The provider-chosen option. We trust the caller to pass it back
  // as-is from the refine response; we don't re-validate against the
  // AI's output here (the suggestion edit-status gate above is the
  // only authorization needed).
  chosenCode: string;
  chosenDescription: string;
  chosenHccCategory: string | null;
  hccUnlocked: boolean;
}): Promise<ApplyRefinementResult> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(billingSuggestionsTable)
    .where(
      and(
        eq(billingSuggestionsTable.id, args.suggestionId),
        eq(billingSuggestionsTable.organizationId, args.orgId),
      ),
    )
    .limit(1);
  if (!row) return { kind: "not_found" };
  if (row.status !== "ai_suggested" && row.status !== "needs_review") {
    return { kind: "not_editable" };
  }

  const now = new Date();
  // Only widen hccCategory — if the original carried one already and
  // the refinement is HCC-neutral, keep the original (the refined code
  // might still map to the same HCC; we don't want to overwrite with
  // null based on a refiner heuristic).
  const newHcc = args.hccUnlocked ? args.chosenHccCategory : row.hccCategory;

  const [updated] = await db
    .update(billingSuggestionsTable)
    .set({
      editedCode: args.chosenCode,
      editedDescription: args.chosenDescription,
      hccCategory: newHcc,
      rafRelevant: args.hccUnlocked ? true : row.rafRelevant,
      statusNote:
        `Refined by ${args.reviewerId} at ${now.toISOString()}` +
        (args.hccUnlocked
          ? ` (unlocked HCC ${args.chosenHccCategory})`
          : ""),
      updatedAt: now,
    })
    .where(eq(billingSuggestionsTable.id, args.suggestionId))
    .returning();
  if (!updated) return { kind: "not_found" };

  recordCoderAuditEvent({
    organizationId: args.orgId,
    userId: args.reviewerId,
    action: "coder.suggestion.refined.applied",
    resourceType: "billing_suggestion",
    resourceId: args.suggestionId,
    metadata: {
      codeSystem: row.codeSystem,
      originalCode: row.code,
      refinedCode: args.chosenCode,
      originalHccCategory: row.hccCategory,
      refinedHccCategory: args.chosenHccCategory,
      hccUnlocked: args.hccUnlocked,
    },
  });
  return { kind: "ok", suggestion: updated };
}
