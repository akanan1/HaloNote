// Header card for the encounter-review page: patient identity + the
// encounter's high-level facts (visit type, schedule, location, status).
// Pure presentational — receives data from the page query layer, owns
// no fetching or state.

import { Card } from "@/components/ui/card";
import { STATUS_TONE, VISIT_LABEL } from "../constants";
import { formatLocalDateTime, patientDisplay } from "../helpers";
import type { Encounter, Patient } from "../types";

interface Props {
  patient: Patient | null;
  encounter: Encounter | null;
  loading: boolean;
}

export function PatientEncounterHeader({ patient, encounter, loading }: Props) {
  if (loading) {
    return (
      <Card className="p-5">
        <p className="text-sm text-(--color-muted-foreground)">Loading…</p>
      </Card>
    );
  }
  if (!encounter || !patient) {
    return (
      <Card className="p-5">
        <p className="text-sm text-(--color-destructive)">
          Encounter or patient not found.
        </p>
      </Card>
    );
  }
  const visitLabel =
    encounter.visitType === "custom" && encounter.customLabel
      ? encounter.customLabel
      : VISIT_LABEL[encounter.visitType];
  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            {patientDisplay(patient)}
          </h1>
          <p className="text-sm text-(--color-muted-foreground)">
            DOB {patient.dateOfBirth}
          </p>
        </div>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_TONE[encounter.status]}`}
        >
          {encounter.status.replace("_", " ")}
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-4">
        <Stat label="Visit type" value={visitLabel} />
        <Stat
          label="Scheduled"
          value={formatLocalDateTime(encounter.scheduledAt)}
        />
        <Stat
          label="Started"
          value={formatLocalDateTime(encounter.startedAt)}
        />
        <Stat
          label="Completed"
          value={formatLocalDateTime(encounter.completedAt)}
        />
      </dl>
      {encounter.isTelehealth || encounter.location ? (
        <p className="text-xs text-(--color-muted-foreground)">
          {encounter.isTelehealth ? "Telehealth · " : ""}
          {encounter.location ?? ""}
        </p>
      ) : null}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
        {label}
      </dt>
      <dd className="font-medium text-(--color-foreground)">{value}</dd>
    </div>
  );
}
