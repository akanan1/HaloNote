// Encounter-link banner — shown above the code groups when the local
// encounter has no Athena Encounter ref. Opens a picker showing recent
// Athena Encounter resources for the patient; one click writes
// ehrEncounterRef to the encounter and refetches.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  fetchAthenaEncounterCandidates,
  linkEncounterToAthena,
} from "../../api";

export function EncounterLinkBanner({
  encounterId,
  patientId,
  onLinked,
}: {
  encounterId: string;
  patientId: string;
  onLinked: () => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  const candidatesQ = useQuery({
    queryKey: ["athena-encounters", patientId],
    queryFn: () => fetchAthenaEncounterCandidates(patientId),
    enabled: open,
  });

  const linkMut = useMutation({
    mutationFn: (athenaEncounterId: string) =>
      linkEncounterToAthena(encounterId, athenaEncounterId),
    onSuccess: (res) => {
      toast.success(`Linked to ${res.ehrEncounterRef}`);
      setOpen(false);
      void qc.invalidateQueries({ queryKey: ["encounter", encounterId] });
      onLinked();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Link failed"),
  });

  if (!open) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <div className="flex items-center justify-between gap-2">
          <span>
            <AlertTriangle className="mr-1 inline h-3 w-3" />
            <span className="font-medium">Encounter not linked to Athena.</span>{" "}
            Mock-mode pushes will succeed with synthetic refs; real-mode pushes
            will fail with a "not linked" error until you attach this encounter
            to its Athena chart entry.
          </span>
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Link to Athena encounter
          </Button>
        </div>
      </div>
    );
  }

  const candidates = candidatesQ.data?.data ?? [];

  return (
    <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Pick the Athena encounter to link</span>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      {candidatesQ.isPending && (
        <p className="flex items-center gap-1">
          <Loader2 className="h-3 w-3 animate-spin" />
          Loading recent encounters…
        </p>
      )}
      {candidatesQ.isError && (
        <p className="text-red-700">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          {candidatesQ.error instanceof Error
            ? candidatesQ.error.message
            : "Failed to load Athena encounters"}
        </p>
      )}
      {!candidatesQ.isPending && candidates.length === 0 && (
        <p>
          No Athena encounters for this patient — either none exist, the patient
          is not linked to an Athena chart, or the Athena connection isn't
          configured (EHR_MODE).
        </p>
      )}
      {candidates.length > 0 && (
        <ul className="space-y-1">
          {candidates.map((c) => (
            <li
              key={c.encounterId}
              className="flex items-center justify-between gap-2 rounded border border-amber-200 bg-(--color-card) px-2 py-1.5 text-(--color-foreground)"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">
                  {c.classDisplay ?? "Encounter"}
                  {c.typeDisplay ? ` · ${c.typeDisplay}` : ""}
                </p>
                <p className="text-xs text-(--color-muted-foreground)">
                  {c.period.start
                    ? new Date(c.period.start).toLocaleString(undefined, {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })
                    : "—"}
                  {c.status ? ` · ${c.status}` : ""}
                  <span className="ml-2 font-mono">
                    {c.encounterId.slice(0, 18)}
                    {c.encounterId.length > 18 ? "…" : ""}
                  </span>
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => linkMut.mutate(c.encounterId)}
                disabled={linkMut.isPending}
              >
                {linkMut.isPending && linkMut.variables === c.encounterId ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Check className="h-4 w-4" />
                )}
                Link
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
