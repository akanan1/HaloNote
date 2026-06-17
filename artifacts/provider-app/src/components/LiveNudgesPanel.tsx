import { Bell } from "lucide-react";
import type { LiveDocNudge } from "@/lib/use-streaming-transcript";
import { Card } from "@/components/ui/card";

interface LiveNudgesPanelProps {
  nudges: LiveDocNudge[];
}

const CATEGORY_LABEL: Record<LiveDocNudge["category"], string> = {
  hpi: "HPI",
  ros: "ROS",
  exam: "Exam",
  assessment: "Assessment",
  plan: "Plan",
  meds: "Meds",
  allergies: "Allergies",
  social: "Social",
  other: "Other",
};

// Sits below the billing panel. Surfaces 1-3 short reminders per LLM
// pass about what the provider hasn't documented yet. The dedupe on
// the server side ensures a once-flagged nudge doesn't reappear after
// a screen wipe (we render newest-first so resolved items scroll
// away naturally).
//
// Unlike billing suggestions, nudges are advisory only — there's
// nothing to accept or reject mid-visit; the goal is just a glance-
// able prompt before the visit ends.
export function LiveNudgesPanel({ nudges }: LiveNudgesPanelProps) {
  if (nudges.length === 0) return null;
  // Reverse without mutating: newest first.
  const ordered = nudges.slice().reverse();
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-2 border-b border-(--color-border) bg-(--color-muted)/40 px-4 py-2 text-xs font-medium uppercase tracking-wide text-(--color-muted-foreground)">
        <Bell className="h-3.5 w-3.5" aria-hidden="true" />
        Reminders ({nudges.length})
      </div>
      <ul className="divide-y divide-(--color-border)">
        {ordered.map((n, i) => (
          <li
            key={`${n.category}:${i}:${n.message.slice(0, 32)}`}
            className="flex items-start gap-3 px-4 py-3"
          >
            <span className="rounded bg-(--color-muted) px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-(--color-muted-foreground)">
              {CATEGORY_LABEL[n.category]}
            </span>
            <p className="min-w-0 flex-1 text-sm">{n.message}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
