import { useState } from "react";
import { ClipboardList, Pill } from "lucide-react";
import { toast } from "sonner";
import { customFetch } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { Card } from "@/components/ui/card";

interface UpdateMeResponse {
  autoPushOrders?: boolean;
  autoPushMedications?: boolean;
}

// Per-provider toggles that govern what happens at the
// "Mark export-ready" step on an approved order. When ON, the same
// request that flips the order to export_ready also pushes it to the
// EHR — collapsing the usual two-tap "ready, send" flow to one.
//
// Medications get their own toggle by design: a provider may want
// labs and imaging to fly through automatically but hand-confirm
// every prescription. Both default off so the existing manual flow
// keeps working until the provider opts in.
export function OrdersAutoPushSection() {
  const { user, refresh } = useAuth();
  const [busyKey, setBusyKey] = useState<
    "autoPushOrders" | "autoPushMedications" | null
  >(null);

  async function toggle(
    field: "autoPushOrders" | "autoPushMedications",
    next: boolean,
  ) {
    setBusyKey(field);
    try {
      await customFetch<UpdateMeResponse>("/api/auth/me", {
        method: "PATCH",
        body: JSON.stringify({ [field]: next }),
      });
      await refresh();
      const label =
        field === "autoPushOrders" ? "Orders" : "Medication orders";
      toast.success(
        next
          ? `${label} will push to your EHR on mark export-ready.`
          : `${label} will wait for a manual Send to EHR.`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update");
    } finally {
      setBusyKey(null);
    }
  }

  const ordersOn = Boolean(user?.autoPushOrders);
  const medsOn = Boolean(user?.autoPushMedications);

  return (
    <Card className="p-6 space-y-5">
      <header className="space-y-1">
        <h2 className="text-lg font-medium">Auto-push for orders</h2>
        <p className="text-sm text-(--color-muted-foreground)">
          When on, marking an order export-ready also pushes it to your
          EHR — one tap instead of two. Push failures don't roll back
          the export-ready state; you can retry from the order row.
        </p>
      </header>

      <Row
        icon={<ClipboardList className="h-5 w-5" aria-hidden="true" />}
        title="Orders (labs, imaging, referrals, …)"
        description="Applies to every order type EXCEPT medications. Medications have their own toggle below."
        enabled={ordersOn}
        busy={busyKey === "autoPushOrders"}
        onToggle={(v) => void toggle("autoPushOrders", v)}
      />

      <Row
        icon={<Pill className="h-5 w-5" aria-hidden="true" />}
        title="Medication orders"
        description="Independent from the general orders toggle. Off by default — most providers hand-confirm every prescription."
        enabled={medsOn}
        busy={busyKey === "autoPushMedications"}
        onToggle={(v) => void toggle("autoPushMedications", v)}
      />
    </Card>
  );
}

function Row({
  icon,
  title,
  description,
  enabled,
  busy,
  onToggle,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  enabled: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 text-(--color-muted-foreground)">
        {icon}
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="font-medium">{title}</div>
        <p className="text-sm text-(--color-muted-foreground)">
          {description}
        </p>
      </div>
      <label className="inline-flex shrink-0 items-center gap-2 text-sm">
        <span className="sr-only">Toggle {title}</span>
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy}
          onChange={(e) => onToggle(e.target.checked)}
          className="h-5 w-5 cursor-pointer accent-(--color-primary)"
          aria-label={`Auto-push ${title}`}
        />
        <span aria-hidden="true" className="font-medium">
          {enabled ? "On" : "Off"}
        </span>
      </label>
    </div>
  );
}
