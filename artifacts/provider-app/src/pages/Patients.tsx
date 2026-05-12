import { Link } from "wouter";
import { ChevronRight, Plus } from "lucide-react";
import { useListPatients } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

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

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Patients</h1>
          <p className="text-(--color-muted-foreground)">
            Select a patient to see their notes.
          </p>
        </div>
        <Link href="/patients/new">
          <Button size="lg" variant="outline">
            <Plus className="h-4 w-4" />
            Add patient
          </Button>
        </Link>
      </header>

      {isPending ? (
        <p className="text-(--color-muted-foreground)">Loading patients…</p>
      ) : isError ? (
        <p className="text-(--color-destructive)">
          Couldn't load patients. {error instanceof Error ? error.message : ""}
        </p>
      ) : (
        <ul className="space-y-3">
          {data.data.map((patient) => {
            const age = calculateAge(patient.dateOfBirth);
            return (
              <li key={patient.id}>
                <Link href={`/patients/${patient.id}`}>
                  <Card className="cursor-pointer transition-colors hover:bg-(--color-muted)">
                    <div className="flex items-center justify-between gap-4 px-6 py-5">
                      <div className="space-y-1">
                        <div className="text-lg font-medium leading-snug">
                          {patient.lastName}, {patient.firstName}
                        </div>
                        <div className="text-sm text-(--color-muted-foreground)">
                          DOB {formatDob(patient.dateOfBirth)}
                          {age != null ? ` · ${age} yrs` : ""} · MRN{" "}
                          {patient.mrn}
                        </div>
                      </div>
                      <ChevronRight className="h-5 w-5 shrink-0 text-(--color-muted-foreground)" />
                    </div>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
