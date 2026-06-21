// RefineAllMatrix — bulk refinement overview. The compact alternative
// to clicking Refine on every card. Shows one row per suggestion with
// the top-ranked refinement option, an HCC-unlock badge if applicable,
// and an "Apply all HCC unlocks" bulk action that one-clicks every
// HCC-unlocking option in parallel.
//
// Skips rows the refiner returned nothing for (already well-specified
// or no plausible refinement) — those just won't appear.

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Loader2, Wand2, X, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { applyCodingRefinement } from "../../api";
import type {
  CodingSuggestion,
  RefineAllResponse,
  RefinementOption,
} from "../../types";

export function RefineAllMatrix({
  result,
  suggestions,
  onClose,
  onApplied,
}: {
  result: RefineAllResponse;
  suggestions: CodingSuggestion[];
  onClose: () => void;
  onApplied: () => void;
}) {
  const qc = useQueryClient();

  // Index suggestions by id for description lookup in the row label.
  const suggestionById = useMemo(() => {
    const m = new Map<string, CodingSuggestion>();
    for (const s of suggestions) m.set(s.id, s);
    return m;
  }, [suggestions]);

  // Only render rows that have at least one option, sorted: HCC-unlocks
  // first, then by confidence (high > medium > low).
  const CONF_RANK: Record<RefinementOption["confidence"], number> = {
    high: 2,
    medium: 1,
    low: 0,
  };
  const visibleRows = useMemo(() => {
    return result.items
      .filter((i) => i.options.length > 0)
      .map((i) => {
        // Top option = the one ranked first by the refiner (already
        // HCC-aware on the backend).
        const top = i.options[0]!;
        return { ...i, top };
      })
      .sort((a, b) => {
        if (a.top.hccUnlocked !== b.top.hccUnlocked) {
          return a.top.hccUnlocked ? -1 : 1;
        }
        return CONF_RANK[b.top.confidence] - CONF_RANK[a.top.confidence];
      });
  }, [result.items]);

  // Per-row apply state — tracks which suggestion id is currently being
  // applied so the row spinner is local. Bulk apply just sets the bulk
  // flag and fires all in parallel via Promise.allSettled.
  const [appliedIds, setAppliedIds] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulkApplying, setBulkApplying] = useState(false);

  async function applyOne(suggestionId: string, opt: RefinementOption) {
    setBusyId(suggestionId);
    try {
      await applyCodingRefinement(suggestionId, opt);
      setAppliedIds((prev) => {
        const next = new Set(prev);
        next.add(suggestionId);
        return next;
      });
      onApplied();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Apply failed");
    } finally {
      setBusyId(null);
    }
  }

  async function applyAllHccUnlocks() {
    const targets = visibleRows.filter(
      (r) => r.top.hccUnlocked && !appliedIds.has(r.suggestionId),
    );
    if (targets.length === 0) {
      toast.warning("No HCC unlocks available to apply");
      return;
    }
    setBulkApplying(true);
    const results = await Promise.allSettled(
      targets.map((r) => applyCodingRefinement(r.suggestionId, r.top)),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - succeeded;
    setAppliedIds((prev) => {
      const next = new Set(prev);
      for (let i = 0; i < results.length; i++) {
        if (results[i]!.status === "fulfilled") {
          next.add(targets[i]!.suggestionId);
        }
      }
      return next;
    });
    setBulkApplying(false);
    if (failed === 0) {
      toast.success(
        `Applied ${succeeded} HCC unlock${succeeded === 1 ? "" : "s"}`,
      );
    } else {
      toast.warning(
        `Applied ${succeeded} · ${failed} failed (try individually)`,
      );
    }
    void qc.invalidateQueries({ queryKey: ["coding-session"] });
    onApplied();
  }

  const remainingHccUnlocks = visibleRows.filter(
    (r) => r.top.hccUnlocked && !appliedIds.has(r.suggestionId),
  ).length;

  return (
    <section className="space-y-2 rounded-md border border-violet-300 bg-violet-50/60 p-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <p className="flex items-center gap-1 text-sm font-medium text-violet-900">
            <Wand2 className="h-4 w-4" />
            Refine-all overview
          </p>
          <p className="text-xs text-(--color-muted-foreground)">
            {visibleRows.length} refinable code
            {visibleRows.length === 1 ? "" : "s"}
            {result.hccUnlockCount > 0 && (
              <>
                {" · "}
                <span className="font-medium text-emerald-700">
                  {result.hccUnlockCount} HCC unlock
                  {result.hccUnlockCount === 1 ? "" : "s"} available
                </span>
              </>
            )}
            {result.source === "stub" && " · stub mode"}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {remainingHccUnlocks > 0 && (
            <Button
              size="sm"
              onClick={applyAllHccUnlocks}
              disabled={bulkApplying}
              title="One-click apply every HCC-unlocking refinement"
              className="bg-emerald-600 text-white hover:bg-emerald-700"
            >
              {bulkApplying ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Zap className="h-4 w-4" />
              )}
              Apply {remainingHccUnlocks} HCC unlock
              {remainingHccUnlocks === 1 ? "" : "s"}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </header>

      {visibleRows.length === 0 ? (
        <p className="text-xs text-(--color-muted-foreground)">
          No refinements found. All codes in this session are already
          well-supported, or the refiner couldn't propose a safer alternative.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {visibleRows.map((row) => {
            const orig = suggestionById.get(row.suggestionId);
            const applied = appliedIds.has(row.suggestionId);
            return (
              <li
                key={row.suggestionId}
                className={`rounded border p-2 text-xs ${
                  applied
                    ? "border-emerald-200 bg-emerald-50/40"
                    : row.top.hccUnlocked
                      ? "border-emerald-300 bg-(--color-card)"
                      : "border-violet-200 bg-(--color-card)"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-(--color-muted) px-1.5 py-0.5 font-mono">
                        {row.originalCode}
                      </span>
                      <span className="text-(--color-muted-foreground)">
                        →
                      </span>
                      <span className="rounded bg-violet-100 px-1.5 py-0.5 font-mono font-semibold">
                        {row.top.code}
                      </span>
                      {row.top.hccUnlocked && (
                        <span className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 px-1.5 py-0.5 font-medium text-emerald-900 ring-1 ring-emerald-300">
                          <Zap className="h-3 w-3" />
                          Unlocks {row.top.hccCategory ?? "HCC"}
                        </span>
                      )}
                      {row.top.evidenceMode === "documentation_gap" && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900 ring-1 ring-amber-300">
                          Needs doc
                        </span>
                      )}
                      {applied && (
                        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-900 ring-1 ring-emerald-300">
                          Applied
                        </span>
                      )}
                    </p>
                    <p className="text-(--color-muted-foreground)">
                      {row.top.description}
                      {orig && (
                        <>
                          {" · was: "}
                          <span className="italic">
                            {orig.editedDescription ?? orig.description}
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                  {!applied && (
                    <Button
                      size="sm"
                      onClick={() => applyOne(row.suggestionId, row.top)}
                      disabled={busyId === row.suggestionId || bulkApplying}
                    >
                      {busyId === row.suggestionId ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                      Apply
                    </Button>
                  )}
                </div>
                {row.options.length > 1 && (
                  <p className="mt-1 text-(--color-muted-foreground)">
                    +{row.options.length - 1} alternative
                    {row.options.length === 2 ? "" : "s"} available via
                    per-card Refine
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
