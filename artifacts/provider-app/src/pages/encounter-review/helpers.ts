// Pure presentation helpers shared across the encounter-review panels.
// No state, no side effects — keeps the panels themselves trim.

import type { OrderType, Patient } from "./types";

// Per the spec's non-negotiable: only `medication` orders carry the
// strict completeness rule. Surfacing it at the type-list level so
// the UI can render the "Complete details" call-to-action consistently.
export function requiresMedicationDetails(t: OrderType): boolean {
  return t === "medication";
}

export function formatLocalDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function patientDisplay(p: Patient): string {
  return `${p.firstName} ${p.lastName} · MRN ${p.mrn}`;
}
