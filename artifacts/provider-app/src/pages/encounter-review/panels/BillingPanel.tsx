// Billing panel: AI-suggested codes grouped by code system, plus the
// "approved codes" rail with per-row send-to-EHR. Owns local busy-id
// state for in-flight mutations and threads onChanged() back to the
// page so the billing query re-fetches.

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Loader2,
  ReceiptText,
  RotateCcw,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  approveSuggestion,
  rejectSuggestion,
  retryBillingCodePush,
  sendBillingCodeToEhr,
  suggestBilling,
} from "../api";
import {
  CODE_SYSTEM_LABEL,
  CODE_SYSTEM_ORDER,
  CONFIDENCE_TONE,
} from "../constants";
import type { BillingResponse, BillingSuggestion, CodeSystem } from "../types";

interface Props {
  encounterId: string;
  billing: BillingResponse | null;
  loading: boolean;
  onChanged: () => void;
}

export function BillingPanel({
  encounterId,
  billing,
  loading,
  onChanged,
}: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const suggestMut = useMutation({
    mutationFn: () => suggestBilling(encounterId),
    onSuccess: (res) => {
      toast.success(
        res.source === "ai"
          ? `Generated ${res.data.length} suggestions`
          : `Generated ${res.data.length} suggestions (stub)`,
      );
      onChanged();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Suggest failed"),
  });

  async function handleSendCodeToEhr(codeId: string) {
    setBusyId(codeId);
    try {
      const outcome = await sendBillingCodeToEhr(codeId);
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

  async function handleRetryStrandedCode(codeId: string) {
    setBusyId(codeId);
    try {
      const outcome = await retryBillingCodePush(codeId);
      toast.success(
        outcome.mock ? "Retry succeeded (mock)" : `Retry sent to ${outcome.provider}`,
      );
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setBusyId(null);
    }
  }

  async function handleApprove(s: BillingSuggestion) {
    const blockers = s.documentationGaps.filter((g) => g.severity === "block");
    let ack = false;
    if (blockers.length > 0) {
      const confirmed = window.confirm(
        `This suggestion has ${blockers.length} blocking documentation gap(s):\n\n` +
          blockers.map((g) => `• ${g.message}`).join("\n") +
          "\n\nApprove anyway? The override is logged for audit.",
      );
      if (!confirmed) return;
      ack = true;
    }
    setBusyId(s.id);
    try {
      await approveSuggestion(s.id, ack);
      toast.success(`Approved ${s.code}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(s: BillingSuggestion) {
    const reason = window.prompt(`Reject ${s.code} — reason for audit:`, "");
    if (!reason || !reason.trim()) return;
    setBusyId(s.id);
    try {
      await rejectSuggestion(s.id, reason.trim());
      toast.success(`Rejected ${s.code}`);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reject failed");
    } finally {
      setBusyId(null);
    }
  }

  // Group suggestions by code system for the rendered sections; preserve
  // the codeSystem ordering above so providers see E&M first.
  const groups = useMemo(() => {
    const map = new Map<CodeSystem, BillingSuggestion[]>();
    for (const sys of CODE_SYSTEM_ORDER) map.set(sys, []);
    for (const s of billing?.suggestions ?? []) {
      const arr = map.get(s.codeSystem);
      if (arr) arr.push(s);
    }
    return map;
  }, [billing?.suggestions]);

  const hasAny = (billing?.suggestions.length ?? 0) > 0;
  const approved = billing?.approvedCodes ?? [];

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ReceiptText
            className="h-5 w-5 text-(--color-muted-foreground)"
            aria-hidden="true"
          />
          <h2 className="text-lg font-medium">Billing</h2>
          {hasAny ? (
            <span className="text-sm text-(--color-muted-foreground)">
              {billing?.suggestions.length} suggested · {approved.length} approved
            </span>
          ) : null}
        </div>
        <Button
          size="sm"
          variant={hasAny ? "outline" : "default"}
          onClick={() => suggestMut.mutate()}
          disabled={suggestMut.isPending}
        >
          {suggestMut.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          )}
          {hasAny ? "Regenerate suggestions" : "Generate suggestions"}
        </Button>
      </div>
      {loading ? (
        <p className="text-sm text-(--color-muted-foreground)">Loading billing…</p>
      ) : !hasAny ? (
        <p className="text-sm text-(--color-muted-foreground)">
          No suggestions yet. Generate to see AI-proposed codes.
        </p>
      ) : (
        <div className="space-y-5">
          {CODE_SYSTEM_ORDER.map((sys) => {
            const rows = groups.get(sys) ?? [];
            if (rows.length === 0) return null;
            return (
              <section key={sys} className="space-y-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground)">
                  {CODE_SYSTEM_LABEL[sys]}
                </h3>
                <ul className="space-y-2">
                  {rows.map((s) => (
                    <SuggestionRow
                      key={s.id}
                      sug={s}
                      busy={busyId === s.id}
                      onApprove={() => void handleApprove(s)}
                      onReject={() => void handleReject(s)}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
      {approved.length > 0 ? (
        <section className="space-y-2 border-t border-(--color-border) pt-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground)">
            Approved codes
          </h3>
          <ul className="space-y-1.5">
            {approved.map((a) => (
              <li
                key={a.id}
                className="flex flex-wrap items-center gap-3 rounded-md bg-(--color-muted)/50 px-3 py-2 text-sm"
              >
                <CheckCircle2
                  className="h-4 w-4 text-emerald-600"
                  aria-hidden="true"
                />
                <span className="font-mono font-semibold">{a.code}</span>
                <span className="text-(--color-muted-foreground)">
                  {a.description}
                </span>
                <span className="ml-auto text-xs text-(--color-muted-foreground)">
                  {a.exportedAt
                    ? "Exported"
                    : a.billerApprovedAt
                      ? "Biller approved"
                      : "Provider approved"}
                </span>
                {a.billerApprovedAt ? (
                  <Button
                    size="sm"
                    variant={a.exportedAt ? "outline" : undefined}
                    onClick={() => void handleSendCodeToEhr(a.id)}
                    disabled={busyId === a.id}
                  >
                    {busyId === a.id ? (
                      <Loader2
                        className="h-3 w-3 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <Send className="h-3 w-3" aria-hidden="true" />
                    )}
                    {a.exportedAt ? "Re-send" : "Send to EHR"}
                  </Button>
                ) : a.ehrError && !a.exportedAt ? (
                  // Stranded by a failed bulk-approve push. Biller-driven
                  // flow doesn't reach this row (billerApprovedAt is
                  // null), so surface a per-card retry that goes through
                  // /retry-push instead of /send-to-ehr.
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void handleRetryStrandedCode(a.id)}
                    disabled={busyId === a.id}
                  >
                    {busyId === a.id ? (
                      <Loader2
                        className="h-3 w-3 animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <RotateCcw className="h-3 w-3" aria-hidden="true" />
                    )}
                    Retry push
                  </Button>
                ) : null}
                {a.ehrError ? (
                  <span className="basis-full text-xs text-(--color-destructive)">
                    Last push: {a.ehrError}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </Card>
  );
}

function SuggestionRow({
  sug,
  busy,
  onApprove,
  onReject,
}: {
  sug: BillingSuggestion;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const blockers = sug.documentationGaps.filter((g) => g.severity === "block");
  const warns = sug.documentationGaps.filter((g) => g.severity === "warn");
  const isClosed =
    sug.status === "rejected" ||
    sug.status === "provider_approved" ||
    sug.status === "biller_approved" ||
    sug.status === "exported";

  return (
    <li>
      <div
        className={`rounded-md border border-(--color-border) p-3 ${
          isClosed ? "opacity-60" : ""
        }`}
      >
        <div className="flex flex-wrap items-start gap-3">
          <div className="mt-1">
            {sug.status === "rejected" ? (
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
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-base font-semibold">
                {sug.code}
              </span>
              <span className="text-sm text-(--color-foreground)">
                {sug.description}
              </span>
              <span
                className={`text-xs font-medium uppercase tracking-wide ${CONFIDENCE_TONE[sug.confidence]}`}
              >
                {sug.confidence}
              </span>
            </div>
            <p className="text-xs text-(--color-muted-foreground)">
              {sug.rationale}
            </p>
            {blockers.length > 0 ? (
              <div className="flex flex-wrap items-start gap-1 text-xs text-red-800">
                <AlertTriangle
                  className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  aria-hidden="true"
                />
                <span>
                  Blocks approval: {blockers.map((b) => b.message).join(" · ")}
                </span>
              </div>
            ) : null}
            {warns.length > 0 ? (
              <p className="text-xs text-amber-800">
                {warns.map((w) => w.message).join(" · ")}
              </p>
            ) : null}
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
