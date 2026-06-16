import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Calendar,
  ChevronRight,
  Loader2,
  Plus,
  Stethoscope,
  Video,
} from "lucide-react";
import { toast } from "sonner";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// ---------------------------------------------------------------------------
// Wire types (mirrored from routes/encounters.ts serializer; replace with
// codegen once OpenAPI catches up to the encounters endpoints).
// ---------------------------------------------------------------------------

type EncounterStatus =
  | "scheduled"
  | "in_progress"
  | "completed"
  | "cancelled";

type VisitType =
  | "new_patient"
  | "established_patient"
  | "follow_up"
  | "annual_physical"
  | "hospital_follow_up"
  | "procedure"
  | "telehealth"
  | "nursing_facility"
  | "custom";

interface Encounter {
  id: string;
  patientId: string;
  visitType: VisitType;
  customLabel: string | null;
  status: EncounterStatus;
  isTelehealth: boolean;
  location: string | null;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

interface ListResponse {
  data: Encounter[];
}

interface CreateBody {
  patientId: string;
  visitType: VisitType;
  customLabel?: string;
  isTelehealth?: boolean;
  location?: string;
  scheduledAt?: string;
}

const VISIT_OPTIONS: { value: VisitType; label: string }[] = [
  { value: "new_patient", label: "New patient" },
  { value: "established_patient", label: "Established patient" },
  { value: "follow_up", label: "Follow-up" },
  { value: "annual_physical", label: "Annual physical" },
  { value: "hospital_follow_up", label: "Hospital follow-up" },
  { value: "procedure", label: "Procedure" },
  { value: "telehealth", label: "Telehealth" },
  { value: "nursing_facility", label: "Nursing facility" },
  { value: "custom", label: "Custom" },
];

const VISIT_LABEL: Record<VisitType, string> = Object.fromEntries(
  VISIT_OPTIONS.map((o) => [o.value, o.label]),
) as Record<VisitType, string>;

const STATUS_TONE: Record<EncounterStatus, string> = {
  scheduled: "ring-sky-200 bg-sky-50 text-sky-900",
  in_progress: "ring-violet-200 bg-violet-50 text-violet-900",
  completed: "ring-emerald-200 bg-emerald-50 text-emerald-900",
  cancelled: "ring-(--color-border) bg-(--color-muted) text-(--color-muted-foreground)",
};

const STATUS_LABEL: Record<EncounterStatus, string> = {
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Match the existing Patients/Notes formatter style — compact, locale-aware.
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// Pick the most informative timestamp for the chart row's right rail.
// Provider scanning the list cares most about "when did this happen"
// not "when was this row created in the DB", so prefer completed →
// started → scheduled → createdAt.
function pickAnchorTimestamp(e: Encounter): string {
  return e.completedAt ?? e.startedAt ?? e.scheduledAt ?? e.createdAt;
}

async function fetchEncountersFor(patientId: string): Promise<ListResponse> {
  return customFetch<ListResponse>(
    `/api/encounters?patientId=${encodeURIComponent(patientId)}`,
  );
}

async function createEncounter(body: CreateBody): Promise<Encounter> {
  return customFetch<Encounter>("/api/encounters", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Section component
// ---------------------------------------------------------------------------

export function PatientEncountersSection({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const query = useQuery({
    queryKey: ["patient-encounters", patientId],
    queryFn: () => fetchEncountersFor(patientId),
  });

  const encounters = useMemo(
    () => query.data?.data ?? [],
    [query.data],
  );

  return (
    <section className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium text-(--color-foreground)">
          Encounters
        </h2>
        <Button
          size="sm"
          variant={encounters.length > 0 ? "outline" : "default"}
          onClick={() => setCreateOpen((v) => !v)}
        >
          <Plus className="h-4 w-4" aria-hidden="true" />
          {createOpen ? "Cancel" : "Start encounter"}
        </Button>
      </header>

      {createOpen ? (
        <NewEncounterForm
          patientId={patientId}
          onCancel={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            void qc.invalidateQueries({
              queryKey: ["patient-encounters", patientId],
            });
          }}
        />
      ) : null}

      {query.isPending ? (
        <p className="text-sm text-(--color-muted-foreground)">
          Loading encounters…
        </p>
      ) : query.isError ? (
        <p className="text-sm text-(--color-destructive)" role="alert">
          Couldn&apos;t load encounters.
        </p>
      ) : encounters.length === 0 ? (
        <Card className="p-6 text-center text-sm text-(--color-muted-foreground)">
          <Stethoscope
            className="mx-auto mb-2 h-6 w-6"
            aria-hidden="true"
          />
          No encounters yet for this patient. Start one to begin documentation.
        </Card>
      ) : (
        <ul className="space-y-2" aria-label="Encounters">
          {encounters.map((e) => (
            <EncounterRow key={e.id} encounter={e} patientId={patientId} />
          ))}
        </ul>
      )}
    </section>
  );
}

function EncounterRow({
  encounter: e,
  patientId,
}: {
  encounter: Encounter;
  patientId: string;
}) {
  const visitLabel =
    e.visitType === "custom" && e.customLabel
      ? e.customLabel
      : VISIT_LABEL[e.visitType];
  return (
    <li>
      <Link
        href={`/patients/${patientId}/encounters/${e.id}`}
        className="block"
      >
        <Card className="relative cursor-pointer overflow-hidden transition-colors hover:bg-(--color-muted)/40">
          <div className="flex flex-wrap items-center gap-4 px-5 py-4">
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-base font-medium">{visitLabel}</span>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_TONE[e.status]}`}
                >
                  {STATUS_LABEL[e.status]}
                </span>
                {e.isTelehealth ? (
                  <span className="inline-flex items-center gap-1 text-xs text-(--color-muted-foreground)">
                    <Video className="h-3.5 w-3.5" aria-hidden="true" />
                    Telehealth
                  </span>
                ) : null}
                {e.location ? (
                  <span className="text-xs text-(--color-muted-foreground)">
                    {e.location}
                  </span>
                ) : null}
              </div>
              <p className="flex items-center gap-1.5 text-xs text-(--color-muted-foreground)">
                <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
                {formatTimestamp(pickAnchorTimestamp(e))}
              </p>
            </div>
            <ChevronRight
              className="h-4 w-4 text-(--color-muted-foreground)"
              aria-hidden="true"
            />
          </div>
        </Card>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Inline create form
// ---------------------------------------------------------------------------

function NewEncounterForm({
  patientId,
  onCancel,
  onCreated,
}: {
  patientId: string;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [, navigate] = useLocation();
  const [visitType, setVisitType] = useState<VisitType>("follow_up");
  const [customLabel, setCustomLabel] = useState("");
  const [isTelehealth, setIsTelehealth] = useState(false);
  const [location, setLocation] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");

  const create = useMutation({
    mutationFn: (body: CreateBody) => createEncounter(body),
    onSuccess: (encounter) => {
      toast.success("Encounter started");
      onCreated();
      // Drop the provider straight onto the new encounter's review page
      // so the next action (recording / charting) is one click away.
      navigate(`/patients/${patientId}/encounters/${encounter.id}`);
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Couldn't create"),
  });

  const isCustom = visitType === "custom";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isCustom && !customLabel.trim()) return;
    const body: CreateBody = {
      patientId,
      visitType,
    };
    if (isCustom && customLabel.trim()) body.customLabel = customLabel.trim();
    if (isTelehealth) body.isTelehealth = true;
    if (location.trim()) body.location = location.trim();
    if (scheduledAt) body.scheduledAt = new Date(scheduledAt).toISOString();
    create.mutate(body);
  }

  return (
    <Card className="space-y-3 p-5">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="enc-visit-type">Visit type</Label>
            <select
              id="enc-visit-type"
              value={visitType}
              onChange={(e) => setVisitType(e.target.value as VisitType)}
              className="block h-9 w-full rounded-md border border-(--color-border) bg-(--color-card) px-2 text-sm"
            >
              {VISIT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          {isCustom ? (
            <div className="space-y-1.5">
              <Label htmlFor="enc-custom-label">
                Custom label{" "}
                <span className="text-(--color-destructive)">*</span>
              </Label>
              <Input
                id="enc-custom-label"
                value={customLabel}
                onChange={(e) => setCustomLabel(e.target.value)}
                placeholder="e.g. Pre-op clearance"
                required
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="enc-location">Location</Label>
            <Input
              id="enc-location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Room 3"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="enc-scheduled">Scheduled (optional)</Label>
            <Input
              id="enc-scheduled"
              type="datetime-local"
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 self-end text-sm">
            <input
              type="checkbox"
              checked={isTelehealth}
              onChange={(e) => setIsTelehealth(e.target.checked)}
            />
            Telehealth
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : null}
            Start encounter
          </Button>
        </div>
      </form>
    </Card>
  );
}
