// Biller queue — Coder-coded encounters awaiting (or recently past)
// biller review. One row per encounter session in approved/writing/
// complete state, with per-encounter counts of total / biller-approved
// / exported / edited codes so the biller can prioritize.
//
// Click an encounter to deep-link to that encounter's review page,
// where the existing BillingPanel handles per-code biller approval +
// send-to-EHR. This page is purely the queue view.

import { useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCheck,
  ClipboardCheck,
  Loader2,
  Pencil,
  Send,
} from "lucide-react";
import { customFetch } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import {
  CODING_SESSION_STATUS_LABEL,
  CODING_SESSION_STATUS_TONE,
  VISIT_LABEL,
} from "./encounter-review/constants";
import type {
  CodingSessionStatus,
  VisitType,
} from "./encounter-review/types";

interface BillerQueueRow {
  sessionId: string;
  encounterId: string;
  patientId: string;
  patientFirstName: string;
  patientLastName: string;
  patientMrn: string | null;
  encounterScheduledAt: string | null;
  encounterVisitType: VisitType;
  sessionStatus: CodingSessionStatus;
  approvedAt: string | null;
  totalCodes: number;
  billerApprovedCodes: number;
  exportedCodes: number;
  editedCodes: number;
}

interface BillerQueueResponse {
  data: BillerQueueRow[];
}

async function fetchBillerQueue(): Promise<BillerQueueResponse> {
  return customFetch<BillerQueueResponse>("/api/coding/biller-queue");
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function BillerQueuePage() {
  const q = useQuery({
    queryKey: ["biller-queue"],
    queryFn: fetchBillerQueue,
    refetchInterval: 30_000,
  });

  const stats = useMemo(() => {
    const rows = q.data?.data ?? [];
    let pending = 0;
    let exported = 0;
    let edited = 0;
    for (const r of rows) {
      if (r.billerApprovedCodes < r.totalCodes) pending += 1;
      if (r.exportedCodes > 0) exported += 1;
      if (r.editedCodes > 0) edited += 1;
    }
    return { total: rows.length, pending, exported, edited };
  }, [q.data]);

  return (
    <main id="main-content" className="mx-auto max-w-5xl space-y-5 p-6">
      <header className="space-y-1">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ClipboardCheck className="h-6 w-6" aria-hidden />
          Biller queue
        </h1>
        <p className="text-sm text-(--color-muted-foreground)">
          Encounters coded by Halo Note Coder, awaiting your review. Click an
          encounter to open the full review and approve codes for export.
        </p>
      </header>

      <Card className="grid grid-cols-4 gap-3 p-4 text-sm">
        <Stat label="Encounters" value={stats.total} />
        <Stat label="Awaiting review" value={stats.pending} tone="amber" />
        <Stat label="With edits" value={stats.edited} tone="violet" />
        <Stat label="Exported" value={stats.exported} tone="emerald" />
      </Card>

      {q.isPending && (
        <Card className="flex items-center gap-2 p-5 text-sm text-(--color-muted-foreground)">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading queue…
        </Card>
      )}

      {q.isError && (
        <Card className="flex items-center gap-2 p-5 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4" />
          {q.error instanceof Error ? q.error.message : "Failed to load"}
        </Card>
      )}

      {q.data && q.data.data.length === 0 && (
        <Card className="p-8 text-center text-sm text-(--color-muted-foreground)">
          No encounters waiting for biller review. Coder-coded encounters land
          here once the provider approves the suggestions.
        </Card>
      )}

      {q.data && q.data.data.length > 0 && (
        <Card className="divide-y divide-(--color-border) p-0">
          {q.data.data.map((row) => (
            <BillerQueueRowItem key={row.sessionId} row={row} />
          ))}
        </Card>
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: "amber" | "violet" | "emerald";
}) {
  const toneClass =
    tone === "amber"
      ? "text-amber-700"
      : tone === "violet"
        ? "text-violet-700"
        : tone === "emerald"
          ? "text-emerald-700"
          : "text-(--color-foreground)";
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
        {label}
      </p>
      <p className={`text-2xl font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

function BillerQueueRowItem({ row }: { row: BillerQueueRow }) {
  const allBillerApproved =
    row.billerApprovedCodes === row.totalCodes && row.totalCodes > 0;
  const allExported = row.exportedCodes === row.totalCodes && row.totalCodes > 0;
  const visitLabel =
    VISIT_LABEL[row.encounterVisitType as VisitType] ??
    row.encounterVisitType;

  return (
    <Link
      href={`/patients/${row.patientId}/encounters/${row.encounterId}`}
      className="block p-4 transition-colors hover:bg-(--color-muted)"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-semibold text-(--color-foreground)">
              {row.patientLastName}, {row.patientFirstName}
            </p>
            {row.patientMrn && (
              <span className="text-xs text-(--color-muted-foreground)">
                MRN {row.patientMrn}
              </span>
            )}
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 ${CODING_SESSION_STATUS_TONE[row.sessionStatus]}`}
            >
              {CODING_SESSION_STATUS_LABEL[row.sessionStatus]}
            </span>
          </div>
          <p className="text-xs text-(--color-muted-foreground)">
            {visitLabel}
            {row.encounterScheduledAt && ` · ${formatDate(row.encounterScheduledAt)}`}
            {row.approvedAt && ` · approved ${formatDate(row.approvedAt)}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1 rounded bg-(--color-muted) px-2 py-1">
            {row.totalCodes} code{row.totalCodes === 1 ? "" : "s"}
          </span>
          {row.editedCodes > 0 && (
            <span className="inline-flex items-center gap-1 rounded bg-violet-50 px-2 py-1 text-violet-900 ring-1 ring-violet-200">
              <Pencil className="h-3 w-3" />
              {row.editedCodes} edited
            </span>
          )}
          <span
            className={`inline-flex items-center gap-1 rounded px-2 py-1 ring-1 ${
              allBillerApproved
                ? "bg-emerald-50 text-emerald-900 ring-emerald-200"
                : "bg-amber-50 text-amber-900 ring-amber-200"
            }`}
          >
            <CheckCheck className="h-3 w-3" />
            {row.billerApprovedCodes}/{row.totalCodes} biller-approved
          </span>
          {allExported && (
            <span className="inline-flex items-center gap-1 rounded bg-blue-50 px-2 py-1 text-blue-900 ring-1 ring-blue-200">
              <Send className="h-3 w-3" />
              exported
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}
