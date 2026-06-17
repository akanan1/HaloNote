import { useState } from "react";
import { Timer } from "lucide-react";
import { toast } from "sonner";
import { customFetch } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { Card } from "@/components/ui/card";

// Preset options that cover the realistic range. Open-ended input would
// invite typos and a 9-hour visit timer.
const PRESETS = [
  { value: 0, label: "Off" },
  { value: 30, label: "30 sec" },
  { value: 45, label: "45 sec" },
  { value: 60, label: "1 min" },
  { value: 90, label: "1.5 min" },
  { value: 120, label: "2 min" },
];

// Per-provider preference: how many seconds of microphone silence end
// the recording. 0 disables. The threshold approximates "doctor walked
// out of the room" without needing a live transcript — Phase 22.
export function SilenceAutoStopSection() {
  const { user, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const current = user?.silenceAutoStopSec ?? 0;

  async function update(next: number) {
    if (next === current) return;
    setBusy(true);
    try {
      await customFetch("/api/auth/me", {
        method: "PATCH",
        body: JSON.stringify({ silenceAutoStopSec: next }),
      });
      await refresh();
      toast.success(
        next === 0
          ? "Silence auto-stop disabled."
          : `Recording will stop after ${next}s of silence.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-6 space-y-4">
      <div className="flex items-start gap-3">
        <Timer
          className="h-6 w-6 mt-0.5 text-(--color-muted-foreground)"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-lg font-medium">Auto-stop on silence</h2>
          <p className="text-sm text-(--color-muted-foreground)">
            Stop recording automatically when the room goes quiet for
            this long. Use it to capture the visit hands-free — the
            recorder ends on its own when you step out. Off by default.
          </p>
        </div>
      </div>
      <div
        className="flex flex-wrap gap-2"
        role="radiogroup"
        aria-label="Silence auto-stop duration"
      >
        {PRESETS.map((p) => {
          const selected = p.value === current;
          return (
            <button
              key={p.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={busy}
              onClick={() => void update(p.value)}
              className={
                selected
                  ? "rounded-md border border-(--color-primary) bg-(--color-primary) px-3 py-1.5 text-sm font-medium text-(--color-primary-foreground)"
                  : "rounded-md border border-(--color-border) bg-(--color-card) px-3 py-1.5 text-sm hover:bg-(--color-muted) disabled:opacity-50"
              }
            >
              {p.label}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
