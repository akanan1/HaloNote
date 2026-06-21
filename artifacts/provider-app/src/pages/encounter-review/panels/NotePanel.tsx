// Note panel: shows the note body + drives the three AI-assisted actions
// the provider takes before signing — gap analysis, conversational
// refinement, and approve. Owns local UI state for those actions (toast
// gating, inline editors) but delegates persistence to the API wrappers
// and lets the parent invalidate its queries via `onChanged`.

import { useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { analyzeNoteGaps, approveNote, refineNote } from "../api";
import { NOTE_STATUS_LABEL, NOTE_STATUS_TONE } from "../constants";
import { formatLocalDateTime } from "../helpers";
import type { GapAnalysisResponse, Note, NoteGap } from "../types";

interface Props {
  note: Note | null;
  loading: boolean;
  onChanged: () => void;
  patientId: string;
  encounterId: string;
}

export function NotePanel({
  note,
  loading,
  onChanged,
  patientId,
  encounterId,
}: Props) {
  const [busy, setBusy] = useState(false);
  // Gap analysis is request-driven — we don't persist the result, so
  // it lives in component state and clears on remount. analysis === null
  // means "never run"; an empty gaps array means "run, no gaps."
  const [analysis, setAnalysis] = useState<GapAnalysisResponse | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  // Conversational refinement state. refineOpen toggles the inline input;
  // refining gates double-submits.
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineInstruction, setRefineInstruction] = useState("");
  const [refining, setRefining] = useState(false);

  const approve = async () => {
    if (!note) return;
    setBusy(true);
    try {
      await approveNote(note.id);
      toast.success("Note approved");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setBusy(false);
    }
  };

  const runRefine = async () => {
    if (!note || !refineInstruction.trim()) return;
    setRefining(true);
    try {
      const r = await refineNote(note.id, refineInstruction.trim());
      toast.success(r.changeSummary, { duration: 6000 });
      setRefineInstruction("");
      setRefineOpen(false);
      // The note query re-fetches so the textarea-equivalent <pre>
      // surface shows the new body. Clear any stale gap analysis since
      // the body changed.
      setAnalysis(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Refine failed");
    } finally {
      setRefining(false);
    }
  };

  const runAnalysis = async () => {
    if (!note) return;
    setAnalyzing(true);
    try {
      const r = await analyzeNoteGaps(note.id);
      setAnalysis(r);
      const blockerCount = r.gaps.filter((g) => g.severity === "block").length;
      if (blockerCount > 0) {
        toast.warning(
          `${blockerCount} blocker${blockerCount === 1 ? "" : "s"} found`,
        );
      } else if (r.gaps.length === 0) {
        toast.success("No gaps detected");
      } else {
        toast.message(
          `${r.gaps.length} item${r.gaps.length === 1 ? "" : "s"} to review`,
        );
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Gap analysis failed");
    } finally {
      setAnalyzing(false);
    }
  };

  const blockingGaps =
    analysis?.gaps.filter((g) => g.severity === "block") ?? [];
  const canApprove = note?.status === "draft" && blockingGaps.length === 0;

  // Where the "Record / write note" button goes — the NewNote page reads
  // ?encounterId from the URL and threads it through useNoteAutosave so
  // the resulting draft is linked back to this encounter. autostart=1
  // tells RecordingPanel to fire getUserMedia immediately (the click on
  // this link is the user gesture the browser wants).
  const recordHref = `/patients/${patientId}/notes/new?encounterId=${encodeURIComponent(encounterId)}&autostart=1`;

  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-(--color-muted-foreground)" aria-hidden="true" />
          <h2 className="text-lg font-medium">Note</h2>
          {note ? (
            <span
              className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${NOTE_STATUS_TONE[note.status]}`}
            >
              {NOTE_STATUS_LABEL[note.status]}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {note && note.status === "draft" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRefineOpen((v) => !v)}
              disabled={refining}
              title="Ask the AI to refine the note ('make assessment shorter', 'soften the tone', etc.)"
            >
              <Sparkles className="h-4 w-4" aria-hidden="true" />
              Refine with AI
            </Button>
          ) : null}
          {note && note.status === "draft" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void runAnalysis()}
              disabled={analyzing}
              title="Run an AI completeness check on the note"
            >
              {analyzing ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Sparkles className="h-4 w-4" aria-hidden="true" />
              )}
              {analysis ? "Re-analyze" : "Analyze gaps"}
            </Button>
          ) : null}
          {note && note.status === "draft" ? (
            <Button
              size="sm"
              onClick={() => void approve()}
              disabled={busy || !canApprove}
              title={
                !canApprove
                  ? "Resolve the block-severity gaps before signing"
                  : undefined
              }
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
              )}
              Approve & sign
            </Button>
          ) : null}
          {!loading && !note ? (
            <Link href={recordHref}>
              <Button size="sm">
                <FileText className="h-4 w-4" aria-hidden="true" />
                Start note
              </Button>
            </Link>
          ) : null}
        </div>
      </div>
      {loading ? (
        <p className="text-sm text-(--color-muted-foreground)">Loading note…</p>
      ) : !note ? (
        <p className="text-sm text-(--color-muted-foreground)">
          No note linked to this encounter yet. Start one to record audio and
          generate a SOAP draft.
        </p>
      ) : (
        <>
          <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border border-(--color-border) bg-(--color-muted)/30 p-3 text-sm font-sans">
            {note.body}
          </pre>
          {note.approvedAt ? (
            <p className="text-xs text-(--color-muted-foreground)">
              Signed {formatLocalDateTime(note.approvedAt)} ·{" "}
              <span className="font-mono">
                {note.signedNoteHash?.slice(0, 12)}…
              </span>
            </p>
          ) : null}
        </>
      )}
      {refineOpen && note && note.status === "draft" ? (
        <div className="space-y-2 rounded-md border border-(--color-border) bg-(--color-muted)/30 p-3">
          <label
            htmlFor="refine-input"
            className="block text-xs font-semibold uppercase tracking-wide text-(--color-muted-foreground)"
          >
            Ask the AI to refine the note
          </label>
          <textarea
            id="refine-input"
            value={refineInstruction}
            onChange={(e) => setRefineInstruction(e.target.value)}
            placeholder='e.g. "Shorten the assessment to 2 sentences" or "Add a normal 10-point ROS"'
            rows={2}
            disabled={refining}
            className="block w-full rounded-md border border-(--color-border) bg-(--color-card) p-2 text-sm focus:outline-none focus:ring-2 focus:ring-(--color-primary)"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <p className="text-(--color-muted-foreground)">
              The AI will rewrite the body and persist the change. It won't
              add clinical content that isn't in the original.
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setRefineOpen(false);
                  setRefineInstruction("");
                }}
                disabled={refining}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => void runRefine()}
                disabled={refining || !refineInstruction.trim()}
              >
                {refining ? (
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Sparkles className="h-4 w-4" aria-hidden="true" />
                )}
                Apply refinement
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {analysis ? <GapAnalysisDisplay analysis={analysis} /> : null}
    </Card>
  );
}

// Inline gap-analysis renderer. Sorted so block-severity gaps land at the
// top — the provider's first scan should hit the things that block signing.
function GapAnalysisDisplay({ analysis }: { analysis: GapAnalysisResponse }) {
  const sorted = [...analysis.gaps].sort((a, b) => {
    const weight = { block: 0, warn: 1, info: 2 };
    return weight[a.severity] - weight[b.severity];
  });
  return (
    <div className="space-y-2 border-t border-(--color-border) pt-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground)">
          Gap analysis
        </h3>
        <span className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
          {analysis.source === "ai" ? "AI" : "stub"}
        </span>
      </div>
      {analysis.gaps.length === 0 ? (
        <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-inset ring-emerald-200">
          {analysis.summary}
        </p>
      ) : (
        <ul className="space-y-2">
          {sorted.map((g, i) => (
            <GapRow key={`${g.field}-${i}`} gap={g} />
          ))}
        </ul>
      )}
      {analysis.gaps.length > 0 && analysis.summary ? (
        <p className="text-xs italic text-(--color-muted-foreground)">
          {analysis.summary}
        </p>
      ) : null}
    </div>
  );
}

function GapRow({ gap }: { gap: NoteGap }) {
  const tone =
    gap.severity === "block"
      ? "ring-red-200 bg-red-50 text-red-900"
      : gap.severity === "warn"
        ? "ring-amber-200 bg-amber-50 text-amber-900"
        : "ring-(--color-border) bg-(--color-card) text-(--color-muted-foreground)";
  return (
    <li>
      <div className={`rounded-md px-3 py-2 ring-1 ring-inset ${tone}`}>
        <div className="flex items-start gap-2">
          {gap.severity === "block" ? (
            <AlertTriangle
              className="mt-0.5 h-4 w-4 shrink-0"
              aria-hidden="true"
            />
          ) : null}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide">
                {gap.severity}
              </span>
              {gap.locationHint ? (
                <span className="text-xs">{gap.locationHint}</span>
              ) : null}
            </div>
            <p className="text-sm">{gap.message}</p>
            {gap.suggestedResolution ? (
              <p className="text-xs italic">
                Suggested: &ldquo;{gap.suggestedResolution}&rdquo;
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </li>
  );
}
