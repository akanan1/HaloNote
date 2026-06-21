// Coder Review panel — the container. Owns:
//   - The session-level layout (header, status pill, stats line, banner)
//   - The session-level mutations (Run / Re-run, Refine all, Approve and Write)
//   - The per-row edit state (shared across SuggestionCards)
//
// Sub-components (one file each in ./coder/) own their own:
//   - EncounterLinkBanner — Athena chart linking
//   - AthenaIngestSection — empty-state Athena DocumentReference picker
//   - ProblemListSection  — problem-list reconciler section
//   - RefineAllMatrix     — bulk refinement overview
//   - SuggestionCard      — per-row code card (with per-card Refine inline)

import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertTriangle,
  Brain,
  Check,
  Loader2,
  RefreshCcw,
  Sparkles,
  Wand2,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  approveAllHighConfidenceCoding,
  editCodingSuggestion,
  generateCoding,
  refineAllInSession,
} from "../api";
import {
  CODE_SYSTEM_LABEL,
  CODE_SYSTEM_ORDER,
  CODING_SESSION_STATUS_LABEL,
  CODING_SESSION_STATUS_TONE,
} from "../constants";
import type {
  CodeSystem,
  CodingSessionWithSuggestions,
  CodingSuggestion,
  RefineAllResponse,
} from "../types";
import { AthenaIngestSection } from "./coder/AthenaIngestSection";
import { EncounterLinkBanner } from "./coder/EncounterLinkBanner";
import { ProblemListSection } from "./coder/ProblemListSection";
import { RefineAllMatrix } from "./coder/RefineAllMatrix";
import { SuggestionCard } from "./coder/SuggestionCard";

interface Props {
  encounterId: string;
  patientId: string;
  // The encounter's persisted EHR ref (Encounter/<id>) — null when the
  // encounter hasn't been linked to its Athena chart entry. Real-mode
  // billing/order pushes require this; we surface a clear warning when
  // missing so the provider knows the issue *before* clicking Approve.
  encounterEhrRef: string | null;
  coding: CodingSessionWithSuggestions | null;
  loading: boolean;
  onChanged: () => void;
}

export function CoderReviewPanel({
  encounterId,
  patientId,
  encounterEhrRef,
  coding,
  loading,
  onChanged,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCode, setEditCode] = useState("");
  const [editDescription, setEditDescription] = useState("");

  const generateMut = useMutation({
    mutationFn: () => generateCoding(encounterId),
    onSuccess: (res) => {
      toast.success(
        `Generated ${res.suggestions.length} coding suggestion${res.suggestions.length === 1 ? "" : "s"}`,
      );
      onChanged();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Generate failed"),
  });

  const approveAllMut = useMutation({
    mutationFn: () => {
      if (!coding) throw new Error("No coding session");
      return approveAllHighConfidenceCoding(coding.session.id);
    },
    onSuccess: (res) => {
      if (res.approvedCount === 0) {
        toast.warning(
          "No suggestions met the high-confidence threshold — review individually.",
        );
      } else {
        const parts: string[] = [
          `Approved ${res.approvedCount} code${res.approvedCount === 1 ? "" : "s"}`,
        ];
        if (res.pushedBillingCount > 0) {
          parts.push(`pushed ${res.pushedBillingCount} to EHR`);
        }
        if (res.pushedOrderCount > 0) {
          parts.push(
            `${res.pushedOrderCount} order${res.pushedOrderCount === 1 ? "" : "s"} sent`,
          );
        }
        if (res.skippedCount > 0) {
          parts.push(`${res.skippedCount} need individual review`);
        }
        if (res.pushFailedCount > 0) {
          parts.push(
            `${res.pushFailedCount} EHR push${res.pushFailedCount === 1 ? "" : "es"} failed (retry from row)`,
          );
          toast.warning(parts.join(" · "));
        } else {
          toast.success(parts.join(" · "));
        }
      }
      onChanged();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Bulk approve failed"),
  });

  const editMut = useMutation({
    mutationFn: (vars: { id: string; code: string; description: string }) =>
      editCodingSuggestion(vars.id, {
        editedCode: vars.code,
        editedDescription: vars.description,
      }),
    onSuccess: () => {
      toast.success("Suggestion updated");
      setEditingId(null);
      setEditCode("");
      setEditDescription("");
      onChanged();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Edit failed"),
  });

  // Refine-all: lazy bulk refine across the session. Held in panel state
  // so the matrix persists across re-renders and the user can bulk-accept
  // HCC-unlocks from a single overview.
  const [refineAllOpen, setRefineAllOpen] = useState(false);
  const [refineAllResult, setRefineAllResult] =
    useState<RefineAllResponse | null>(null);
  const refineAllMut = useMutation({
    mutationFn: () => {
      if (!coding) throw new Error("No coding session");
      return refineAllInSession(coding.session.id);
    },
    onSuccess: (res) => {
      setRefineAllResult(res);
      setRefineAllOpen(true);
      const itemsWithOptions = res.items.filter(
        (i) => i.options.length > 0,
      ).length;
      if (res.hccUnlockCount > 0) {
        toast.success(
          `${res.hccUnlockCount} HCC unlock${res.hccUnlockCount === 1 ? "" : "s"} available across ${itemsWithOptions} code${itemsWithOptions === 1 ? "" : "s"}`,
        );
      } else if (itemsWithOptions > 0) {
        toast.success(
          `${itemsWithOptions} code${itemsWithOptions === 1 ? "" : "s"} have refinement suggestions`,
        );
      } else {
        toast.warning(
          "No refinements found — all codes are already well-supported or no plausible refinement exists",
        );
      }
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Refine-all failed"),
  });

  const grouped = useMemo(() => {
    const map = new Map<CodeSystem, CodingSuggestion[]>();
    if (coding) {
      for (const s of coding.suggestions) {
        const list = map.get(s.codeSystem) ?? [];
        list.push(s);
        map.set(s.codeSystem, list);
      }
    }
    return map;
  }, [coding]);

  const stats = useMemo(() => {
    if (!coding) return { total: 0, high: 0, hcc: 0, raf: 0, gaps: 0 };
    let high = 0;
    let hcc = 0;
    let raf = 0;
    let gaps = 0;
    for (const s of coding.suggestions) {
      if (s.confidence === "high") high += 1;
      if (s.hccCategory) hcc += 1;
      if (s.rafRelevant) raf += 1;
      if (s.documentationGaps.some((g) => g.severity === "block")) gaps += 1;
    }
    return { total: coding.suggestions.length, high, hcc, raf, gaps };
  }, [coding]);

  function startEdit(s: CodingSuggestion) {
    setEditingId(s.id);
    setEditCode(s.editedCode ?? s.code);
    setEditDescription(s.editedDescription ?? s.description);
  }

  if (loading) {
    return (
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm text-(--color-muted-foreground)">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading Coder…
        </div>
      </Card>
    );
  }

  // Empty state — note not yet approved (no session) or approval hasn't
  // yet triggered the background extraction. Show a clear primary action,
  // plus the Athena-existing path for practices that documented in Athena.
  if (!coding) {
    return (
      <Card className="space-y-3 p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Brain className="h-4 w-4" aria-hidden />
              Coder Review
            </h2>
            <p className="text-sm text-(--color-muted-foreground)">
              The Coder runs automatically when the note is finalized. You can
              also generate suggestions on demand from the current note body,
              or ingest a finalized note from Athena.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => generateMut.mutate()}
            disabled={generateMut.isPending}
          >
            {generateMut.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Running…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Run Coder
              </>
            )}
          </Button>
        </div>
        <AthenaIngestSection
          encounterId={encounterId}
          patientId={patientId}
          onIngested={onChanged}
        />
      </Card>
    );
  }

  const session = coding.session;
  const statusLabel = CODING_SESSION_STATUS_LABEL[session.status];
  const statusTone = CODING_SESSION_STATUS_TONE[session.status];
  const isExtracting =
    session.status === "queued" || session.status === "extracting";
  // ready/approved are the green-path states; failed/complete are
  // explicitly allowed because bulk-approve is idempotent + retries
  // failed pushes (see services/coding-approval.ts).
  const canBulkApprove =
    session.status === "ready" ||
    session.status === "approved" ||
    session.status === "failed" ||
    session.status === "complete";

  return (
    <Card className="space-y-5 p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Brain className="h-4 w-4" aria-hidden />
            Coder Review
            <span
              className={`ml-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 ${statusTone}`}
            >
              {isExtracting && <Loader2 className="h-3 w-3 animate-spin" />}
              {statusLabel}
            </span>
          </h2>
          <p className="flex flex-wrap items-center gap-2 text-sm text-(--color-muted-foreground)">
            <span>
              {stats.total} suggestion{stats.total === 1 ? "" : "s"} ·{" "}
              {stats.high} high-confidence
            </span>
            {stats.hcc > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-900 ring-1 ring-emerald-300">
                <Zap className="h-3 w-3" />
                {stats.hcc} HCC opportunit{stats.hcc === 1 ? "y" : "ies"}
                {stats.raf > 0 &&
                  stats.raf < stats.hcc &&
                  ` · ${stats.raf} RAF`}
              </span>
            )}
            {stats.gaps > 0 && (
              <span className="text-amber-700">
                · {stats.gaps} blocking gap{stats.gaps === 1 ? "" : "s"}
              </span>
            )}
            {session.noteSource === "athena_existing" && (
              <span className="rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-900 ring-1 ring-blue-200">
                from Athena
              </span>
            )}
          </p>
          {session.failureReason && (
            <div className="flex items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50/60 px-2 py-1 text-sm text-red-900">
              <span>
                <AlertTriangle className="mr-1 inline h-3 w-3" />
                {session.failureReason}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => approveAllMut.mutate()}
                disabled={approveAllMut.isPending}
                title="Re-run bulk approve — idempotent; only retries the failed pushes"
                className="border-red-300 text-red-900 hover:bg-red-100"
              >
                {approveAllMut.isPending ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCcw className="h-3 w-3" />
                )}
                Retry failed pushes
              </Button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => refineAllMut.mutate()}
            disabled={refineAllMut.isPending || isExtracting}
            title="Run the per-code refiner against every ICD-10 / CPT in this session — HCC-aware"
            className="text-violet-700 hover:text-violet-900"
          >
            {refineAllMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Wand2 className="h-4 w-4" />
            )}
            Refine all
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => generateMut.mutate()}
            disabled={generateMut.isPending || isExtracting}
            title="Re-run the Coder against the current note body"
          >
            {generateMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            Re-run
          </Button>
          <Button
            size="sm"
            onClick={() => approveAllMut.mutate()}
            disabled={
              approveAllMut.isPending || !canBulkApprove || stats.total === 0
            }
            title="Promote every high-confidence suggestion to approved_billing_codes"
          >
            {approveAllMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Approve and Write
          </Button>
        </div>
      </header>

      <div className="rounded-md border border-(--color-border) bg-amber-50/40 px-3 py-2 text-xs text-amber-900">
        <AlertTriangle className="mr-1 inline h-3 w-3" />
        Clinician approval is required. Nothing is written to the EHR until you
        approve.
      </div>

      {!encounterEhrRef && (
        <EncounterLinkBanner
          encounterId={encounterId}
          patientId={patientId}
          onLinked={onChanged}
        />
      )}
      {encounterEhrRef && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-xs text-emerald-900">
          <span className="font-medium">Linked to Athena.</span>{" "}
          <span className="font-mono">{encounterEhrRef}</span>
        </div>
      )}

      <ProblemListSection sessionId={session.id} />

      {refineAllOpen && refineAllResult && (
        <RefineAllMatrix
          result={refineAllResult}
          suggestions={coding.suggestions}
          onClose={() => setRefineAllOpen(false)}
          onApplied={() => {
            // Single application doesn't close the matrix — provider is
            // likely working through several rows. We invalidate so the
            // underlying suggestion list refreshes the edited code on screen.
            onChanged();
          }}
        />
      )}

      <div className="space-y-5">
        {CODE_SYSTEM_ORDER.map((cs) => {
          const items = grouped.get(cs) ?? [];
          if (items.length === 0) return null;
          return (
            <section key={cs} className="space-y-2">
              <h3 className="text-sm font-medium text-(--color-foreground)">
                {CODE_SYSTEM_LABEL[cs]}{" "}
                <span className="text-(--color-muted-foreground)">
                  ({items.length})
                </span>
              </h3>
              <ul className="space-y-2">
                {items.map((s) => (
                  <SuggestionCard
                    key={s.id}
                    suggestion={s}
                    isEditing={editingId === s.id}
                    editCode={editCode}
                    editDescription={editDescription}
                    onStartEdit={() => startEdit(s)}
                    onCancelEdit={() => setEditingId(null)}
                    onChangeCode={setEditCode}
                    onChangeDescription={setEditDescription}
                    onSaveEdit={() =>
                      editMut.mutate({
                        id: s.id,
                        code: editCode.trim(),
                        description: editDescription.trim(),
                      })
                    }
                    saving={editMut.isPending && editingId === s.id}
                  />
                ))}
              </ul>
            </section>
          );
        })}

        {stats.total === 0 && (
          <div className="rounded-md border border-dashed border-(--color-border) p-4 text-sm text-(--color-muted-foreground)">
            The Coder didn't find any codable content in this note. Re-run
            after addressing documentation gaps.
          </div>
        )}
      </div>
    </Card>
  );
}
