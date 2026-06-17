import { Banknote, ShieldCheck, ShieldAlert, Shield } from "lucide-react";
import type { LiveBillingCode } from "@/lib/use-streaming-transcript";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface LiveBillingPanelProps {
  suggestions: LiveBillingCode[];
}

const SYSTEM_LABEL: Record<LiveBillingCode["codeSystem"], string> = {
  icd10: "ICD-10",
  cpt: "CPT",
  em: "E&M",
  modifier: "Mod",
};

const CONFIDENCE_ICON: Record<
  LiveBillingCode["confidence"],
  { icon: typeof Shield; tone: string }
> = {
  high: { icon: ShieldCheck, tone: "text-emerald-600" },
  medium: { icon: Shield, tone: "text-(--color-muted-foreground)" },
  low: { icon: ShieldAlert, tone: "text-amber-600" },
};

// Sits below the transcript ribbon while a visit is active. Renders
// the running list of LLM-suggested codes — newest at top so the
// provider's eye lands on what just got picked up. Empty when no
// suggestions have arrived yet (typical for the first ~30 seconds).
//
// These are PREVIEW suggestions only. The canonical billing pass runs
// after the visit ends, over the structured note rather than the raw
// transcript. Provider confirms / rejects in the post-visit review.
export function LiveBillingPanel({ suggestions }: LiveBillingPanelProps) {
  if (suggestions.length === 0) return null;
  // Reverse without mutating: newest first.
  const ordered = suggestions.slice().reverse();
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-(--color-border) bg-(--color-muted)/40 px-4 py-2 text-xs font-medium uppercase tracking-wide text-(--color-muted-foreground)">
        <Banknote className="h-3.5 w-3.5" aria-hidden="true" />
        Suggested codes ({suggestions.length})
        <span className="ml-auto text-(--color-muted-foreground) normal-case tracking-normal">
          Preview — confirm after visit
        </span>
      </div>
      <ul className="divide-y divide-(--color-border)">
        {ordered.map((c, i) => {
          const conf = CONFIDENCE_ICON[c.confidence];
          const Icon = conf.icon;
          return (
            <li
              key={`${c.codeSystem}:${c.code}:${i}`}
              className="flex items-start gap-3 px-4 py-3"
            >
              <Icon
                className={cn("mt-0.5 h-4 w-4 shrink-0", conf.tone)}
                aria-hidden="true"
                aria-label={`${c.confidence} confidence`}
              />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="rounded bg-(--color-muted) px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-(--color-muted-foreground)">
                    {SYSTEM_LABEL[c.codeSystem]}
                  </span>
                  <span className="font-mono text-sm font-semibold">
                    {c.code}
                  </span>
                  <span className="text-sm">{c.description}</span>
                </div>
                <p className="text-xs text-(--color-muted-foreground)">
                  {c.rationale}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
