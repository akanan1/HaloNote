// Targets the CDS chart-fetch failure path. The streaming bridge is
// the patient-facing transcript pipe — under no circumstance can a
// wedged EHR call (or a missing patient/ehr_patient_id) interrupt
// transcription. The test mocks `getPatientHistory` and the DB so the
// failure modes can be exercised without a real EHR or Postgres.

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("@workspace/db", () => ({
  getDb: vi.fn(),
  patientsTable: { ehrPatientId: "ehr_patient_id" },
  providerVerbalCuesTable: {},
  recordingJobsTable: { id: "id", patientId: "patient_id" },
}));

vi.mock("./ehr-history", () => ({
  getPatientHistory: vi.fn(),
}));

vi.mock("./auth", () => ({
  SESSION_COOKIE: "session",
  lookupSession: vi.fn(),
}));

// streaming-transcript pulls these in at module-load. We don't need
// their bodies for the loadCdsChart path; stub them so the import
// graph resolves cleanly under vitest.
vi.mock("@deepgram/sdk", () => ({
  createClient: vi.fn(),
  LiveTranscriptionEvents: {
    Open: "open",
    Transcript: "Transcript",
    Error: "error",
    Close: "close",
  },
}));

vi.mock("./live-billing-suggester", () => ({
  suggestLiveCodes: vi.fn().mockResolvedValue([]),
}));

vi.mock("./live-nudges", () => ({
  suggestLiveNudges: vi.fn().mockResolvedValue([]),
}));

vi.mock("./live-cds", () => ({
  suggestLiveCdsWarnings: vi.fn().mockResolvedValue([]),
}));

import { loadCdsChart } from "./streaming-transcript";
import { getDb } from "@workspace/db";
import { getPatientHistory } from "./ehr-history";

const mockGetDb = vi.mocked(getDb);
const mockGetHistory = vi.mocked(getPatientHistory);

function dbReturning(rows: { ehrPatientId: string | null }[]) {
  // Build the chainable .select().from().leftJoin().where().limit()
  // shape that the bridge uses. Each step returns `this` until limit,
  // which resolves to the row list.
  const chain: {
    select: (...a: unknown[]) => typeof chain;
    from: (...a: unknown[]) => typeof chain;
    leftJoin: (...a: unknown[]) => typeof chain;
    where: (...a: unknown[]) => typeof chain;
    limit: (...a: unknown[]) => Promise<typeof rows>;
  } = {
    select: () => chain,
    from: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return chain;
}

describe("loadCdsChart", () => {
  beforeEach(() => {
    mockGetDb.mockReset();
    mockGetHistory.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when jobId is missing (CDS opt-out by data shape)", async () => {
    const out = await loadCdsChart(null, "u_1");
    expect(out).toBeNull();
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockGetHistory).not.toHaveBeenCalled();
  });

  it("returns null when the recording job has no patient → no ehr_patient_id", async () => {
    mockGetDb.mockReturnValue(
      dbReturning([{ ehrPatientId: null }]) as unknown as ReturnType<
        typeof getDb
      >,
    );
    const out = await loadCdsChart("rec_abc", "u_1");
    expect(out).toBeNull();
    expect(mockGetHistory).not.toHaveBeenCalled();
  });

  it("returns null and does not throw when the EHR fetch rejects", async () => {
    mockGetDb.mockReturnValue(
      dbReturning([{ ehrPatientId: "pt_001" }]) as unknown as ReturnType<
        typeof getDb
      >,
    );
    mockGetHistory.mockRejectedValueOnce(new Error("upstream EHR down"));
    const out = await loadCdsChart("rec_abc", "u_1");
    expect(out).toBeNull();
  });

  it("returns null when the recording_jobs lookup itself throws", async () => {
    // Simulate a DB error inside the join — the bridge must still
    // return a session that streams transcripts; CDS is the only
    // capability lost.
    mockGetDb.mockImplementation(() => {
      throw new Error("db down");
    });
    const out = await loadCdsChart("rec_abc", "u_1");
    expect(out).toBeNull();
  });

  it("returns a shaped chart on the happy path", async () => {
    mockGetDb.mockReturnValue(
      dbReturning([{ ehrPatientId: "pt_001" }]) as unknown as ReturnType<
        typeof getDb
      >,
    );
    mockGetHistory.mockResolvedValueOnce({
      problems: [
        { id: "p1", text: "Essential hypertension", onsetDate: null },
      ],
      medications: [
        {
          id: "m1",
          text: "Lisinopril 20 mg tablet",
          dosage: "1 tab PO daily",
        },
      ],
      allergies: [
        {
          id: "a1",
          text: "Penicillin",
          severity: "moderate",
          reactions: ["Hives"],
        },
      ],
    });
    const out = await loadCdsChart("rec_abc", "u_1");
    expect(out).not.toBeNull();
    expect(out?.activeMeds[0]).toMatch(/Lisinopril/);
    expect(out?.allergies[0]).toMatch(/Penicillin/);
    expect(out?.allergies[0]).toMatch(/moderate/);
    expect(out?.conditions[0]).toMatch(/hypertension/i);
  });
});
