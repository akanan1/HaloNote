import { Info, Shield, ShieldAlert } from "lucide-react";
import type { LiveCdsWarning } from "@/lib/use-streaming-transcript";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface LiveCdsPanelProps {
  warnings: LiveCdsWarning[];
}

const KIND_LABEL: Record<LiveCdsWarning["kind"], string> = {
  allergy_interaction: "Allergy",
  drug_drug_interaction: "Interaction",
  duplicate_therapy: "Duplicate therapy",
  dose_warning: "Dose",
  other: "Advisory",
};

const KIND_CHIP_TONE: Record<LiveCdsWarning["kind"], string> = {
  allergy_interaction: "bg-rose-100 text-rose-900",
  drug_drug_interaction: "bg-orange-100 text-orange-900",
  duplicate_therapy: "bg-amber-100 text-amber-900",
  dose_warning: "bg-yellow-100 text-yellow-900",
  other: "bg-(--color-muted) text-(--color-muted-foreground)",
};

const SEVERITY_ICON: Record<
  LiveCdsWarning["severity"],
  { icon: typeof Shield; tone: string; ring: string; ariaLabel: string }
> = {
  block: {
    icon: ShieldAlert,
    tone: "text-rose-700",
    ring: "ring-2 ring-rose-500/70",
    ariaLabel: "blocking severity",
  },
  warn: {
    icon: Shield,
    tone: "text-amber-700",
    ring: "ring-1 ring-amber-500/60",
    ariaLabel: "warning severity",
  },
  info: {
    icon: Info,
    tone: "text-(--color-muted-foreground)",
    ring: "",
    ariaLabel: "informational severity",
  },
};

// Sits above the billing + nudges panels — patient-safety warnings
// outrank billing in the visual stack. Hidden when no warnings have
// arrived. Server-side dedupe + a client-side dedupe in
// `useStreamingTranscript` ensure a repeat warning doesn't re-flash;
// once flagged, an item stays put for the rest of the session.
//
// These are ADVISORY only — they don't gate the recording, don't
// block the note, and they don't substitute for the provider's own
// clinical judgment. The "block" severity simply means "stop and
// double-check before proceeding."
export function LiveCdsPanel({ warnings }: LiveCdsPanelProps) {
  if (warnings.length === 0) return null;
  // Newest first so the most recent flag is at the top.
  const ordered = warnings.slice().reverse();
  const blockingCount = warnings.filter((w) => w.severity === "block").length;
  return (
    <Card
      className={cn(
        "overflow-hidden",
        blockingCount > 0 ? "ring-2 ring-rose-500/70" : "",
      )}
    >
      <div className="flex items-center gap-2 border-b border-(--color-border) bg-(--color-muted)/40 px-4 py-2 text-xs font-medium uppercase tracking-wide text-(--color-muted-foreground)">
        <ShieldAlert
          className={cn(
            "h-3.5 w-3.5",
            blockingCount > 0 ? "text-rose-600" : "",
          )}
          aria-hidden="true"
        />
        Safety warnings ({warnings.length})
        <span className="ml-auto normal-case tracking-normal text-(--color-muted-foreground)">
          Advisory — your call
        </span>
      </div>
      <ul className="divide-y divide-(--color-border)">
        {ordered.map((w, i) => {
          const sev = SEVERITY_ICON[w.severity];
          const Icon = sev.icon;
          return (
            <li
              key={`${w.kind}:${i}:${w.message.slice(0, 40)}`}
              className={cn(
                "flex items-start gap-3 px-4 py-3",
                sev.ring,
              )}
            >
              <Icon
                className={cn("mt-0.5 h-5 w-5 shrink-0", sev.tone)}
                aria-hidden="true"
                aria-label={sev.ariaLabel}
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide",
                      KIND_CHIP_TONE[w.kind],
                    )}
                  >
                    {KIND_LABEL[w.kind]}
                  </span>
                  {w.focus ? (
                    <span className="text-xs text-(--color-muted-foreground)">
                      {w.focus}
                    </span>
                  ) : null}
                </div>
                <p className="text-sm">{w.message}</p>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
