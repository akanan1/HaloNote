// Encounter-scoped audit drilldown. Reverse-chronological list of every
// audit_log event tied to this encounter: status changes, code
// generations, refinements, edits, problem-list accepts, EHR pushes,
// athena links. Renders metadata callouts (push counts, HCC unlocks,
// note source) inline so the auditor doesn't need to expand each row.
//
// Non-admin — same view for providers and billers. Org-scoped on the
// backend so cross-tenant rows can never appear here.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  RefreshCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { fetchEncounterAuditTimeline } from "../api";
import type { EncounterAuditEvent } from "../types";

interface Props {
  encounterId: string;
}

// Friendlier labels for the action verbs we emit from audit-events.ts.
// Fallback to the raw verb for events the middleware emits (which use
// shapes like "list_patient" / "view_note" we don't need to relabel).
const ACTION_LABEL: Record<string, string> = {
  "coder.generate.started": "Coder started",
  "coder.generate.completed": "Coder completed",
  "coder.generate.failed": "Coder failed",
  "coder.suggestion.edited": "Suggestion edited",
  "coder.suggestion.refined.preview": "Refine previewed",
  "coder.suggestion.refined.applied": "Refinement applied",
  "coder.session.bulk_approve": "Bulk approve",
  "coder.session.writeback.completed": "Writeback complete",
  "coder.session.writeback.partial_failure": "Writeback partial failure",
  "coder.ingest.athena_note.completed": "Athena note ingested",
  "coder.ingest.athena_note.failed": "Athena ingest failed",
  "problem_list.reconcile.completed": "Problem list reconciled",
  "problem_list.suggestion.accepted": "Problem accepted",
  "problem_list.suggestion.rejected": "Problem rejected",
  "encounter.athena_link.set": "Linked to Athena encounter",
  "encounter.athena_link.cleared": "Unlinked from Athena",
};

// Tone classes per action prefix so the eye can skim by event type.
function actionTone(action: string): string {
  if (action.endsWith(".failed") || action.endsWith(".partial_failure")) {
    return "bg-red-50 text-red-900 ring-red-200";
  }
  if (
    action === "coder.session.writeback.completed" ||
    action === "problem_list.suggestion.accepted" ||
    action === "coder.suggestion.refined.applied"
  ) {
    return "bg-emerald-50 text-emerald-900 ring-emerald-200";
  }
  if (action.startsWith("encounter.athena_link.")) {
    return "bg-blue-50 text-blue-900 ring-blue-200";
  }
  if (action.startsWith("coder.suggestion.")) {
    return "bg-violet-50 text-violet-900 ring-violet-200";
  }
  if (action.startsWith("problem_list.")) {
    return "bg-(--color-muted) text-(--color-foreground) ring-(--color-border)";
  }
  if (action.startsWith("coder.")) {
    return "bg-amber-50 text-amber-900 ring-amber-200";
  }
  return "bg-(--color-muted) text-(--color-muted-foreground) ring-(--color-border)";
}

// One-line metadata callouts for the most-shipped event types. Keeps
// the row compact while still surfacing the answer to "what changed".
function describeMetadata(event: EncounterAuditEvent): string | null {
  const m = (event.metadata ?? {}) as Record<string, unknown>;
  switch (event.action) {
    case "coder.generate.completed": {
      const c = Number(m["suggestionCount"] ?? 0);
      const hcc = Number(m["hccCodeCount"] ?? 0);
      return `${c} suggestion${c === 1 ? "" : "s"}${hcc > 0 ? ` · ${hcc} HCC` : ""}`;
    }
    case "coder.session.writeback.completed":
    case "coder.session.writeback.partial_failure": {
      const billing = Number(m["pushedBillingCount"] ?? 0);
      const orders = Number(m["pushedOrderCount"] ?? 0);
      const failed = Number(m["pushFailedCount"] ?? 0);
      const parts: string[] = [];
      if (billing > 0) parts.push(`${billing} billing pushed`);
      if (orders > 0) parts.push(`${orders} order${orders === 1 ? "" : "s"} pushed`);
      if (failed > 0) parts.push(`${failed} failed`);
      return parts.join(" · ") || null;
    }
    case "coder.suggestion.edited": {
      const orig = m["originalCode"];
      const edit = m["editedCode"];
      if (typeof orig === "string" && typeof edit === "string") {
        return `${orig} → ${edit}`;
      }
      return null;
    }
    case "coder.suggestion.refined.applied": {
      const orig = m["originalCode"];
      const refined = m["refinedCode"];
      const unlocked = m["hccUnlocked"];
      const head =
        typeof orig === "string" && typeof refined === "string"
          ? `${orig} → ${refined}`
          : null;
      if (unlocked === true) {
        const hcc = m["refinedHccCategory"];
        return `${head ?? ""}${head ? " · " : ""}unlocked ${typeof hcc === "string" ? hcc : "HCC"}`;
      }
      return head;
    }
    case "problem_list.suggestion.accepted":
    case "problem_list.suggestion.rejected": {
      const code = m["proposedCode"];
      const action = m["problemAction"];
      const parts: string[] = [];
      if (typeof action === "string") parts.push(action.replace(/_/g, " "));
      if (typeof code === "string") parts.push(code);
      return parts.join(" · ") || null;
    }
    case "problem_list.reconcile.completed": {
      const total = Number(m["actionCount"] ?? 0);
      return `${total} proposal${total === 1 ? "" : "s"}`;
    }
    case "coder.ingest.athena_note.completed": {
      const ref = m["athenaDocumentReferenceId"];
      return typeof ref === "string" ? `DocRef ${ref}` : null;
    }
    case "encounter.athena_link.set":
    case "encounter.athena_link.cleared": {
      const ref = m["ehrEncounterRef"];
      return typeof ref === "string" ? ref : null;
    }
    default:
      return null;
  }
}

function formatAt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function EncounterAuditPanel({ encounterId }: Props) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["encounter-audit", encounterId],
    queryFn: () => fetchEncounterAuditTimeline(encounterId),
    enabled: open,
  });

  // Group consecutive events with the same action+resourceId+second-
  // bucket so a 20-row bulk-write doesn't dominate the timeline. Each
  // group renders as one row with a "(×N)" counter; expanding the row
  // shows the individual events.
  const events = q.data?.data ?? [];

  const grouped = useMemo(() => {
    const out: Array<{
      key: string;
      head: EncounterAuditEvent;
      items: EncounterAuditEvent[];
    }> = [];
    for (const e of events) {
      const bucket = e.at.slice(0, 19); // second-precision
      const key = `${e.action}|${e.resourceType}|${bucket}|${e.userId ?? ""}`;
      const last = out[out.length - 1];
      if (last && last.key === key) {
        last.items.push(e);
      } else {
        out.push({ key, head: e, items: [e] });
      }
    }
    return out;
  }, [events]);

  return (
    <Card className="space-y-3 p-5">
      <header className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-base font-semibold text-(--color-foreground) hover:text-(--color-primary)"
        >
          {open ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
          <History className="h-4 w-4" aria-hidden />
          Audit timeline
          {q.data && (
            <span className="text-sm font-normal text-(--color-muted-foreground)">
              ({events.length} event{events.length === 1 ? "" : "s"})
            </span>
          )}
        </button>
        {open && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void q.refetch()}
            disabled={q.isFetching}
            title="Refresh"
          >
            {q.isFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCcw className="h-4 w-4" />
            )}
          </Button>
        )}
      </header>

      {open && q.isPending && (
        <p className="flex items-center gap-1 text-xs text-(--color-muted-foreground)">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading…
        </p>
      )}

      {open && q.isError && (
        <p className="text-xs text-red-700">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          {q.error instanceof Error ? q.error.message : "Failed to load"}
        </p>
      )}

      {open && q.data && events.length === 0 && (
        <p className="text-xs text-(--color-muted-foreground)">
          No audit events yet for this encounter. Events appear here once the
          Coder runs, codes are approved, the chart is pushed to Athena, or
          the encounter is linked / updated.
        </p>
      )}

      {open && grouped.length > 0 && (
        <ul className="space-y-1.5">
          {grouped.map((g) => (
            <TimelineRow key={g.key} group={g} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function TimelineRow({
  group,
}: {
  group: {
    key: string;
    head: EncounterAuditEvent;
    items: EncounterAuditEvent[];
  };
}) {
  const [open, setOpen] = useState(false);
  const e = group.head;
  const count = group.items.length;
  const label = ACTION_LABEL[e.action] ?? e.action.replace(/\./g, " · ");
  const tone = actionTone(e.action);
  const summary = describeMetadata(e);

  return (
    <li className="rounded-md border border-(--color-border) bg-(--color-card) p-2 text-xs">
      <div className="flex flex-wrap items-start gap-2">
        <span className="font-mono text-(--color-muted-foreground)">
          {formatAt(e.at)}
        </span>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ring-1 ${tone}`}
        >
          {label}
          {count > 1 && (
            <span className="rounded bg-white/60 px-1 text-[10px] font-bold">
              ×{count}
            </span>
          )}
        </span>
        <span className="text-(--color-foreground)">
          {e.userDisplayName ?? (e.userId ? "(user)" : "(system)")}
        </span>
        {summary && (
          <span className="text-(--color-muted-foreground)">· {summary}</span>
        )}
        {count > 1 || (e.metadata && Object.keys(e.metadata).length > 0) ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto text-(--color-muted-foreground) hover:text-(--color-foreground)"
            aria-label={open ? "Hide details" : "Show details"}
          >
            {open ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
          </button>
        ) : null}
      </div>

      {open && (
        <div className="mt-2 space-y-1 border-t border-(--color-border) pt-2">
          {group.items.map((item) => (
            <details key={item.id} className="text-(--color-muted-foreground)">
              <summary className="cursor-pointer">
                <span className="font-mono">{formatAt(item.at)}</span>
                {item.resourceId && (
                  <span className="ml-2 font-mono">
                    {item.resourceType}/{item.resourceId.slice(0, 20)}
                    {item.resourceId.length > 20 ? "…" : ""}
                  </span>
                )}
              </summary>
              {item.metadata && (
                <pre className="mt-1 overflow-x-auto rounded bg-(--color-muted) p-2 text-[10px]">
                  {JSON.stringify(item.metadata, null, 2)}
                </pre>
              )}
            </details>
          ))}
        </div>
      )}
    </li>
  );
}
