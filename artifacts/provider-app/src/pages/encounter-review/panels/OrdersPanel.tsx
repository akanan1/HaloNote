// Orders panel: AI suggestions on top, approved orders below with inline
// medication-completion form + per-row mark-export-ready / send-to-EHR
// actions. Co-locates the small presentational helpers (OrderTypePill,
// PriorityPill, MedicationSummary, MedField, SafetyList) and the row
// renderers; CompleteMedicationForm + Field stay alongside since they're
// only used here.

import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Loader2,
  Pill,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  approveOrderSuggestion,
  markOrderExportReady,
  patchOrder,
  rejectOrderSuggestion,
  sendOrderToEhr,
  suggestOrders,
} from "../api";
import {
  APPROVED_ORDER_STATUS_LABEL,
  ORDER_PRIORITY_TONE,
  ORDER_TYPE_LABEL,
} from "../constants";
import { requiresMedicationDetails } from "../helpers";
import type {
  ApprovedOrder,
  MedicationPatch,
  OrderCommon,
  OrderPriority,
  OrderSuggestion,
  OrderType,
  OrdersResponse,
  SafetyWarning,
} from "../types";

interface Props {
  encounterId: string;
  orders: OrdersResponse | null;
  loading: boolean;
  onChanged: () => void;
}

export function OrdersPanel({ encounterId, orders, loading, onChanged }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const suggestMut = useMutation({
    mutationFn: () => suggestOrders(encounterId),
    onSuccess: (res) => {
      toast.success(
        res.source === "ai"
          ? `Generated ${res.data.length} order suggestions`
          : `Generated ${res.data.length} order suggestions (stub)`,
      );
      onChanged();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Suggest failed"),
  });

  async function handleApprove(s: OrderSuggestion) {
    setBusyId(s.id);
    try {
      await approveOrderSuggestion(s.id);
      toast.success(`Approved ${s.name}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(s: OrderSuggestion) {
    const reason = window.prompt(`Reject "${s.name}" — reason for audit:`, "");
    if (!reason || !reason.trim()) return;
    setBusyId(s.id);
    try {
      await rejectOrderSuggestion(s.id, reason.trim());
      toast.success("Order rejected");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reject failed");
    } finally {
      setBusyId(null);
    }
  }

  const hasSugg = (orders?.suggestions.length ?? 0) > 0;
  const approved = orders?.approvedOrders ?? [];

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Pill
            className="h-5 w-5 text-(--color-muted-foreground)"
            aria-hidden="true"
          />
          <h2 className="text-lg font-medium">Orders</h2>
          {orders ? (
            <span className="text-sm text-(--color-muted-foreground)">
              {orders.suggestions.length} suggested · {approved.length} approved
            </span>
          ) : null}
        </div>
        <Button
          size="sm"
          variant={hasSugg ? "outline" : "default"}
          onClick={() => suggestMut.mutate()}
          disabled={suggestMut.isPending}
        >
          {suggestMut.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          )}
          {hasSugg ? "Regenerate suggestions" : "Generate suggestions"}
        </Button>
      </div>
      {loading ? (
        <p className="text-sm text-(--color-muted-foreground)">Loading orders…</p>
      ) : !hasSugg && approved.length === 0 ? (
        <p className="text-sm text-(--color-muted-foreground)">
          No orders yet. Generate to see AI-proposed orders or add a manual order
          via the API.
        </p>
      ) : null}
      {hasSugg ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground)">
            Suggestions
          </h3>
          <ul className="space-y-2">
            {orders!.suggestions.map((s) => (
              <OrderSuggestionRow
                key={s.id}
                ord={s}
                busy={busyId === s.id}
                onApprove={() => void handleApprove(s)}
                onReject={() => void handleReject(s)}
              />
            ))}
          </ul>
        </section>
      ) : null}
      {approved.length > 0 ? (
        <section className="space-y-2 border-t border-(--color-border) pt-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground)">
            Approved orders
          </h3>
          <ul className="space-y-2">
            {approved.map((o) => (
              <ApprovedOrderRow
                key={o.id}
                ord={o}
                busy={busyId === o.id}
                onChanged={onChanged}
                setBusyId={setBusyId}
              />
            ))}
          </ul>
        </section>
      ) : null}
    </Card>
  );
}

function OrderTypePill({ t }: { t: OrderType }) {
  return (
    <span className="inline-flex rounded-full bg-(--color-muted) px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-(--color-border)">
      {ORDER_TYPE_LABEL[t]}
    </span>
  );
}

function PriorityPill({ p }: { p: OrderPriority }) {
  if (p === "routine") return null;
  return (
    <span
      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium uppercase ring-1 ring-inset ${ORDER_PRIORITY_TONE[p]}`}
    >
      {p}
    </span>
  );
}

function MedicationSummary({ ord }: { ord: OrderCommon }) {
  if (!requiresMedicationDetails(ord.orderType)) return null;
  // Compact one-liner for non-mutation contexts (suggestion + approved).
  // Missing fields render as em-dash so the gap is visually obvious.
  const em = (v: string | number | null) =>
    v == null || v === "" ? "—" : String(v);
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-(--color-muted)/40 px-3 py-2 text-xs sm:grid-cols-4">
      <MedField label="Dose" value={em(ord.medicationDose)} />
      <MedField label="Route" value={em(ord.medicationRoute)} />
      <MedField label="Frequency" value={em(ord.medicationFrequency)} />
      <MedField label="Duration" value={em(ord.medicationDuration)} />
      <MedField label="Quantity" value={em(ord.medicationQuantity)} />
      <MedField label="Refills" value={em(ord.medicationRefills)} />
    </dl>
  );
}

function MedField({ label, value }: { label: string; value: string }) {
  const missing = value === "—";
  return (
    <div>
      <dt className="uppercase tracking-wide text-(--color-muted-foreground)">
        {label}
      </dt>
      <dd
        className={
          missing
            ? "font-medium text-(--color-destructive)"
            : "font-medium text-(--color-foreground)"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function SafetyList({ warnings }: { warnings: SafetyWarning[] }) {
  if (warnings.length === 0) return null;
  const blockers = warnings.filter((w) => w.severity === "block");
  const warns = warnings.filter((w) => w.severity === "warn");
  const infos = warnings.filter((w) => w.severity === "info");
  return (
    <div className="space-y-1 text-xs">
      {blockers.length > 0 ? (
        <div className="flex items-start gap-1 text-red-800">
          <AlertTriangle
            className="mt-0.5 h-3.5 w-3.5 shrink-0"
            aria-hidden="true"
          />
          <span>{blockers.map((b) => b.message).join(" · ")}</span>
        </div>
      ) : null}
      {warns.length > 0 ? (
        <p className="text-amber-800">{warns.map((w) => w.message).join(" · ")}</p>
      ) : null}
      {infos.length > 0 ? (
        <p className="text-(--color-muted-foreground)">
          {infos.map((w) => w.message).join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

function OrderSuggestionRow({
  ord,
  busy,
  onApprove,
  onReject,
}: {
  ord: OrderSuggestion;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const isClosed =
    ord.status === "approved" ||
    ord.status === "rejected" ||
    ord.status === "exported";
  return (
    <li>
      <div
        className={`rounded-md border border-(--color-border) p-3 ${
          isClosed ? "opacity-60" : ""
        }`}
      >
        <div className="flex flex-wrap items-start gap-3">
          <div className="mt-1">
            {ord.status === "rejected" ? (
              <X
                className="h-5 w-5 text-(--color-muted-foreground)"
                aria-hidden="true"
              />
            ) : isClosed ? (
              <CheckCircle2
                className="h-5 w-5 text-emerald-600"
                aria-hidden="true"
              />
            ) : (
              <CircleDashed
                className="h-5 w-5 text-(--color-muted-foreground)"
                aria-hidden="true"
              />
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <OrderTypePill t={ord.orderType} />
              <PriorityPill p={ord.priority} />
              <span className="text-base font-medium">{ord.name}</span>
            </div>
            {ord.indication ? (
              <p className="text-xs text-(--color-muted-foreground)">
                Indication: {ord.indication}
                {ord.indicationDiagnosisCode
                  ? ` · ${ord.indicationDiagnosisCode}`
                  : ""}
              </p>
            ) : null}
            <MedicationSummary ord={ord} />
            <p className="text-xs text-(--color-muted-foreground)">
              {ord.rationale}
            </p>
            <SafetyList warnings={ord.safetyWarnings} />
          </div>
          {!isClosed ? (
            <div className="flex shrink-0 items-center gap-2">
              {busy ? (
                <Loader2
                  className="h-4 w-4 animate-spin text-(--color-muted-foreground)"
                  aria-hidden="true"
                />
              ) : null}
              <Button size="sm" onClick={onApprove} disabled={busy}>
                Approve
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onReject}
                disabled={busy}
              >
                Reject
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function ApprovedOrderRow({
  ord,
  busy,
  onChanged,
  setBusyId,
}: {
  ord: ApprovedOrder;
  busy: boolean;
  onChanged: () => void;
  setBusyId: (id: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const showCompleteCta =
    !ord.isComplete &&
    requiresMedicationDetails(ord.orderType) &&
    ord.status === "approved";

  async function handleExportReady() {
    setBusyId(ord.id);
    try {
      await markOrderExportReady(ord.id);
      toast.success("Marked export ready");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't mark ready");
    } finally {
      setBusyId(null);
    }
  }

  async function handleSendToEhr() {
    setBusyId(ord.id);
    try {
      const outcome = await sendOrderToEhr(ord.id);
      toast.success(
        outcome.mock ? "Sent to EHR (mock)" : `Sent to ${outcome.provider}`,
      );
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "EHR push failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <li>
      <div className="space-y-2 rounded-md border border-(--color-border) bg-(--color-card) p-3">
        <div className="flex flex-wrap items-start gap-3">
          <CheckCircle2
            className="mt-1 h-5 w-5 text-emerald-600"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <OrderTypePill t={ord.orderType} />
              <PriorityPill p={ord.priority} />
              <span className="text-base font-medium">{ord.name}</span>
              <span className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
                {APPROVED_ORDER_STATUS_LABEL[ord.status]}
              </span>
            </div>
            <MedicationSummary ord={ord} />
            <SafetyList warnings={ord.safetyWarnings} />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {busy ? (
              <Loader2
                className="h-4 w-4 animate-spin text-(--color-muted-foreground)"
                aria-hidden="true"
              />
            ) : null}
            {showCompleteCta ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setEditing((v) => !v)}
                disabled={busy}
              >
                {editing ? "Close" : "Complete details"}
              </Button>
            ) : null}
            {ord.status === "approved" ? (
              <Button
                size="sm"
                onClick={() => void handleExportReady()}
                disabled={busy || !ord.isComplete}
                title={
                  !ord.isComplete
                    ? "Resolve the blocking safety warnings before marking export-ready"
                    : undefined
                }
              >
                <Send className="h-4 w-4" aria-hidden="true" />
                Mark export-ready
              </Button>
            ) : null}
            {ord.status === "export_ready" || ord.status === "exported" ? (
              <Button
                size="sm"
                variant={ord.status === "exported" ? "outline" : undefined}
                onClick={() => void handleSendToEhr()}
                disabled={busy}
              >
                <Send className="h-4 w-4" aria-hidden="true" />
                {ord.status === "exported" ? "Re-send" : "Send to EHR"}
              </Button>
            ) : null}
          </div>
        </div>
        {editing && requiresMedicationDetails(ord.orderType) ? (
          <CompleteMedicationForm
            ord={ord}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false);
              onChanged();
            }}
          />
        ) : null}
      </div>
    </li>
  );
}

// Inline form to fill in the structured medication fields for an order
// whose AI suggester (or manual create) couldn't supply them. Only the
// fields the spec flags as required for export-ready show as required;
// quantity / refills are optional but recommended.
function CompleteMedicationForm({
  ord,
  onCancel,
  onSaved,
}: {
  ord: ApprovedOrder;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(ord.medicationName ?? ord.name);
  const [dose, setDose] = useState(ord.medicationDose ?? "");
  const [route, setRoute] = useState(ord.medicationRoute ?? "");
  const [frequency, setFrequency] = useState(ord.medicationFrequency ?? "");
  const [duration, setDuration] = useState(ord.medicationDuration ?? "");
  const [quantity, setQuantity] = useState<string>(
    ord.medicationQuantity != null ? String(ord.medicationQuantity) : "",
  );
  const [refills, setRefills] = useState<string>(
    ord.medicationRefills != null ? String(ord.medicationRefills) : "",
  );

  const save = useMutation({
    mutationFn: (patch: MedicationPatch) => patchOrder(ord.id, patch),
    onSuccess: () => {
      toast.success("Medication details saved");
      onSaved();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Couldn't save"),
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const patch: MedicationPatch = {
      medicationName: name.trim() || null,
      medicationDose: dose.trim() || null,
      medicationRoute: route.trim() || null,
      medicationFrequency: frequency.trim() || null,
      medicationDuration: duration.trim() || null,
      medicationQuantity: quantity.trim() ? Number(quantity) : null,
      medicationRefills: refills.trim() ? Number(refills) : null,
    };
    save.mutate(patch);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-3 rounded-md border border-(--color-border) bg-(--color-muted)/30 p-3"
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
        <Field label="Medication" value={name} onChange={setName} required />
        <Field
          label="Dose"
          value={dose}
          onChange={setDose}
          required
          placeholder="500 mg"
        />
        <Field
          label="Route"
          value={route}
          onChange={setRoute}
          required
          placeholder="PO"
        />
        <Field
          label="Frequency"
          value={frequency}
          onChange={setFrequency}
          required
          placeholder="BID"
        />
        <Field
          label="Duration"
          value={duration}
          onChange={setDuration}
          required
          placeholder="30 days"
        />
        <div />
        <Field
          label="Quantity"
          value={quantity}
          onChange={setQuantity}
          type="number"
          placeholder="60"
        />
        <Field
          label="Refills"
          value={refills}
          onChange={setRefills}
          type="number"
          placeholder="3"
        />
      </div>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          Save details
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  value,
  onChange,
  required,
  placeholder,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  placeholder?: string;
  type?: string;
}) {
  const id = `field-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>
        {label}
        {required ? (
          <span className="ml-0.5 text-(--color-destructive)">*</span>
        ) : null}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
      />
    </div>
  );
}
