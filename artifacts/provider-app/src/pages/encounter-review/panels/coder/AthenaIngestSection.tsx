// Athena-existing note ingestion (Phase 3). For practices that
// onboard Coder without Scribe: provider documented the visit in
// Athena; we pull the finalized DocumentReference and run Coder
// against it. Empty-state section so it doesn't compete with the
// primary "Run Coder" flow for Scribe-authored notes.

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, FileText, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { fetchAthenaNoteCandidates, ingestAthenaNote } from "../../api";

export function AthenaIngestSection({
  encounterId,
  patientId,
  onIngested,
}: {
  encounterId: string;
  patientId: string;
  onIngested: () => void;
}) {
  const [open, setOpen] = useState(false);

  const candidatesQ = useQuery({
    queryKey: ["athena-notes", patientId],
    queryFn: () => fetchAthenaNoteCandidates(patientId),
    enabled: open,
  });

  const ingestMut = useMutation({
    mutationFn: (docRefId: string) => ingestAthenaNote(encounterId, docRefId),
    onSuccess: (res) => {
      toast.success(
        res.noteSource === "athena"
          ? `Ingested Athena note · ${res.suggestions.length} codes suggested`
          : `Ingested mock note · ${res.suggestions.length} codes suggested`,
      );
      setOpen(false);
      onIngested();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Ingest failed"),
  });

  if (!open) {
    return (
      <div className="rounded-md border border-dashed border-(--color-border) bg-(--color-muted)/40 p-3 text-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-(--color-muted-foreground)">
            <FileText className="mr-1 inline h-4 w-4" />
            Documented in Athena instead?
          </span>
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Ingest from Athena
          </Button>
        </div>
      </div>
    );
  }

  const candidates = candidatesQ.data?.data ?? [];

  return (
    <div className="space-y-2 rounded-md border border-(--color-border) bg-(--color-muted)/40 p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Ingest a finalized Athena note</span>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      {candidatesQ.isPending && (
        <p className="text-xs text-(--color-muted-foreground)">
          <Loader2 className="mr-1 inline h-3 w-3 animate-spin" />
          Loading recent notes…
        </p>
      )}
      {candidatesQ.isError && (
        <p className="text-xs text-red-700">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          {candidatesQ.error instanceof Error
            ? candidatesQ.error.message
            : "Failed to load Athena notes"}
        </p>
      )}
      {!candidatesQ.isPending && candidates.length === 0 && (
        <p className="text-xs text-(--color-muted-foreground)">
          No finalized Athena notes for this patient — either no notes exist,
          the patient is not linked to an Athena chart, or the Athena
          connection isn't configured (EHR_MODE).
        </p>
      )}
      {candidates.length > 0 && (
        <ul className="space-y-1">
          {candidates.map((c) => (
            <li
              key={c.documentReferenceId}
              className="flex items-center justify-between gap-2 rounded border border-(--color-border) bg-(--color-card) px-2 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-(--color-foreground)">
                  {c.description ?? "(untitled)"}
                </p>
                <p className="text-xs text-(--color-muted-foreground)">
                  {c.date
                    ? new Date(c.date).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                      })
                    : "—"}
                  {c.contentType && ` · ${c.contentType}`}
                  <span className="ml-2 font-mono">
                    {c.documentReferenceId.slice(0, 16)}
                    {c.documentReferenceId.length > 16 ? "…" : ""}
                  </span>
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => ingestMut.mutate(c.documentReferenceId)}
                disabled={ingestMut.isPending}
              >
                {ingestMut.isPending &&
                ingestMut.variables === c.documentReferenceId ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Ingest
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
