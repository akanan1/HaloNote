import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import request from "supertest";
import app from "../app";
import {
  createTestUser,
  resetTestDb,
  teardownTestDb,
} from "../../test/helpers";

const TEST_EMAIL = "integration@halonote.test";
const TEST_PASSWORD = "correct horse battery staple";
const TEST_DISPLAY_NAME = "Integration User";

describe("auth flow (integration)", () => {
  beforeAll(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    await createTestUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      displayName: TEST_DISPLAY_NAME,
    });
  });

  it("rejects login with a wrong password", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL, password: "nope" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid_credentials" });
  });

  it("rejects login for an unknown email with the same generic error", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "ghost@nowhere", password: "x" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid_credentials" });
  });

  it("accepts correct creds, returns the user, and sets session + csrf cookies", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      email: TEST_EMAIL,
      displayName: TEST_DISPLAY_NAME,
    });

    const setCookie = res.headers["set-cookie"];
    expect(Array.isArray(setCookie)).toBe(true);
    const cookies = setCookie as unknown as string[];
    expect(cookies.some((c) => c.startsWith("halonote_session="))).toBe(true);
    expect(cookies.some((c) => c.startsWith("halonote_csrf="))).toBe(true);

    // Session cookie must be HttpOnly. CSRF cookie must NOT be (the SPA
    // needs to read it from document.cookie).
    const session = cookies.find((c) => c.startsWith("halonote_session="))!;
    const csrf = cookies.find((c) => c.startsWith("halonote_csrf="))!;
    expect(session.toLowerCase()).toContain("httponly");
    expect(csrf.toLowerCase()).not.toContain("httponly");
  });

  it("GET /auth/me requires a session cookie", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("end-to-end: login → /auth/me → logout → /auth/me", async () => {
    const agent = request.agent(app);

    const login = await agent
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    expect(login.status).toBe(200);

    const me = await agent.get("/api/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(TEST_EMAIL);

    const logout = await agent.post("/api/auth/logout");
    expect(logout.status).toBe(204);

    const meAfter = await agent.get("/api/auth/me");
    expect(meAfter.status).toBe(401);
  });
});

describe("CSRF (integration)", () => {
  beforeAll(async () => {
    await resetTestDb();
    await createTestUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      displayName: TEST_DISPLAY_NAME,
    });
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  it("rejects state-changing requests without the X-CSRF-Token header", async () => {
    const agent = request.agent(app);
    await agent
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });

    // No header — should 403.
    const res = await agent
      .post("/api/notes")
      .send({ patientId: "pt_001", body: "test" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "csrf_failed" });
  });

  it("accepts requests with a matching X-CSRF-Token header", async () => {
    const agent = request.agent(app);
    const login = await agent
      .post("/api/auth/login")
      .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
    const cookies = login.headers["set-cookie"] as unknown as string[];
    const csrf = cookies.find((c) => c.startsWith("halonote_csrf="))!;
    const csrfToken = csrf.split("=")[1]!.split(";")[0]!;

    // Insert a patient first so the FK on /notes succeeds.
    // (We hit the DB directly rather than going through a route — patients
    // are seeded at server startup only, which we don't run in tests.)
    const { getDb, patientsTable } = await import("@workspace/db");
    await getDb()
      .insert(patientsTable)
      .values({
        id: "pt_test",
        firstName: "Test",
        lastName: "Patient",
        dateOfBirth: "1990-01-01",
        mrn: "MRN-TEST",
      })
      .onConflictDoNothing();

    const res = await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({ patientId: "pt_test", body: "integration note" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      patientId: "pt_test",
      body: "integration note",
      author: { displayName: TEST_DISPLAY_NAME },
    });
  });
});
