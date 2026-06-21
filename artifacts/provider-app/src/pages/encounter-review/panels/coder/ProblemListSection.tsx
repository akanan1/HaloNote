// Problem-list reconciliation section. Mounted inside CoderReviewPanel
// once we have a session. Loads its own query keyed on sessionId so a
// manual re-reconcile doesn't have to bust the parent's session cache.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ListPlus, Loader2, RefreshCcw, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  acceptProblemSuggestion,
  fetchProblemSuggestions,
  reconcileProblems,
  rejectProblemSuggestion,
} from "../../api";
import {
  CONFIDENCE_TONE,
  PROBLEM_ACTION_LABEL,
  PROBLEM_ACTION_TONE,
  PROBLEM_STATUS_LABEL,
  PROBLEM_STATUS_TONE,
} from "../../constants";
import type { ProblemListSuggestion } from "../../types";

export function ProblemListSection({ sessionId }: { sessionId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["problem-suggestions", sessionId],
    queryFn: () => fetchProblemSuggestions(sessionId),
  });

  const reconcileMut = useMutation({
    mutationFn: () => reconcileProblems(sessionId),
    onSuccess: (res) => {
      toast.success(
        res.data.length === 0
          ? `No problem-list changes proposed${res.ehrHit ? " (Athena synced)" : ""}`
          : `${res.data.length} problem-list change${res.data.length === 1 ? "" : "s"} proposed`,
      );
      void qc.invalidateQueries({
        queryKey: ["problem-suggestions", sessionId],
      });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Reconcile failed"),
  });

  const acceptMut = useMutation({
    mutationFn: (id: string) => acceptProblemSuggestion(id),
    onSuccess: () => {
      toast.success("Applied to problem list");
      void qc.invalidateQueries({
        queryKey: ["problem-suggestions", sessionId],
      });
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Accept failed"),
  });

  const rejectMut = useMutation({
    mutationFn: (id: string) => {
      const reason = window.prompt("Reason for rejecting?", "");
      if (!reason || reason.trim().length === 0) {
        throw new Error("Reason required");
      }
      return rejectProblemSuggestion(id, reason.trim());
    },
    onSuccess: () => {
      toast.success("Rejected");
      void qc.invalidateQueries({
        queryKey: ["problem-suggestions", sessionId],
      });
    },
    onError: (err) => {
      if (err instanceof Error && err.message === "Reason required") return;
      toast.error(err instanceof Error ? err.message : "Reject failed");
    },
  });

  const suggestions = q.data?.data ?? [];
  const pending = suggestions.filter((s) => s.status === "suggested");

  return (
    <section className="space-y-2 rounded-md border border-(--color-border) bg-(--color-card) p-3">
      <header className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium text-(--color-foreground)">
          <ListPlus className="h-4 w-4" aria-hidden />
          Problem list updates
          {suggestions.length > 0 && (
            <span className="text-(--color-muted-foreground)">
              ({pending.length} pending · {suggestions.length} total)
            </span>
          )}
        </h3>
        <Button
          size="sm"
          variant="outline"
          onClick={() => reconcileMut.mutate()}
          disabled={reconcileMut.isPending}
          title="Re-pull problem list from EHR and re-analyze the note"
        >
          {reconcileMut.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RefreshCcw className="h-4 w-4" />
          )}
          Reconcile
        </Button>
      </header>

      {q.isPending && (
        <p className="text-xs text-(--color-muted-foreground)">
          <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
          Loading…
        </p>
      )}

      {q.data && suggestions.length === 0 && (
        <p className="text-xs text-(--color-muted-foreground)">
          The reconciler hasn't proposed any problem-list changes for this
          encounter. The note may not document any active diagnoses, or all dx
          are already on the chart.
        </p>
      )}

      {suggestions.length > 0 && (
        <ul className="space-y-2">
          {suggestions.map((s) => (
            <ProblemSuggestionCard
              key={s.id}
              suggestion={s}
              onAccept={() => acceptMut.mutate(s.id)}
              onReject={() => rejectMut.mutate(s.id)}
              busy={
                (acceptMut.isPending && acceptMut.variables === s.id) ||
                (rejectMut.isPending && rejectMut.variables === s.id)
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ProblemSuggestionCard({
  suggestion,
  onAccept,
  onReject,
  busy,
}: {
  suggestion: ProblemListSuggestion;
  onAccept: () => void;
  onReject: () => void;
  busy: boolean;
}) {
  const s = suggestion;
  const isPending = s.status === "suggested";
  const actionTone = PROBLEM_ACTION_TONE[s.action];
  const actionLabel = PROBLEM_ACTION_LABEL[s.action];

  return (
    <li className="rounded-md border border-(--color-border) bg-(--color-muted)/30 p-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 ${actionTone}`}
            >
              {actionLabel}
            </span>
            {s.proposedCode && (
              <span className="rounded bg-(--color-card) px-2 py-0.5 font-mono text-sm font-semibold">
                {s.proposedCode}
              </span>
            )}
            {s.proposedStatus && (
              <span
                className={`rounded px-1.5 py-0.5 text-xs ring-1 ${PROBLEM_STATUS_TONE[s.proposedStatus]}`}
              >
                → {PROBLEM_STATUS_LABEL[s.proposedStatus]}
              </span>
            )}
            <span
              className={`text-xs font-medium uppercase tracking-wide ${CONFIDENCE_TONE[s.confidence]}`}
            >
              {s.confidence}
            </span>
            {!isPending && (
              <span className="rounded bg-(--color-muted) px-1.5 py-0.5 text-xs">
                {s.status}
              </span>
            )}
          </div>
          {s.proposedDescription && (
            <p className="text-sm text-(--color-foreground)">
              {s.proposedDescription}
            </p>
          )}
          <p className="text-xs text-(--color-muted-foreground)">
            {s.rationale}
          </p>
          {s.supportingExcerpts.length > 0 && (
            <ul className="space-y-1">
              {s.supportingExcerpts.map((e, idx) => (
                <li
                  key={idx}
                  className="rounded bg-(--color-card) px-2 py-1 text-xs italic text-(--color-foreground)"
                >
                  “{e.text}”
                </li>
              ))}
            </ul>
          )}
          {s.statusNote && (
            <p className="text-xs text-(--color-muted-foreground)">
              Note: {s.statusNote}
            </p>
          )}
        </div>
        {isPending && (
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" onClick={onAccept} disabled={busy}>
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}
              Accept
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={onReject}
              disabled={busy}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </li>
  );
}
