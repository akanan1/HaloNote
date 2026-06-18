import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ChevronRight, CloudDownload, Plus, Search } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  getListPatientsQueryKey,
  useListPatients,
  useSyncPatientFromEhr,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Fab } from "@/components/Fab";

function SyncFromEhrButton() {
  const queryClient = useQueryClient();
  const sync = useSyncPatientFromEhr();
  const [open, setOpen] = useState(false);
  const [externalId, setExternalId] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = externalId.trim();
    if (!trimmed) return;
    try {
      const result = await sync.mutateAsync({ data: { externalId: trimmed } });
      toast.success(
        result.synced.created
          ? `Imported ${result.firstName} ${result.lastName}`
          : `Refreshed ${result.firstName} ${result.lastName}`,
      );
      setExternalId("");
      setOpen(false);
      void queryClient.invalidateQueries({
        queryKey: getListPatientsQueryKey(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sync failed");
    }
  }

  if (!open) {
    return (
      <Button size="lg" variant="outline" onClick={() => setOpen(true)}>
        <CloudDownload className="h-4 w-4" aria-hidden="true" />
        Sync from EHR
      </Button>
    );
  }
  // Mobile: stack the label/input above a Pull+Cancel button row so the
  // ID field gets the full width (these IDs are long, e.g.
  // erXuFYUfucBZaryVksYEcMg3) and the buttons stay reachable. Desktop:
  // original inline `flex items-end` layout.
  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-end"
    >
      <div className="space-y-1 sm:flex-1">
        <Label htmlFor="ehr-external-id" className="text-xs">
          EHR Patient id
        </Label>
        <Input
          id="ehr-external-id"
          value={externalId}
          onChange={(e) => setExternalId(e.target.value)}
          placeholder="e.g. erXuFYUfucBZaryVksYEcMg3"
          autoFocus
          disabled={sync.isPending}
        />
      </div>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="lg"
          disabled={sync.isPending || !externalId.trim()}
          className="flex-1 sm:flex-none"
        >
          {sync.isPending ? "Syncing…" : "Pull"}
        </Button>
        <Button
          type="button"
          size="lg"
          variant="ghost"
          onClick={() => {
            setOpen(false);
            setExternalId("");
          }}
          disabled={sync.isPending}
          className="flex-1 sm:flex-none"
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function formatDob(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function calculateAge(iso: string): number | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

export function PatientsPage() {
  const { data, isPending, isError, error } = useListPatients();
  const [query, setQuery] = useState("");

  // Client-side filter. The patient list for a single provider is small
  // (hundreds at most), so doing this in the browser keeps the network
  // chatter low and the UI instant — a server-side fuzzy search would
  // add latency without a real win at this scale.
  const filtered = useMemo(() => {
    const all = data?.data ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((p) => {
      const haystack = `${p.firstName} ${p.lastName} ${p.mrn}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [data, query]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Patients</h1>
          <p className="text-(--color-muted-foreground)">
            Select a patient to see their notes.
          </p>
        </div>
        <div className="flex w-full flex-1 items-center gap-2 sm:w-auto sm:flex-initial">
          <SyncFromEhrButton />
          {/* Desktop "Add patient" — hidden on mobile (< md) because the
              FAB at the bottom of the viewport carries the same action
              with a thumb-reachable affordance. */}
          <Link href="/patients/new" className="hidden md:inline-block">
            <Button size="lg" variant="outline">
              <Plus className="h-4 w-4" aria-hidden="true" />
              Add patient
            </Button>
          </Link>
        </div>
      </header>

      {/* Search — autofocused so a provider can land on this page and
          start typing a patient name without an extra tap. */}
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-(--color-muted-foreground)"
          aria-hidden="true"
        />
        <Input
          type="search"
          inputMode="search"
          autoFocus
          autoComplete="off"
          placeholder="Search by name or MRN…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search patients"
          className="pl-9 h-12 text-base"
        />
      </div>

      {isPending ? (
        <ul
          className="space-y-3"
          role="status"
          aria-label="Loading patients"
        >
          {[0, 1, 2, 3].map((i) => (
            <li key={i}>
              <Card className="relative overflow-hidden">
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 w-1 bg-(--color-border)"
                />
                <div className="space-y-2 px-6 py-5">
                  <div className="h-5 w-2/5 animate-pulse rounded bg-(--color-muted)" />
                  <div className="h-3 w-3/5 animate-pulse rounded bg-(--color-muted)" />
                </div>
              </Card>
            </li>
          ))}
        </ul>
      ) : isError ? (
        <p role="alert" className="text-(--color-destructive)">
          Couldn't load patients. {error instanceof Error ? error.message : ""}
        </p>
      ) : filtered.length === 0 ? (
        <Card className="p-10 text-center text-(--color-muted-foreground)">
          {query
            ? `No patients match "${query}".`
            : "No patients yet."}
        </Card>
      ) : (
        <ul
          className="space-y-3 pb-24 md:pb-0"
          aria-label="Patients"
        >
          {filtered.map((patient) => {
            const age = calculateAge(patient.dateOfBirth);
            return (
              <li key={patient.id}>
                <Link href={`/patients/${patient.id}`}>
                  <Card className="relative cursor-pointer overflow-hidden transition-colors hover:bg-(--color-muted)">
                    <span
                      aria-hidden="true"
                      className="absolute inset-y-0 left-0 w-1 bg-(--color-primary)/60"
                    />
                    <div className="flex items-center justify-between gap-4 px-6 py-5">
                      <div className="min-w-0 space-y-1">
                        <div className="truncate text-lg font-medium leading-snug">
                          {patient.lastName}, {patient.firstName}
                        </div>
                        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm text-(--color-muted-foreground)">
                          {age != null ? (
                            <span>
                              <span className="font-medium text-(--color-foreground)">
                                {age}
                              </span>{" "}
                              yrs
                            </span>
                          ) : null}
                          <span className="tabular-nums">
                            DOB {formatDob(patient.dateOfBirth)}
                          </span>
                          <span className="font-mono text-xs tabular-nums">
                            {patient.mrn}
                          </span>
                        </div>
                      </div>
                      <ChevronRight
                        className="h-5 w-5 shrink-0 text-(--color-muted-foreground)"
                        aria-hidden="true"
                      />
                    </div>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      <Fab href="/patients/new" icon={Plus} label="Add patient" />
    </div>
  );
}
