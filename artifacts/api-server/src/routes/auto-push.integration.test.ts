import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { getDb, notesTable, patientsTable } from "@workspace/db";
import app from "../app";
import {
  createTestUser,
  resetTestDb,
  teardownTestDb,
} from "../../test/helpers";

const EMAIL = "autopush@halonote.test";
const PASSWORD = "correct horse battery staple";
const DISPLAY = "Auto Push User";

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

async function seedPatient(id: string, mrn: string) {
  await getDb()
    .insert(patientsTable)
    .values({
      id,
      organizationId: "org_default",
      firstName: "Test",
      lastName: "Patient",
      dateOfBirth: "1990-01-01",
      mrn,
    })
    .onConflictDoNothing();
}

describe("EHR auto-push (integration)", () => {
  beforeAll(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    await createTestUser({
      email: EMAIL,
      password: PASSWORD,
      displayName: DISPLAY,
    });
    await seedPatient("pt_ap1", "MRN-AP1");
  });

  it("GET /auth/me returns autoPushToEhr=false by default", async () => {
    const { agent } = await loginAgent();
    const res = await agent.get("/api/auth/me");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ autoPushToEhr: false });
  });

  it("PATCH /auth/me toggles autoPushToEhr and persists the change", async () => {
    const { agent, csrfToken } = await loginAgent();
    const on = await agent
      .patch("/api/auth/me")
      .set("X-CSRF-Token", csrfToken)
      .send({ autoPushToEhr: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ autoPushToEhr: true });

    const me = await agent.get("/api/auth/me");
    expect(me.body).toMatchObject({ autoPushToEhr: true });

    const off = await agent
      .patch("/api/auth/me")
      .set("X-CSRF-Token", csrfToken)
      .send({ autoPushToEhr: false });
    expect(off.body).toMatchObject({ autoPushToEhr: false });
  });

  it("approve with autoPushToEhr=true exports the note in one round-trip", async () => {
    const { agent, csrfToken } = await loginAgent();
    // Opt in first.
    await agent
      .patch("/api/auth/me")
      .set("X-CSRF-Token", csrfToken)
      .send({ autoPushToEhr: true });

    const created = await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({ patientId: "pt_ap1", body: "auto push me to the chart" });
    const noteId = (created.body as { id: string }).id;

    const approved = await agent
      .post(`/api/notes/${noteId}/approve`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    expect(approved.status).toBe(200);

    const [row] = await getDb()
      .select()
      .from(notesTable)
      .where(eq(notesTable.id, noteId));
    expect(row?.status).toBe("exported");
    expect(row?.ehrProvider).toBe("mock");
    expect(row?.ehrDocumentRef).toMatch(/^DocumentReference\//);
    expect(row?.ehrPushedAt).toBeInstanceOf(Date);
    expect(row?.ehrError).toBeNull();
  });

  it("approve with autoPushToEhr=false stops at approved with no EHR fields set", async () => {
    const { agent, csrfToken } = await loginAgent();
    const created = await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({ patientId: "pt_ap1", body: "manual flow keeps two taps" });
    const noteId = (created.body as { id: string }).id;

    const approved = await agent
      .post(`/api/notes/${noteId}/approve`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    expect(approved.status).toBe(200);

    const [row] = await getDb()
      .select()
      .from(notesTable)
      .where(eq(notesTable.id, noteId));
    expect(row?.status).toBe("approved");
    expect(row?.ehrProvider).toBeNull();
    expect(row?.ehrDocumentRef).toBeNull();
    expect(row?.ehrPushedAt).toBeNull();
  });
});
