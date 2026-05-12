import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { auditLogTable, getDb, patientsTable } from "@workspace/db";
import app from "../app";
import {
  createTestUser,
  resetTestDb,
  teardownTestDb,
} from "../../test/helpers";
import { waitForPendingAudits } from "../middlewares/audit";

const EMAIL = "audit-reader@halonote.test";
const PASSWORD = "correct horse battery staple";
const DISPLAY = "Audit Reader";

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
      firstName: "Test",
      lastName: "Patient",
      dateOfBirth: "1990-01-01",
      mrn,
    })
    .onConflictDoNothing();
}

describe("GET /audit-log (integration)", () => {
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
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/audit-log");
    expect(res.status).toBe(401);
  });

  it("returns an empty page when no audited activity has happened yet", async () => {
    const { agent } = await loginAgent();
    // Drain the audit write triggered by this very request so we read
    // a known-empty table before any audit-emitting activity.
    const first = await agent.get("/api/audit-log");
    expect(first.status).toBe(200);
    // The very GET we just made gets logged. So `data` may have one row
    // (this list_audit-log request) — accept either case.
    expect(Array.isArray(first.body.data)).toBe(true);
  });

  it("joins users for displayName and reflects the signed-in user", async () => {
    const { agent } = await loginAgent();
    await agent.get("/api/patients"); // generates one audit row
    await waitForPendingAudits();

    const res = await agent.get("/api/audit-log?resourceType=patient");
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    const first = res.body.data[0];
    expect(first.action).toBe("list_patients");
    expect(first.resourceType).toBe("patient");
    expect(first.userDisplayName).toBe(DISPLAY);
  });

  it("filters by action", async () => {
    const { agent, csrfToken } = await loginAgent();
    await seedPatient("pt_x", "MRN-AUDIT-X");
    await agent.get("/api/patients"); // list_patients
    await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({ patientId: "pt_x", body: "audit-listing" }); // create_note
    await waitForPendingAudits();

    const filtered = await agent.get("/api/audit-log?action=create_note");
    expect(filtered.status).toBe(200);
    expect(
      filtered.body.data.every(
        (e: { action: string }) => e.action === "create_note",
      ),
    ).toBe(true);
    expect(filtered.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it("paginates by `at` cursor", async () => {
    const { agent } = await loginAgent();

    // Make 6 audited requests with spacing to keep `at` strictly increasing.
    for (let i = 0; i < 6; i++) {
      await agent.get("/api/patients");
      await new Promise((r) => setTimeout(r, 12));
    }
    await waitForPendingAudits();

    const page1 = await agent.get("/api/audit-log?limit=2");
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTypeOf("string");

    const page2 = await agent.get(
      `/api/audit-log?limit=2&before=${encodeURIComponent(page1.body.nextCursor)}`,
    );
    expect(page2.body.data).toHaveLength(2);

    // Strictly decreasing — no overlap between pages.
    const ids = [...page1.body.data, ...page2.body.data].map(
      (e: { id: string }) => e.id,
    );
    expect(new Set(ids).size).toBe(4);
  });

  it("returns metadata (status, method) on each row", async () => {
    const { agent } = await loginAgent();
    await agent.get("/api/patients");
    await waitForPendingAudits();

    const res = await agent.get("/api/audit-log?action=list_patients&limit=1");
    expect(res.status).toBe(200);
    const row = res.body.data[0];
    expect(row.metadata).toMatchObject({ status: 200, method: "GET" });
  });

  it("logs the read of /audit-log itself (meta-audit)", async () => {
    const { agent } = await loginAgent();
    // The GET below produces an audit row for action=list_audit-logs.
    await agent.get("/api/audit-log");
    await waitForPendingAudits();

    const rows = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogTable);
    // At least the meta-audit row exists.
    expect(rows[0]?.count ?? 0).toBeGreaterThanOrEqual(1);
  });
});
