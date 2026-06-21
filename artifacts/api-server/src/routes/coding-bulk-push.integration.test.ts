// Integration tests for the bulk-approve push path. Mock-mode pushes
// always succeed with synthetic refs; we cover:
//
//   - Successful push: codes promoted, ehrDocumentRef set, session
//     transitions to 'complete', encounter auto-advances to 'completed'
//   - Idempotency: re-running bulk-approve on a 'complete' session
//     doesn't double-insert
//   - Retry path: failed pushes (simulated via direct DB writes since
//     mock never fails organically) get re-pushed on re-run

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import {
  approvedBillingCodesTable,
  auditLogTable,
  billingSuggestionsTable,
  encounterCodingSessionsTable,
  encountersTable,
  getDb,
  patientsTable,
} from "@workspace/db";
import { like } from "drizzle-orm";
import app from "../app";
import {
  createTestUser,
  resetTestDb,
  teardownTestDb,
} from "../../test/helpers";

const EMAIL = "bulk@halonote.test";
const PASSWORD = "correct horse battery staple";
const DISPLAY = "Bulk User";

async function loginAgent() {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ email: EMAIL, password: PASSWORD });
  const cookies = res.headers["set-cookie"] as unknown as string[];
  const csrf = cookies.find((c) => c.startsWith("halonote_csrf="))!;
  const csrfToken = csrf.split("=")[1]!.split(";")[0]!;
  return { agent, csrfToken };
}

async function seedPatient(id: string) {
  await getDb()
    .insert(patientsTable)
    .values({
      id,
      organizationId: "org_default",
      firstName: "Test",
      lastName: "Patient",
      dateOfBirth: "1990-01-01",
      mrn: `MRN-${id}`,
    })
    .onConflictDoNothing();
}

async function seedAndGenerate(
  agent: ReturnType<typeof request.agent>,
  csrfToken: string,
): Promise<{ encounterId: string; sessionId: string }> {
  const enc = await agent
    .post("/api/encounters")
    .set("X-CSRF-Token", csrfToken)
    .send({ patientId: "pt_b1", visitType: "established_patient" });
  const encounterId = (enc.body as { id: string }).id;
  await agent
    .post("/api/notes")
    .set("X-CSRF-Token", csrfToken)
    .send({
      patientId: "pt_b1",
      encounterId,
      body: "Assessment: T2DM, HTN. Plan: continue meds.",
    });
  const gen = await agent
    .post(`/api/encounters/${encounterId}/coding/generate`)
    .set("X-CSRF-Token", csrfToken)
    .send({});
  return { encounterId, sessionId: gen.body.session.id };
}

describe("coding bulk-approve push (integration)", () => {
  beforeAll(async () => {
    await resetTestDb();
    process.env["CODING_SUGGESTER"] = "stub";
    // Ensure EHR_MODE is mock (default) — never let CI accidentally point
    // at a real Athena.
    delete process.env["EHR_MODE"];
  });

  afterAll(async () => {
    delete process.env["CODING_SUGGESTER"];
    await teardownTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    await createTestUser({
      email: EMAIL,
      password: PASSWORD,
      displayName: DISPLAY,
    });
    await seedPatient("pt_b1");
  });

  it("bulk-approve in mock mode pushes every promoted code with synthetic refs", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { encounterId, sessionId } = await seedAndGenerate(
      agent,
      csrfToken,
    );

    // Force every suggestion to high confidence so the bulk-approve
    // floor doesn't skip them. Stub coder defaults most to 'low'.
    await getDb()
      .update(billingSuggestionsTable)
      .set({ confidence: "high" })
      .where(eq(billingSuggestionsTable.codingSessionId, sessionId));

    const res = await agent
      .post(`/api/coding/sessions/${sessionId}/approve-all-high-confidence`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.approvedCount).toBeGreaterThan(0);
    expect(res.body.pushedBillingCount).toBe(res.body.approvedCount);
    expect(res.body.pushFailedCount).toBe(0);
    expect(res.body.session.status).toBe("complete");

    // Every approved row should carry a synthetic ehrDocumentRef.
    const approved = await getDb()
      .select()
      .from(approvedBillingCodesTable)
      .where(eq(approvedBillingCodesTable.encounterId, encounterId));
    expect(approved.length).toBe(res.body.approvedCount);
    for (const row of approved) {
      expect(row.exportedAt).not.toBeNull();
      expect(row.ehrDocumentRef).toMatch(/^(Claim|Charge)\/mock-/);
      expect(row.ehrError).toBeNull();
    }
  });

  it("encounter auto-advances to 'completed' on a clean writeback", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { encounterId, sessionId } = await seedAndGenerate(
      agent,
      csrfToken,
    );
    await getDb()
      .update(billingSuggestionsTable)
      .set({ confidence: "high" })
      .where(eq(billingSuggestionsTable.codingSessionId, sessionId));

    await agent
      .post(`/api/coding/sessions/${sessionId}/approve-all-high-confidence`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    const [enc] = await getDb()
      .select()
      .from(encountersTable)
      .where(eq(encountersTable.id, encounterId));
    expect(enc!.status).toBe("completed");
    expect(enc!.completedAt).not.toBeNull();
  });

  it("re-running bulk-approve on a complete session is idempotent (no duplicate inserts)", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { encounterId, sessionId } = await seedAndGenerate(
      agent,
      csrfToken,
    );
    await getDb()
      .update(billingSuggestionsTable)
      .set({ confidence: "high" })
      .where(eq(billingSuggestionsTable.codingSessionId, sessionId));

    const first = await agent
      .post(`/api/coding/sessions/${sessionId}/approve-all-high-confidence`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    const firstApprovedCount = await getDb()
      .select()
      .from(approvedBillingCodesTable)
      .where(eq(approvedBillingCodesTable.encounterId, encounterId))
      .then((rows) => rows.length);

    // Second click of "Approve and Write" — should be a no-op for inserts.
    const second = await agent
      .post(`/api/coding/sessions/${sessionId}/approve-all-high-confidence`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    const secondApprovedCount = await getDb()
      .select()
      .from(approvedBillingCodesTable)
      .where(eq(approvedBillingCodesTable.encounterId, encounterId))
      .then((rows) => rows.length);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(secondApprovedCount).toBe(firstApprovedCount);
    // Second run found nothing new to approve; the session's already-
    // promoted rows are all exported.
    expect(second.body.approvedCount).toBe(0);
  });

  it("retry path picks up codes whose push failed on a prior run", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { encounterId, sessionId } = await seedAndGenerate(
      agent,
      csrfToken,
    );
    await getDb()
      .update(billingSuggestionsTable)
      .set({ confidence: "high" })
      .where(eq(billingSuggestionsTable.codingSessionId, sessionId));

    await agent
      .post(`/api/coding/sessions/${sessionId}/approve-all-high-confidence`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    // Simulate a partial push failure: clear one row's exportedAt + set
    // an ehrError (would happen organically when EHR_MODE=athenahealth
    // and the chart API returns 5xx on that row).
    const approved = await getDb()
      .select()
      .from(approvedBillingCodesTable)
      .where(eq(approvedBillingCodesTable.encounterId, encounterId));
    expect(approved.length).toBeGreaterThan(0);
    const target = approved[0]!;
    await getDb()
      .update(approvedBillingCodesTable)
      .set({
        exportedAt: null,
        ehrDocumentRef: null,
        ehrError: "athena_chart_502: upstream temporarily unavailable",
      })
      .where(eq(approvedBillingCodesTable.id, target.id));

    // Also flip the session back to 'failed' so the UI/route would
    // surface the retry banner.
    await getDb()
      .update(encounterCodingSessionsTable)
      .set({ status: "failed", failureReason: "simulated partial failure" })
      .where(eq(encounterCodingSessionsTable.id, sessionId));

    // Click "Approve and Write" again — the retry path picks up just
    // this one row, re-pushes, and lands on 'complete'.
    const retry = await agent
      .post(`/api/coding/sessions/${sessionId}/approve-all-high-confidence`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(retry.status).toBe(200);
    expect(retry.body.approvedCount).toBe(0); // no NEW promotions
    expect(retry.body.pushedBillingCount).toBe(1); // the one retry
    expect(retry.body.pushFailedCount).toBe(0);
    expect(retry.body.session.status).toBe("complete");

    // The previously-failed row should now be exported with a fresh ref
    // and no error.
    const [rePushed] = await getDb()
      .select()
      .from(approvedBillingCodesTable)
      .where(eq(approvedBillingCodesTable.id, target.id));
    expect(rePushed!.exportedAt).not.toBeNull();
    expect(rePushed!.ehrDocumentRef).toMatch(/^(Claim|Charge)\/mock-/);
    expect(rePushed!.ehrError).toBeNull();
  });

  it("bulk-approve from 'wrong_state' (queued / extracting) returns 409", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { sessionId } = await seedAndGenerate(agent, csrfToken);
    // Force session into a non-terminal-non-actionable state.
    await getDb()
      .update(encounterCodingSessionsTable)
      .set({ status: "extracting" })
      .where(eq(encounterCodingSessionsTable.id, sessionId));

    const res = await agent
      .post(`/api/coding/sessions/${sessionId}/approve-all-high-confidence`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("session_not_ready_for_approval");
  });

  it("bulk-approve with no high-confidence rows + no retryable failures returns ok with zero counts", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { sessionId } = await seedAndGenerate(agent, csrfToken);
    // Default stub confidence is mostly 'low'; the floor is 'high', so
    // nothing qualifies and there are no pre-existing failed pushes.
    const res = await agent
      .post(`/api/coding/sessions/${sessionId}/approve-all-high-confidence`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.approvedCount).toBe(0);
    expect(res.body.pushedBillingCount).toBe(0);
    expect(res.body.pushFailedCount).toBe(0);
    // skippedCount should be the total suggestions (all left for review).
    expect(res.body.skippedCount).toBeGreaterThan(0);
  });
});

// Verify the new structured audit-event table inserts are landing.
// Light touch: confirm rows exist with the right action verbs after
// a successful generate + bulk-approve. Detailed metadata assertions
// belong in a dedicated audit-events test once we add one.
describe("coder audit events (integration smoke)", () => {
  beforeAll(async () => {
    await resetTestDb();
    process.env["CODING_SUGGESTER"] = "stub";
    delete process.env["EHR_MODE"];
  });

  afterAll(async () => {
    delete process.env["CODING_SUGGESTER"];
    await teardownTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    await createTestUser({
      email: EMAIL,
      password: PASSWORD,
      displayName: DISPLAY,
    });
    await seedPatient("pt_b1");
  });

  it("generate + bulk-approve emit structured audit-log entries", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { sessionId } = await seedAndGenerate(agent, csrfToken);
    await getDb()
      .update(billingSuggestionsTable)
      .set({ confidence: "high" })
      .where(eq(billingSuggestionsTable.codingSessionId, sessionId));
    await agent
      .post(`/api/coding/sessions/${sessionId}/approve-all-high-confidence`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    // Brief wait for fire-and-forget audit writes to land.
    await new Promise((r) => setTimeout(r, 200));

    const rows = await getDb()
      .select({
        action: auditLogTable.action,
        resourceId: auditLogTable.resourceId,
      })
      .from(auditLogTable)
      .where(
        and(
          eq(auditLogTable.resourceId, sessionId),
          like(auditLogTable.action, "coder.%"),
        ),
      );
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("coder.generate.completed");
    expect(
      actions.some(
        (a) =>
          a === "coder.session.writeback.completed" ||
          a === "coder.session.writeback.partial_failure",
      ),
    ).toBe(true);
  });
});
