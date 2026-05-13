import {
  FhirError,
  type Appointment as FhirAppointment,
  type Bundle,
} from "@workspace/ehr";
import { getAthenahealthClient } from "./athena";
import { getEpicClient } from "./epic";
import { logger } from "./logger";

export interface ScheduledAppointment {
  appointmentId: string;
  /** ISO 8601 datetime. */
  start: string;
  /** ISO 8601 datetime; null if EHR didn't specify. */
  end: string | null;
  /** FHIR Appointment.status (e.g. "booked", "arrived", "fulfilled"). */
  status: string;
  /** Patient-facing reason for visit, if the EHR populated one. */
  reason: string | null;
  patient: {
    /** External (EHR) patient id parsed from `Patient/<id>` reference. */
    ehrId: string;
    /** Display name from Appointment.participant.actor.display, may be empty. */
    display: string;
  } | null;
}

export class ScheduleError extends Error {
  override readonly name = "ScheduleError";
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.status = status;
  }
}

function resolveProvider(): "athenahealth" | "epic" | "mock" {
  const mode = process.env["EHR_MODE"]?.trim().toLowerCase();
  if (mode === "athenahealth") return "athenahealth";
  if (mode === "epic") return "epic";
  return "mock";
}

// Parse "Patient/abc-123" → "abc-123". Falls back to the raw string if
// it doesn't have a slash (some EHRs return bare ids).
function patientIdFromReference(ref: string | undefined): string | null {
  if (!ref) return null;
  const slash = ref.lastIndexOf("/");
  return slash >= 0 ? ref.slice(slash + 1) : ref;
}

function pickPatient(
  appt: FhirAppointment,
): { ehrId: string; display: string } | null {
  for (const p of appt.participant ?? []) {
    const ref = p.actor?.reference;
    if (!ref || !ref.startsWith("Patient/")) continue;
    const ehrId = patientIdFromReference(ref);
    if (!ehrId) continue;
    return { ehrId, display: p.actor?.display ?? "" };
  }
  return null;
}

function mapAppointment(appt: FhirAppointment): ScheduledAppointment | null {
  if (!appt.id || !appt.start) return null;
  return {
    appointmentId: appt.id,
    start: appt.start,
    end: appt.end ?? null,
    status: appt.status,
    reason:
      appt.description ??
      appt.reasonCode?.[0]?.text ??
      appt.serviceType?.[0]?.text ??
      null,
    patient: pickPatient(appt),
  };
}

/**
 * Schedule for the given practitioner on the given local-date, ordered
 * by start time. `dateIso` is a YYYY-MM-DD string in the server's local
 * timezone; if omitted, defaults to today.
 *
 * EHR_MODE picks the upstream the same way patient-sync does:
 *   - "athenahealth"  → real Athena FHIR Appointment query
 *   - "epic"          → real Epic FHIR Appointment query
 *   - unset / mock    → return a synthesized roster so the UI is
 *                       testable without sandbox credentials
 */
export async function getSchedule(
  practitionerId: string,
  dateIso?: string,
): Promise<ScheduledAppointment[]> {
  const day = parseLocalDate(dateIso);
  const provider = resolveProvider();

  if (provider === "mock") {
    return buildMockSchedule(practitionerId, day);
  }

  const start = startOfDayIso(day);
  const end = startOfDayIso(addDays(day, 1));

  try {
    const client =
      provider === "athenahealth" ? getAthenahealthClient() : getEpicClient();
    // FHIR Appointment search supports `date=ge<>` + `date=lt<>` for
    // a range; `practitioner=<id>` filters to a specific provider.
    const bundle = await client.fhir.search<FhirAppointment>("Appointment", {
      practitioner: practitionerId,
      date: [`ge${start}`, `lt${end}`],
      _count: 100,
    });
    return extractAppointments(bundle).sort((a, b) =>
      a.start.localeCompare(b.start),
    );
  } catch (err) {
    if (err instanceof FhirError) {
      throw new ScheduleError(err.message, err.status === 404 ? 404 : 502);
    }
    throw err;
  }
}

function extractAppointments(
  bundle: Bundle<FhirAppointment>,
): ScheduledAppointment[] {
  const out: ScheduledAppointment[] = [];
  for (const entry of bundle.entry ?? []) {
    if (entry.resource?.resourceType !== "Appointment") continue;
    const mapped = mapAppointment(entry.resource);
    if (mapped) out.push(mapped);
  }
  return out;
}

// Strict YYYY-MM-DD parser. Falls back to "today (local)" on missing /
// malformed input — the route handler does its own 400 check before
// this, so reaching the fallback path here means a bad value snuck past.
function parseLocalDate(iso?: string): Date {
  if (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) {
    const [y, m, d] = iso.split("-").map(Number);
    if (y && m && d) {
      const local = new Date(y, m - 1, d, 0, 0, 0, 0);
      if (!Number.isNaN(local.getTime())) return local;
    }
  }
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  return t;
}

function startOfDayIso(d: Date): string {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out.toISOString();
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

// Mock roster — a handful of appointments throughout the workday so
// the UI has something to render against. Patient EHR ids match the
// demo patients seeded by patients.ts so the "tap → sync → open"
// path also stays inside the mock.
//
// Different shapes per weekday so swiping through days feels like a
// real schedule rather than a static fixture.
function buildMockSchedule(
  practitionerId: string,
  day: Date,
): ScheduledAppointment[] {
  logger.info(
    { practitionerId, day: day.toISOString().slice(0, 10) },
    "schedule (mock)",
  );

  const weekday = day.getDay(); // 0=Sun, 6=Sat
  // Weekends are clinic-closed in the demo.
  if (weekday === 0 || weekday === 6) return [];

  const slots = mockSlotsForWeekday(weekday);

  return slots.map((s, i) => {
    const start = new Date(day);
    start.setHours(s.hour, s.min, 0, 0);
    const end = new Date(start);
    end.setMinutes(end.getMinutes() + 20);
    return {
      appointmentId: `mock-appt-${day.toISOString().slice(0, 10)}-${i}`,
      start: start.toISOString(),
      end: end.toISOString(),
      status: s.status,
      reason: s.reason,
      patient: { ehrId: s.ehrId, display: s.display },
    };
  });
}

interface MockSlot {
  hour: number;
  min: number;
  ehrId: string;
  display: string;
  reason: string;
  status: string;
}

function mockSlotsForWeekday(weekday: number): MockSlot[] {
  // weekday: 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri
  switch (weekday) {
    case 1:
      return [
        { hour: 9, min: 0, ehrId: "pt_001", display: "Aguirre, Marisol", reason: "Hypertension follow-up", status: "booked" },
        { hour: 9, min: 30, ehrId: "pt_002", display: "Okafor, Daniel", reason: "Annual physical", status: "booked" },
        { hour: 10, min: 15, ehrId: "pt_003", display: "Bhattacharya, Priya", reason: "Diabetes management", status: "booked" },
        { hour: 11, min: 0, ehrId: "pt_004", display: "Tran, Wesley", reason: "Knee pain", status: "booked" },
        { hour: 14, min: 0, ehrId: "pt_001", display: "Aguirre, Marisol", reason: "Lab results review", status: "booked" },
      ];
    case 2:
      return [
        { hour: 8, min: 30, ehrId: "pt_003", display: "Bhattacharya, Priya", reason: "Foot exam", status: "booked" },
        { hour: 9, min: 0, ehrId: "pt_002", display: "Okafor, Daniel", reason: "Cough x2 weeks", status: "booked" },
        { hour: 10, min: 0, ehrId: "pt_004", display: "Tran, Wesley", reason: "PT progress", status: "booked" },
        { hour: 13, min: 30, ehrId: "pt_001", display: "Aguirre, Marisol", reason: "Med refill", status: "booked" },
      ];
    case 3:
      return [
        { hour: 9, min: 0, ehrId: "pt_004", display: "Tran, Wesley", reason: "MRI review", status: "booked" },
        { hour: 9, min: 45, ehrId: "pt_003", display: "Bhattacharya, Priya", reason: "A1c check", status: "booked" },
        { hour: 10, min: 30, ehrId: "pt_002", display: "Okafor, Daniel", reason: "Sinus pressure", status: "booked" },
        { hour: 11, min: 15, ehrId: "pt_001", display: "Aguirre, Marisol", reason: "BP recheck", status: "booked" },
        { hour: 14, min: 0, ehrId: "pt_002", display: "Okafor, Daniel", reason: "Vaccination", status: "booked" },
        { hour: 14, min: 45, ehrId: "pt_004", display: "Tran, Wesley", reason: "Post-op follow-up", status: "booked" },
      ];
    case 4:
      return [
        { hour: 8, min: 0, ehrId: "pt_001", display: "Aguirre, Marisol", reason: "Telehealth — fatigue", status: "booked" },
        { hour: 9, min: 30, ehrId: "pt_003", display: "Bhattacharya, Priya", reason: "Insulin titration", status: "booked" },
        { hour: 10, min: 30, ehrId: "pt_002", display: "Okafor, Daniel", reason: "Annual physical", status: "booked" },
      ];
    case 5:
      return [
        { hour: 9, min: 0, ehrId: "pt_002", display: "Okafor, Daniel", reason: "Headache eval", status: "booked" },
        { hour: 9, min: 30, ehrId: "pt_004", display: "Tran, Wesley", reason: "Brace fitting", status: "booked" },
        { hour: 10, min: 0, ehrId: "pt_001", display: "Aguirre, Marisol", reason: "Hypertension follow-up", status: "booked" },
        { hour: 10, min: 30, ehrId: "pt_003", display: "Bhattacharya, Priya", reason: "Diabetic foot check", status: "booked" },
        { hour: 11, min: 30, ehrId: "pt_002", display: "Okafor, Daniel", reason: "Wellness visit", status: "booked" },
      ];
    default:
      return [];
  }
}
