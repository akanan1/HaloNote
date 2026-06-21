// RefinePanel — HaloNote's spin on CarePilot's "Refine ›" interaction.
//
// CarePilot shows one more-specific code with a transcript excerpt and
// an Accept button. We layer on:
//
//   - HCC unlock badge: when a refinement captures a new HCC bucket the
//     original code missed, it's flagged loudest. The provider sees the
//     revenue lever, not just a longer ICD-10.
//   - Documentation-gap mode: options the note doesn't currently support
//     show with the one-sentence finding the provider could paste into
//     the note. CarePilot only shows supported refinements; we surface
//     the upside path AND the doc-quality cost.

import type { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ClipboardCopy,
  Loader2,
  Sparkles,
  Target,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CONFIDENCE_TONE } from "../../constants";
import type { RefinementOption } from "../../types";

// Local alias to keep the prop type tidy without exposing the full
// RefineSuggestionResponse here.
type RefineSuggestionResponseT = {
  options: RefinementOption[];
  source: "ai" | "stub";
};

interface RefinePanelProps {
  originalCode: string;
  originalDescription: string;
  query: ReturnType<typeof useQuery<RefineSuggestionResponseT>>;
  onClose: () => void;
  onApply: (option: RefinementOption) => void;
  applying: boolean;
  applyingCode: string | null;
}

export function RefinePanel(props: RefinePanelProps) {
  const { data, isPending, isError, error } = props.query;
  const options = data?.options ?? [];

  return (
    <div className="mt-3 space-y-2 rounded-md border border-violet-200 bg-violet-50/40 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1 font-medium text-violet-900">
          <Sparkles className="h-3 w-3" />
          Refinements for{" "}
          <span className="font-mono">{props.originalCode}</span>
        </p>
        <Button size="sm" variant="ghost" onClick={props.onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>

      <p className="text-(--color-muted-foreground)">
        HCC-aware: refinements that unlock a new HCC bucket are surfaced
        first. Options the note doesn't yet support show the one-sentence
        finding you could add to justify them.
      </p>

      {isPending && (
        <p className="flex items-center gap-1 text-(--color-muted-foreground)">
          <Loader2 className="h-3 w-3 animate-spin" />
          Analyzing the note for more specific codes…
        </p>
      )}

      {isError && (
        <p className="text-red-700">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          {error instanceof Error ? error.message : "Refine failed"}
        </p>
      )}

      {!isPending && !isError && options.length === 0 && (
        <p className="text-(--color-muted-foreground)">
          No more-specific refinement found. The current code is already
          well-supported by the note, or the AI couldn't propose a safer
          alternative.
        </p>
      )}

      {options.length > 0 && (
        <ul className="space-y-2">
          {options.map((opt, idx) => (
            <RefineOptionCard
              key={`${opt.code}-${idx}`}
              option={opt}
              onApply={() => props.onApply(opt)}
              applying={props.applying && props.applyingCode === opt.code}
              applyDisabled={props.applying}
            />
          ))}
        </ul>
      )}

      {data?.source === "stub" && (
        <p className="text-(--color-muted-foreground)">
          (Refine ran in stub mode — set ANTHROPIC_API_KEY or
          CODING_SUGGESTER=ai for real refinements.)
        </p>
      )}
    </div>
  );
}

function RefineOptionCard({
  option,
  onApply,
  applying,
  applyDisabled,
}: {
  option: RefinementOption;
  onApply: () => void;
  applying: boolean;
  applyDisabled: boolean;
}) {
  const isDocGap = option.evidenceMode === "documentation_gap";

  return (
    <li
      className={`rounded-md border p-2.5 ${
        isDocGap
          ? "border-amber-200 bg-amber-50/40"
          : "border-violet-200 bg-(--color-card)"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded bg-(--color-muted) px-2 py-0.5 font-mono text-sm font-semibold">
              {option.code}
            </span>
            <span
              className={`text-xs font-medium uppercase tracking-wide ${CONFIDENCE_TONE[option.confidence]}`}
            >
              {option.confidence}
            </span>
            {option.hccUnlocked && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-900 ring-1 ring-emerald-300">
                <Zap className="h-3 w-3" />
                Unlocks {option.hccCategory ?? "HCC"}
              </span>
            )}
            {!option.hccUnlocked && option.hccCategory && (
              <span className="inline-flex items-center gap-1 rounded bg-violet-50 px-1.5 py-0.5 text-xs text-violet-900 ring-1 ring-violet-200">
                <Target className="h-3 w-3" />
                {option.hccCategory}
              </span>
            )}
            {isDocGap && (
              <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 ring-1 ring-amber-300">
                Needs doc
              </span>
            )}
          </div>
          <p className="text-sm text-(--color-foreground)">
            {option.description}
          </p>
          <p className="text-xs text-(--color-muted-foreground)">
            {option.rationale}
          </p>

          {option.supportingExcerpts.length > 0 && (
            <ul className="space-y-1">
              {option.supportingExcerpts.map((e, idx) => (
                <li
                  key={idx}
                  className="rounded bg-(--color-muted) px-2 py-1 text-xs italic"
                >
                  “{e.text}”
                </li>
              ))}
            </ul>
          )}

          {isDocGap && option.suggestedNoteLanguage && (
            <div className="space-y-1 rounded border border-amber-200 bg-amber-100/50 p-2 text-xs text-amber-900">
              <p className="flex items-center gap-1 font-medium">
                <ClipboardCopy className="h-3 w-3" />
                Add this to your note to justify the refined code:
              </p>
              <div className="flex items-start gap-2">
                <p className="flex-1 italic">
                  “{option.suggestedNoteLanguage}”
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(option.suggestedNoteLanguage ?? "")
                      .then(() => toast.success("Copied to clipboard"));
                  }}
                  title="Copy suggested note language"
                >
                  <ClipboardCopy className="h-3 w-3" />
                </Button>
              </div>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="sm"
            onClick={onApply}
            disabled={applyDisabled}
            title={
              isDocGap
                ? "Apply this refinement anyway — make sure to add the note language above first"
                : "Apply this refinement"
            }
          >
            {applying ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Apply
          </Button>
        </div>
      </div>
    </li>
  );
}
