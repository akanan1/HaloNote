// Per-suggestion code card. Owns its own refine state + mutation so
// the parent panel only manages the editing state for the row in flight.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  FileText,
  Loader2,
  Pencil,
  Target,
  Wand2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  applyCodingRefinement,
  refineCodingSuggestion,
} from "../../api";
import { CODING_SECTION_LABEL, CONFIDENCE_TONE } from "../../constants";
import type { CodingSuggestion, RefinementOption } from "../../types";
import { RefinePanel } from "./RefinePanel";

export interface SuggestionCardProps {
  suggestion: CodingSuggestion;
  isEditing: boolean;
  editCode: string;
  editDescription: string;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onChangeCode: (v: string) => void;
  onChangeDescription: (v: string) => void;
  onSaveEdit: () => void;
  saving: boolean;
}

export function SuggestionCard(props: SuggestionCardProps) {
  const s = props.suggestion;
  const qc = useQueryClient();
  const [refineOpen, setRefineOpen] = useState(false);

  // Lazy-load refinements: only fire on first open per card. Cache key
  // includes the suggestion's current effective code + updatedAt so an
  // edit or note re-generation busts the cache automatically.
  const effectiveCode = s.editedCode ?? s.code;
  const refineQ = useQuery({
    queryKey: ["refine-suggestion", s.id, effectiveCode, s.updatedAt],
    queryFn: () => refineCodingSuggestion(s.id),
    enabled: refineOpen,
    staleTime: 5 * 60 * 1000,
  });

  const applyMut = useMutation({
    mutationFn: (chosen: RefinementOption) =>
      applyCodingRefinement(s.id, chosen),
    onSuccess: (updated) => {
      toast.success(
        `Applied refinement → ${updated.editedCode ?? updated.code}`,
      );
      setRefineOpen(false);
      void qc.invalidateQueries({
        queryKey: ["coding-session", s.encounterId],
      });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Apply failed"),
  });

  const canRefine =
    (s.codeSystem === "icd10" || s.codeSystem === "cpt") &&
    (s.status === "ai_suggested" || s.status === "needs_review");

  const code = s.editedCode ?? s.code;
  const description = s.editedDescription ?? s.description;
  const wasEdited =
    s.editedCode != null &&
    (s.editedCode !== s.code || s.editedDescription !== s.description);
  const blockingGaps = s.documentationGaps.filter(
    (g) => g.severity === "block",
  );
  const otherGaps = s.documentationGaps.filter((g) => g.severity !== "block");

  return (
    <li className="rounded-md border border-(--color-border) bg-(--color-card) p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            {props.isEditing ? (
              <input
                value={props.editCode}
                onChange={(e) => props.onChangeCode(e.target.value)}
                className="w-24 rounded border border-(--color-border) px-2 py-0.5 font-mono text-sm"
                aria-label="Edited code"
              />
            ) : (
              <span className="rounded bg-(--color-muted) px-2 py-0.5 font-mono text-sm font-semibold">
                {code}
              </span>
            )}
            <span
              className={`text-xs font-medium uppercase tracking-wide ${CONFIDENCE_TONE[s.confidence]}`}
            >
              {s.confidence}
            </span>
            {wasEdited && (
              <span className="rounded bg-amber-50 px-1.5 py-0.5 text-xs text-amber-900 ring-1 ring-amber-200">
                edited
              </span>
            )}
            {s.hccCategory && (
              <span className="inline-flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 text-xs text-violet-900 ring-1 ring-violet-200">
                <Target className="h-3 w-3" />
                {s.hccCategory}
              </span>
            )}
            {s.rafRelevant && (
              <span className="rounded bg-violet-50 px-1.5 py-0.5 text-xs text-violet-900 ring-1 ring-violet-200">
                RAF
              </span>
            )}
            {s.status !== "ai_suggested" && (
              <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-xs text-emerald-900 ring-1 ring-emerald-200">
                {s.status.replace(/_/g, " ")}
              </span>
            )}
          </div>
          {props.isEditing ? (
            <textarea
              value={props.editDescription}
              onChange={(e) => props.onChangeDescription(e.target.value)}
              rows={2}
              className="w-full rounded border border-(--color-border) px-2 py-1 text-sm"
              aria-label="Edited description"
            />
          ) : (
            <p className="text-sm text-(--color-foreground)">{description}</p>
          )}
          <p className="text-xs text-(--color-muted-foreground)">
            {s.sourceSection && (
              <>
                <FileText className="mr-1 inline h-3 w-3" />
                {CODING_SECTION_LABEL[s.sourceSection]}
                {" · "}
              </>
            )}
            {s.destinationField && <>→ {s.destinationField}</>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {props.isEditing ? (
            <>
              <Button
                size="sm"
                onClick={props.onSaveEdit}
                disabled={
                  props.saving ||
                  props.editCode.trim().length === 0 ||
                  props.editDescription.trim().length === 0
                }
              >
                {props.saving ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={props.onCancelEdit}
                disabled={props.saving}
              >
                <X className="h-4 w-4" />
              </Button>
            </>
          ) : (
            <>
              {canRefine && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRefineOpen((v) => !v)}
                  title="Refine to a more specific code (HCC-aware)"
                  className="text-violet-700 hover:text-violet-900"
                >
                  <Wand2 className="h-4 w-4" />
                  Refine
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={props.onStartEdit}
                disabled={
                  s.status !== "ai_suggested" && s.status !== "needs_review"
                }
                title={
                  s.status === "ai_suggested" || s.status === "needs_review"
                    ? "Edit code or description before approving"
                    : "Edits not allowed after approval"
                }
              >
                <Pencil className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      {refineOpen && (
        <RefinePanel
          originalCode={code}
          originalDescription={description}
          query={refineQ}
          onClose={() => setRefineOpen(false)}
          onApply={(opt) => applyMut.mutate(opt)}
          applying={applyMut.isPending}
          applyingCode={applyMut.variables?.code ?? null}
        />
      )}

      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-(--color-muted-foreground) hover:text-(--color-foreground)">
          Why this code?
        </summary>
        <div className="mt-2 space-y-2">
          <p className="text-(--color-foreground)">{s.rationale}</p>
          {s.supportingExcerpts.length > 0 && (
            <div className="space-y-1">
              <p className="font-medium text-(--color-muted-foreground)">
                Supporting note text:
              </p>
              <ul className="space-y-1">
                {s.supportingExcerpts.map((e, idx) => (
                  <li
                    key={idx}
                    className="rounded bg-(--color-muted) px-2 py-1 italic"
                  >
                    “{e.text}”
                    {e.locationHint && (
                      <span className="ml-1 not-italic text-(--color-muted-foreground)">
                        — {e.locationHint}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {blockingGaps.length > 0 && (
            <div className="rounded border border-red-200 bg-red-50/60 p-2 text-red-900">
              <p className="font-medium">
                <AlertTriangle className="mr-1 inline h-3 w-3" />
                Blocking documentation gaps
              </p>
              <ul className="ml-4 list-disc space-y-0.5">
                {blockingGaps.map((g, idx) => (
                  <li key={idx}>{g.message}</li>
                ))}
              </ul>
            </div>
          )}
          {otherGaps.length > 0 && (
            <div className="rounded border border-amber-200 bg-amber-50/40 p-2 text-amber-900">
              <p className="font-medium">Documentation could be stronger</p>
              <ul className="ml-4 list-disc space-y-0.5">
                {otherGaps.map((g, idx) => (
                  <li key={idx}>{g.message}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </details>
    </li>
  );
}
