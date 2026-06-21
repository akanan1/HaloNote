import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import {
  appointmentClaimsTable,
  getDb,
  organizationsTable,
  patientsTable,
} from "@workspace/db";
import app from "../app";
import {
  TEST_ADMIN_TOTP_SECRET,
  createTestUser,
  currentTotpCode,
  resetTestDb,
  teardownTestDb,
} from "../../test/helpers";

const PROVIDER_EMAIL = "claim-test-provider@halonote.test";
const OTHER_PROVIDER_EMAIL = "claim-test-other@halonote.test";
const PASSWORD = "correct horse battery staple";

async function loginAgent(email: string) {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({
    email,
    password: PASSWORD,
    totpCode: currentTotpCode(TEST_ADMIN_TOTP_SECRET),
  });
  const cookies = res.headers["set-cookie"] as unknown as string[];
  const csrf = cookies.find((c) => c.startsWith("halonote_csrf="))!;
  const csrfToken = csrf.split("=")[1]!.split(";")[0]!;
  return { agent, csrfToken, userId: (res.body as { id: string }).id };
}

async function seedPatient(id: string, mrn: string, orgId = "org_default") {
  await getDb()
    .insert(patientsTable)
    .values({
      id,
      organizationId: orgId,
      firstName: "Test",
      lastName: "Patient",
      dateOfBirth: "1990-01-01",
      mrn,
    })
    .onConflictDoNothing();
}

describe("appointment-claims routes (integration)", () => {
  beforeAll(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    await createTestUser({
      email: PROVIDER_EMAIL,
      password: PASSWORD,
      displayName: "Provider One",
      role: "member",
    });
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/appointment-claims/mine");
    expect(res.status).toBe(401);
  });

  it("POST creates a claim and GET /mine returns it", async () => {
    const { agent, csrfToken } = await loginAgent(PROVIDER_EMAIL);
    await seedPatient("pt_c1", "MRN-CLAIM-1");

    const post = await agent
      .post("/api/appointment-claims")
      .set("X-CSRF-Token", csrfToken)
      .send({ appointmentId: "appt-1", patientId: "pt_c1" });
    expect(post.status).toBe(201);
    expect(post.body).toMatchObject({
      appointmentId: "appt-1",
      patientId: "pt_c1",
    });
    expect(typeof post.body.claimedAt).toBe("string");
    expect(typeof post.body.expiresAt).toBe("string");

    const list = await agent.get("/api/appointment-claims/mine");
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].appointmentId).toBe("appt-1");
  });

  it("POST is idempotent — re-claiming the same appointment by the same user replaces the row", async () => {
    const { agent, csrfToken } = await loginAgent(PROVIDER_EMAIL);
    await seedPatient("pt_c2a", "MRN-CLAIM-2A");
    await seedPatient("pt_c2b", "MRN-CLAIM-2B");

    await agent
      .post("/api/appointment-claims")
      .set("X-CSRF-Token", csrfToken)
      .send({ appointmentId: "appt-2", patientId: "pt_c2a" });

    // Re-claim with a different patient — represents the provider
    // realising they correlated the wrong patient. Should replace, not
    // duplicate.
    const second = await agent
      .post("/api/appointment-claims")
      .set("X-CSRF-Token", csrfToken)
      .send({ appointmentId: "appt-2", patientId: "pt_c2b" });
    expect(second.status).toBe(201);
    expect(second.body.patientId).toBe("pt_c2b");

    const list = await agent.get("/api/appointment-claims/mine");
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].patientId).toBe("pt_c2b");
  });

  it("DELETE releases a claim and is idempotent on missing rows", async () => {
    const { agent, csrfToken } = await loginAgent(PROVIDER_EMAIL);
    await seedPatient("pt_c3", "MRN-CLAIM-3");

    await agent
      .post("/api/appointment-claims")
      .set("X-CSRF-Token", csrfToken)
      .send({ appointmentId: "appt-3", patientId: "pt_c3" });

    const del = await agent
      .delete("/api/appointment-claims/appt-3")
      .set("X-CSRF-Token", csrfToken);
    expect(del.status).toBe(204);

    const list = await agent.get("/api/appointment-claims/mine");
    expect(list.body.data).toHaveLength(0);

    // Replay — still 204 (idempotent).
    const replay = await agent
      .delete("/api/appointment-claims/appt-3")
      .set("X-CSRF-Token", csrfToken);
    expect(replay.status).toBe(204);
  });

  it("GET /mine omits expired claims (server-enforced TTL)", async () => {
    const { agent, csrfToken, userId } = await loginAgent(PROVIDER_EMAIL);
    await seedPatient("pt_c4", "MRN-CLAIM-4");

    await agent
      .post("/api/appointment-claims")
      .set("X-CSRF-Token", csrfToken)
      .send({ appointmentId: "appt-4", patientId: "pt_c4" });

    // Backdate expires_at to the past — simulates a row that survived
    // past the 7-day TTL.
    await getDb()
      .update(appointmentClaimsTable)
      .set({ expiresAt: sql`NOW() - INTERVAL '1 hour'` })
      .where(
        and(
          eq(appointmentClaimsTable.appointmentId, "appt-4"),
          eq(appointmentClaimsTable.userId, userId),
        ),
      );

    const list = await agent.get("/api/appointment-claims/mine");
    expect(list.body.data).toHaveLength(0);
  });

  it("POST 404s when the patient belongs to another org (cross-tenant guard)", async () => {
    // Seed a foreign org + patient.
    await getDb()
      .insert(organizationsTable)
      .values({ id: "org_other_claims", name: "Other", slug: "other-claims" })
      .onConflictDoNothing();
    await seedPatient("pt_foreign", "MRN-CLAIM-FOREIGN", "org_other_claims");

    const { agent, csrfToken } = await loginAgent(PROVIDER_EMAIL);
    const res = await agent
      .post("/api/appointment-claims")
      .set("X-CSRF-Token", csrfToken)
      .send({ appointmentId: "appt-5", patientId: "pt_foreign" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "patient_not_found" });
  });

  it("GET /mine does not return other providers' claims even within the same org", async () => {
    await createTestUser({
      email: OTHER_PROVIDER_EMAIL,
      password: PASSWORD,
      displayName: "Provider Two",
      role: "member",
    });
    await seedPatient("pt_c6", "MRN-CLAIM-6");

    // Provider Two claims appointment-6.
    const other = await loginAgent(OTHER_PROVIDER_EMAIL);
    await other.agent
      .post("/api/appointment-claims")
      .set("X-CSRF-Token", other.csrfToken)
      .send({ appointmentId: "appt-6", patientId: "pt_c6" });

    // Provider One's /mine list must be empty — they didn't claim it.
    const me = await loginAgent(PROVIDER_EMAIL);
    const list = await me.agent.get("/api/appointment-claims/mine");
    expect(list.body.data).toHaveLength(0);
  });

  it("POST as a second provider on the same appointment replaces the first claim (last-write-wins)", async () => {
    await createTestUser({
      email: OTHER_PROVIDER_EMAIL,
      password: PASSWORD,
      displayName: "Provider Two",
      role: "member",
    });
    await seedPatient("pt_c7", "MRN-CLAIM-7");

    const one = await loginAgent(PROVIDER_EMAIL);
    await one.agent
      .post("/api/appointment-claims")
      .set("X-CSRF-Token", one.csrfToken)
      .send({ appointmentId: "appt-7", patientId: "pt_c7" });

    const two = await loginAgent(OTHER_PROVIDER_EMAIL);
    const overwrite = await two.agent
      .post("/api/appointment-claims")
      .set("X-CSRF-Token", two.csrfToken)
      .send({ appointmentId: "appt-7", patientId: "pt_c7" });
    expect(overwrite.status).toBe(201);

    // Provider One's view: claim gone.
    const oneList = await one.agent.get("/api/appointment-claims/mine");
    expect(oneList.body.data).toHaveLength(0);

    // Provider Two's view: holds the claim now.
    const twoList = await two.agent.get("/api/appointment-claims/mine");
    expect(twoList.body.data).toHaveLength(1);
    expect(twoList.body.data[0].appointmentId).toBe("appt-7");
  });
});
