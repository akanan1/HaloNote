import { useState } from "react";
import { Send } from "lucide-react";
import { toast } from "sonner";
import { customFetch } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { Card } from "@/components/ui/card";

type AutoPushMode = "off" | "after_approve" | "after_transcription";

interface UpdateMeResponse {
  autoPushMode?: AutoPushMode;
}

const OPTIONS: {
  value: AutoPushMode;
  label: string;
  description: string;
}[] = [
  {
    value: "off",
    label: "Off",
    description:
      "Send to EHR manually after approving. Two taps per visit.",
  },
  {
    value: "after_approve",
    label: "After I approve",
    description:
      "Approving a note also sends it to the EHR. You still review every note; just one tap instead of two.",
  },
  {
    value: "after_transcription",
    label: "Immediately after transcription",
    description:
      "Skip review entirely — as soon as the AI structures the note from the recording, it ships straight to the EHR. Hands-free, but the first version in the chart is unreviewed (you can amend after the fact).",
  },
];

// Per-provider toggle controlling when a completed note ships to the
// EHR. Goes hand-in-hand with Phase 23's pipeline auto-push.
export function AutoPushSection() {
  const { user, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const current: AutoPushMode = (user?.autoPushMode as AutoPushMode) ?? "off";

  async function pick(next: AutoPushMode) {
    if (next === current) return;
    setBusy(true);
    try {
      await customFetch<UpdateMeResponse>("/api/auth/me", {
        method: "PATCH",
        body: JSON.stringify({ autoPushMode: next }),
      });
      await refresh();
      const label = OPTIONS.find((o) => o.value === next)?.label ?? next;
      toast.success(`EHR auto-push: ${label}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-start gap-3">
        <Send
          className="h-6 w-6 mt-0.5 text-(--color-muted-foreground)"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-lg font-medium">EHR auto-push</h2>
          <p className="text-sm text-(--color-muted-foreground)">
            When notes ship to your EHR. Push failures don't undo
            anything — you can retry from the note page.
          </p>
        </div>
      </div>
      <ul
        className="grid gap-2"
        role="radiogroup"
        aria-label="EHR auto-push mode"
      >
        {OPTIONS.map((opt) => {
          const selected = opt.value === current;
          return (
            <li key={opt.value}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={busy}
                onClick={() => void pick(opt.value)}
                className={
                  selected
                    ? "w-full rounded-md border-2 border-(--color-primary) bg-(--color-primary)/5 px-4 py-3 text-left"
                    : "w-full rounded-md border border-(--color-border) bg-(--color-card) px-4 py-3 text-left hover:bg-(--color-muted) disabled:opacity-50"
                }
              >
                <div className="font-medium">{opt.label}</div>
                <div className="mt-0.5 text-sm text-(--color-muted-foreground)">
                  {opt.description}
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
