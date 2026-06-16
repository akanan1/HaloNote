// Per-device link between an Athena appointment id and the HaloNote
// local patient id the clinician synced when they clicked "Start
// note" on that appointment card. The schedule view uses this to
// correlate the right note to the right schedule row after autosave
// creates the note.
//
// Why localStorage and not a schema column on notes?
//   - This MVP layer keeps the backend untouched. A future migration
//     adding `notes.appointment_id` would replace this helper outright.
//   - Per-device is acceptable because the schedule view re-derives
//     status on every refresh by looking up notes the user authored
//     after `claimedAt` for the claimed patient — even if the device
//     loses the claim, a fresh note for the same patient will still
//     pair to the appointment within the day.
//
// Known limitations (documented here, not silently accepted):
//   - Two same-patient appointments on the same day will correlate to
//     whichever note's `createdAt` is closer in time to each claim.
//     The first-claimed appointment effectively "wins" the first note.
//   - Clearing the browser storage drops the link; the next refresh
//     falls back to "appointment has no note" (Pending).
//   - If the same user makes the claim on device A and writes the note
//     on device B, device A will not show the claim; device B will
//     still correlate correctly because its claim was made there.

const KEY_PREFIX = "halo:appt-claim:";
// 7 days — long enough to cover a week of clinic catch-up; short
// enough that abandoned claims don't sit in storage forever.
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface AppointmentClaim {
  appointmentId: string;
  patientId: string; // internal HaloNote patient id
  claimedAt: string; // ISO 8601
}

// Wrap localStorage access so a Safari-private-mode SecurityError or a
// jsdom test env without storage doesn't break the schedule view.
function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

export function claimAppointment(
  appointmentId: string,
  patientId: string,
): AppointmentClaim {
  const claim: AppointmentClaim = {
    appointmentId,
    patientId,
    claimedAt: new Date().toISOString(),
  };
  const store = safeStorage();
  if (store) {
    try {
      store.setItem(KEY_PREFIX + appointmentId, JSON.stringify(claim));
    } catch {
      // QuotaExceeded / SecurityError — non-fatal. The workflow status
      // for this appointment will fall back to "Pending" until a note
      // is created (we still get Failed/Completed once the user opens
      // the note page and pushes there).
    }
  }
  return claim;
}

export function getAppointmentClaim(
  appointmentId: string,
): AppointmentClaim | null {
  const store = safeStorage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(KEY_PREFIX + appointmentId);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as AppointmentClaim).appointmentId !== "string" ||
    typeof (parsed as AppointmentClaim).patientId !== "string" ||
    typeof (parsed as AppointmentClaim).claimedAt !== "string"
  ) {
    return null;
  }
  const claim = parsed as AppointmentClaim;
  const age = Date.now() - new Date(claim.claimedAt).getTime();
  if (!Number.isFinite(age) || age > MAX_AGE_MS) return null;
  return claim;
}

export function clearAppointmentClaim(appointmentId: string): void {
  const store = safeStorage();
  if (!store) return;
  try {
    store.removeItem(KEY_PREFIX + appointmentId);
  } catch {
    // ignore
  }
}

// Test seam — enumerates all current claims regardless of age.
export function _allClaimsForTests(): AppointmentClaim[] {
  const store = safeStorage();
  if (!store) return [];
  const out: AppointmentClaim[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key || !key.startsWith(KEY_PREFIX)) continue;
    const id = key.slice(KEY_PREFIX.length);
    const c = getAppointmentClaim(id);
    if (c) out.push(c);
  }
  return out;
}
