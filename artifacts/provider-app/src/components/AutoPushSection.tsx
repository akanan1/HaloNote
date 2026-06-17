import { useState } from "react";
import { Send } from "lucide-react";
import { toast } from "sonner";
import { customFetch } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { Card } from "@/components/ui/card";

interface UpdateMeResponse {
  autoPushToEhr?: boolean;
}

// Per-provider toggle: when on, approving a note also pushes it to
// the EHR in the same request. The reviewer's approval is still the
// gate — we only skip the second tap. Defaults to off so existing
// muscle memory ("approve, then send") keeps working.
export function AutoPushSection() {
  const { user, refresh } = useAuth();
  const [busy, setBusy] = useState(false);
  const enabled = Boolean(user?.autoPushToEhr);

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      await customFetch<UpdateMeResponse>("/api/auth/me", {
        method: "PATCH",
        body: JSON.stringify({ autoPushToEhr: next }),
      });
      await refresh();
      toast.success(
        next
          ? "Auto-push enabled — approving will send to the EHR."
          : "Auto-push disabled — you'll send manually after approving.",
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
        <Send
          className="h-6 w-6 mt-0.5 text-(--color-muted-foreground)"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-lg font-medium">EHR auto-push</h2>
          <p className="text-sm text-(--color-muted-foreground)">
            When on, approving a note immediately pushes it to your EHR.
            You still review and approve — just one tap instead of two.
            Push failures don't roll back the approval; you can retry
            from the note page.
          </p>
        </div>
        {/* Native checkbox styled as a switch — single-purpose, no
            new dep. Disabled while a PATCH is in flight. */}
        <label className="inline-flex shrink-0 items-center gap-2 text-sm">
          <span className="sr-only">Enable EHR auto-push</span>
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => void toggle(e.target.checked)}
            className="h-5 w-5 cursor-pointer accent-(--color-primary)"
            aria-label="Enable EHR auto-push"
          />
          <span aria-hidden="true" className="font-medium">
            {enabled ? "On" : "Off"}
          </span>
        </label>
      </div>
    </Card>
  );
}
