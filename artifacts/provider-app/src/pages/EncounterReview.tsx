import { Link } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import {
  fetchBilling,
  fetchCodingSession,
  fetchEncounter,
  fetchNoteForEncounter,
  fetchOrders,
  fetchPatient,
  fetchTasksForEncounter,
} from "./encounter-review/api";
import { BillingPanel } from "./encounter-review/panels/BillingPanel";
import { CoderReviewPanel } from "./encounter-review/panels/CoderReviewPanel";
import { EncounterAuditPanel } from "./encounter-review/panels/EncounterAuditPanel";
import { NotePanel } from "./encounter-review/panels/NotePanel";
import { OrdersPanel } from "./encounter-review/panels/OrdersPanel";
import { PatientEncounterHeader } from "./encounter-review/panels/PatientEncounterHeader";
import { PatientSummaryPanel } from "./encounter-review/panels/PatientSummaryPanel";
import { TasksPanel } from "./encounter-review/panels/TasksPanel";
import { VitalsPanel } from "./encounter-review/panels/VitalsPanel";

interface Props {
  patientId: string;
  encounterId: string;
}

export function EncounterReviewPage({ patientId, encounterId }: Props) {
  const qc = useQueryClient();

  const encounterQuery = useQuery({
    queryKey: ["encounter", encounterId],
    queryFn: () => fetchEncounter(encounterId),
  });
  const patientQuery = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => fetchPatient(patientId),
  });
  const noteQuery = useQuery({
    queryKey: ["note-for-encounter", encounterId],
    queryFn: () => fetchNoteForEncounter(encounterId),
  });
  const billingQuery = useQuery({
    queryKey: ["billing", encounterId],
    queryFn: () => fetchBilling(encounterId),
  });
  const codingQuery = useQuery({
    // Refetch on window focus so an in-flight background extraction
    // (fired by the note-approve auto-trigger) lands in the UI without
    // a manual reload.
    queryKey: ["coding-session", encounterId],
    queryFn: () => fetchCodingSession(encounterId),
    refetchInterval: (q) => {
      const status = q.state.data?.session.status;
      // Poll while extraction is in flight; stop once we have a terminal
      // state to avoid hammering the API for already-loaded sessions.
      return status === "queued" || status === "extracting" ? 2000 : false;
    },
  });
  const ordersQuery = useQuery({
    queryKey: ["orders", encounterId],
    queryFn: () => fetchOrders(encounterId),
  });
  const tasksQuery = useQuery({
    queryKey: ["tasks-for-encounter", encounterId],
    queryFn: () => fetchTasksForEncounter(encounterId),
  });

  // The note panel writes through to the note row (approval, refinement)
  // and those writes can change billing eligibility, so invalidate both
  // when the note changes. Per-panel mutations only invalidate their own
  // query — see each panel's onChanged callback below.
  const invalidateAll = () => {
    void qc.invalidateQueries({
      queryKey: ["note-for-encounter", encounterId],
    });
    void qc.invalidateQueries({ queryKey: ["billing", encounterId] });
  };

  return (
    <div className="space-y-6">
      <div>
        <Link
          href={`/patients/${patientId}`}
          className="inline-flex items-center gap-1 text-sm text-(--color-muted-foreground) hover:text-(--color-foreground)"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          Back to patient
        </Link>
      </div>

      <PatientEncounterHeader
        patient={patientQuery.data ?? null}
        encounter={encounterQuery.data ?? null}
        loading={patientQuery.isPending || encounterQuery.isPending}
      />

      <NotePanel
        note={noteQuery.data ?? null}
        loading={noteQuery.isPending}
        onChanged={() => invalidateAll()}
        patientId={patientId}
        encounterId={encounterId}
      />

      <VitalsPanel note={noteQuery.data ?? null} patientId={patientId} />

      <PatientSummaryPanel
        note={noteQuery.data ?? null}
        patient={patientQuery.data ?? null}
        encounter={encounterQuery.data ?? null}
      />

      <CoderReviewPanel
        encounterId={encounterId}
        patientId={patientId}
        encounterEhrRef={encounterQuery.data?.ehrEncounterRef ?? null}
        coding={codingQuery.data ?? null}
        loading={codingQuery.isPending}
        onChanged={() => {
          void qc.invalidateQueries({
            queryKey: ["coding-session", encounterId],
          });
          // Coder approvals create approved_billing_codes rows, so the
          // BillingPanel needs to refresh too.
          void qc.invalidateQueries({ queryKey: ["billing", encounterId] });
          // Ingestion creates a new note → refresh the note query.
          void qc.invalidateQueries({
            queryKey: ["note-for-encounter", encounterId],
          });
        }}
      />

      <BillingPanel
        encounterId={encounterId}
        billing={billingQuery.data ?? null}
        loading={billingQuery.isPending}
        onChanged={() =>
          void qc.invalidateQueries({ queryKey: ["billing", encounterId] })
        }
      />

      <OrdersPanel
        encounterId={encounterId}
        orders={ordersQuery.data ?? null}
        loading={ordersQuery.isPending}
        onChanged={() =>
          void qc.invalidateQueries({ queryKey: ["orders", encounterId] })
        }
      />

      <EncounterAuditPanel encounterId={encounterId} />

      <TasksPanel
        encounterId={encounterId}
        tasks={tasksQuery.data?.data ?? null}
        loading={tasksQuery.isPending}
        onChanged={() =>
          void qc.invalidateQueries({
            queryKey: ["tasks-for-encounter", encounterId],
          })
        }
      />
    </div>
  );
}
