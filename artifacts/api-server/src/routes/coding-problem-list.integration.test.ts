// Integration tests for the problem-list reconciliation endpoints.
//
//   POST /coding/sessions/:id/reconcile-problems
//   GET  /coding/sessions/:id/problem-suggestions
//   POST /problem-list-suggestions/:id/accept
//   POST /problem-list-suggestions/:id/reject
//
// Stub-mode reconciler emits naive "add" suggestions for every note ICD
// not already in patient_problems. The auto-fire on coding-generate fires
// it once; explicit POST /reconcile-problems re-runs (idempotent — wipes
// prior session suggestions).

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
  getDb,
  patientProblemsTable,
  patientsTable,
  problemListSuggestionsTable,
} from "@workspace/db";
import app from "../app";
import {
  createTestUser,
  resetTestDb,
  teardownTestDb,
} from "../../test/helpers";

const EMAIL = "pl@halonote.test";
const PASSWORD = "correct horse battery staple";
const DISPLAY = "PL User";

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

async function seedCodingSession(
  agent: ReturnType<typeof request.agent>,
  csrfToken: string,
): Promise<{ encounterId: string; sessionId: string }> {
  const enc = await agent
    .post("/api/encounters")
    .set("X-CSRF-Token", csrfToken)
    .send({ patientId: "pt_pl1", visitType: "established_patient" });
  const encounterId = (enc.body as { id: string }).id;
  await agent
    .post("/api/notes")
    .set("X-CSRF-Token", csrfToken)
    .send({
      patientId: "pt_pl1",
      encounterId,
      // Section header on its own line — parseNoteSections requires it
      // (see note-section-parser.ts SECTION_DEFS). An inline
      // "Assessment: …" leaves parsedSections empty and reconcile
      // short-circuits to no suggestions.
      body: "Assessment:\nType 2 DM, HTN.",
    });
  const gen = await agent
    .post(`/api/encounters/${encounterId}/coding/generate`)
    .set("X-CSRF-Token", csrfToken)
    .send({});
  return { encounterId, sessionId: gen.body.session.id };
}

describe("problem-list routes (integration)", () => {
  beforeAll(async () => {
    await resetTestDb();
    process.env["CODING_SUGGESTER"] = "stub";
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
    await seedPatient("pt_pl1");
  });

  it("POST /coding/sessions/:id/reconcile-problems creates suggestions linked to session", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { sessionId } = await seedCodingSession(agent, csrfToken);

    // The auto-fire on generate already ran reconcile once. Hit the
    // explicit endpoint to re-run + verify idempotency (it wipes prior
    // session suggestions and re-inserts).
    const res = await agent
      .post(`/api/coding/sessions/${sessionId}/reconcile-problems`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.ehrHit).toBe(false); // mock mode, no Athena hit
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(Array.isArray(res.body.problems)).toBe(true);

    // Stub reconciler emits naive "add" for ICDs not on the chart.
    // Stub coder emits one Z00.00 placeholder ICD, so we should get
    // exactly one "add" suggestion (no problems on the chart yet).
    const adds = res.body.data.filter(
      (s: { action: string }) => s.action === "add",
    );
    expect(adds.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /coding/sessions/:id/problem-suggestions returns the persisted set", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { sessionId } = await seedCodingSession(agent, csrfToken);
    await agent
      .post(`/api/coding/sessions/${sessionId}/reconcile-problems`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    const got = await agent.get(
      `/api/coding/sessions/${sessionId}/problem-suggestions`,
    );
    expect(got.status).toBe(200);
    expect(Array.isArray(got.body.data)).toBe(true);
    for (const s of got.body.data) {
      expect(s.codingSessionId).toBe(sessionId);
      expect(s.status).toBe("suggested");
    }
  });

  it("POST /problem-list-suggestions/:id/accept applies the action locally + persists patient_problems row", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { sessionId } = await seedCodingSession(agent, csrfToken);
    const reconcile = await agent
      .post(`/api/coding/sessions/${sessionId}/reconcile-problems`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    const addSuggestion = reconcile.body.data.find(
      (s: { action: string }) => s.action === "add",
    );
    expect(addSuggestion).toBeDefined();

    const res = await agent
      .post(`/api/problem-list-suggestions/${addSuggestion.id}/accept`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");
    expect(res.body.appliedLocally).toBe(true);

    // patient_problems should now have a row for the proposed code.
    const problems = await getDb()
      .select()
      .from(patientProblemsTable)
      .where(
        and(
          eq(patientProblemsTable.patientId, "pt_pl1"),
          eq(patientProblemsTable.code, addSuggestion.proposedCode),
        ),
      );
    expect(problems.length).toBe(1);
    expect(problems[0]!.ehrSource).toBe("manual");
  });

  it("POST /problem-list-suggestions/:id/reject records the reason without mutating patient_problems", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { sessionId } = await seedCodingSession(agent, csrfToken);
    const reconcile = await agent
      .post(`/api/coding/sessions/${sessionId}/reconcile-problems`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    const target = reconcile.body.data[0];
    expect(target).toBeDefined();

    const res = await agent
      .post(`/api/problem-list-suggestions/${target.id}/reject`)
      .set("X-CSRF-Token", csrfToken)
      .send({ reason: "Not relevant to today's visit" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("rejected");
    expect(res.body.appliedLocally).toBe(false);
    expect(res.body.statusNote).toContain("Not relevant");

    // Verify nothing landed in patient_problems for this code.
    if (target.proposedCode) {
      const problems = await getDb()
        .select()
        .from(patientProblemsTable)
        .where(
          and(
            eq(patientProblemsTable.patientId, "pt_pl1"),
            eq(patientProblemsTable.code, target.proposedCode),
          ),
        );
      expect(problems.length).toBe(0);
    }
  });

  it("re-running reconcile-problems is idempotent — wipes prior session suggestions", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { sessionId } = await seedCodingSession(agent, csrfToken);
    await agent
      .post(`/api/coding/sessions/${sessionId}/reconcile-problems`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    const first = await getDb()
      .select()
      .from(problemListSuggestionsTable)
      .where(eq(problemListSuggestionsTable.codingSessionId, sessionId));
    const firstCount = first.length;

    await agent
      .post(`/api/coding/sessions/${sessionId}/reconcile-problems`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    const second = await getDb()
      .select()
      .from(problemListSuggestionsTable)
      .where(eq(problemListSuggestionsTable.codingSessionId, sessionId));

    // Same number of rows (stub is deterministic) — and the ids differ,
    // confirming the old set was deleted and a fresh set was inserted.
    expect(second.length).toBe(firstCount);
    const firstIds = new Set(first.map((r) => r.id));
    const overlap = second.filter((r) => firstIds.has(r.id));
    expect(overlap.length).toBe(0);
  });
});
