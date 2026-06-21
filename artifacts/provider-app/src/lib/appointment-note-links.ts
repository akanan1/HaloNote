// Server-backed appointment claim client. Replaces the Wave 1 interim
// (localStorage) — see lib/db/src/schema/appointment-claims.ts and
// artifacts/api-server/src/routes/appointment-claims.ts for the table
// + endpoint definitions.
//
// Why we moved off localStorage:
//   - Cross-device consistency: a provider who claims an appointment
//     on their iPad now sees it as claimed on their desktop.
//   - Server-enforced TTL: the prior 7-day client check could be
//     bypassed by clock tampering; expires_at is now authoritative.
//   - No PHI-adjacent data on shared clinic devices (the patient_id
//     link is back behind auth).
//
// The Today view consumes these via react-query; see Today.tsx for the
// query key + invalidation pattern.

import { customFetch } from "@workspace/api-client-react";

export interface AppointmentClaim {
  appointmentId: string;
  patientId: string;
  // ISO 8601 timestamps as returned by the server.
  claimedAt: string;
  expiresAt: string;
}

interface ListResponse {
  data: AppointmentClaim[];
}

// Fetch this user's currently-active (non-expired) claims. The server
// filters `expires_at > NOW()`, so the list is always trustworthy
// without client-side staleness checks.
export async function listMyAppointmentClaims(): Promise<AppointmentClaim[]> {
  const r = await customFetch<ListResponse>("/api/appointment-claims/mine");
  return r.data;
}

// Upsert a claim. If a different provider had this appointment claimed,
// the server replaces their row (last-writer-wins) — the design choice
// is that whoever clicked "start note" last is the active claimant.
export async function claimAppointment(
  appointmentId: string,
  patientId: string,
): Promise<AppointmentClaim> {
  return customFetch<AppointmentClaim>("/api/appointment-claims", {
    method: "POST",
    body: JSON.stringify({ appointmentId, patientId }),
  });
}

// Release a claim. Idempotent on the server — replays return 204.
export async function clearAppointmentClaim(
  appointmentId: string,
): Promise<void> {
  await customFetch<void>(
    `/api/appointment-claims/${encodeURIComponent(appointmentId)}`,
    { method: "DELETE" },
  );
}

// Defensive scrub of any stale localStorage entries left over from the
// Wave 1 interim version of this module. Called from signOut so a
// shared device doesn't keep the previous version's cached
// appointment→patient correlations around after the migration ships.
// Server-side claims are NOT released here — they expire on their own
// TTL or via explicit clearAppointmentClaim.
export function clearLegacyLocalClaims(): void {
  if (typeof window === "undefined") return;
  let store: Storage | null;
  try {
    store = window.localStorage;
  } catch {
    return;
  }
  if (!store) return;
  const KEY_PREFIX = "halo:appt-claim:";
  const toRemove: string[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key && key.startsWith(KEY_PREFIX)) toRemove.push(key);
    }
    for (const k of toRemove) store.removeItem(k);
  } catch {
    // ignore
  }
}
