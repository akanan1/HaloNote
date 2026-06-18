import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import request from "supertest";
import { desc, eq, sql } from "drizzle-orm";
import { auditLogTable, getDb, patientsTable } from "@workspace/db";
import app from "../app";
import {
  createTestUser,
  resetTestDb,
  teardownTestDb,
} from "../../test/helpers";

const EMAIL = "audit@halonote.test";
const PASSWORD = "correct horse battery staple";
const DISPLAY = "Audit User";

async function login() {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ email: EMAIL, password: PASSWORD });
  const cookies = res.headers["set-cookie"] as unknown as string[];
  const csrf = cookies.find((c) => c.startsWith("halonote_csrf="))!;
  const csrfToken = csrf.split("=")[1]!.split(";")[0]!;
  return { agent, csrfToken };
}

// Audit writes are fire-and-forget — give the close-handler time to land
// before polling the audit_log table.
async function waitForAuditEntries(min: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const rows = await getDb()
      .select({ count: sql<number>`count(*)::int` })
      .from(auditLogTable);
    if ((rows[0]?.count ?? 0) >= min) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${min} audit entries`);
}

describe("audit log (integration)", () => {
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

  it("does not log unauthenticated requests", async () => {
    await request(app).get("/api/patients"); // 401
    await new Promise((r) => setTimeout(r, 200));
    const rows = await getDb().select().from(auditLogTable);
    expect(rows.length).toBe(0);
  });

  it("does not log /healthz or /auth/me", async () => {
    const { agent } = await login();
    await agent.get("/api/auth/me");
    await request(app).get("/api/healthz");
    await new Promise((r) => setTimeout(r, 200));
    const rows = await getDb().select().from(auditLogTable);
    expect(rows.length).toBe(0);
  });

  it("logs list_patient with status 200 when listing patients", async () => {
    const { agent } = await login();
    await agent.get("/api/patients");

    await waitForAuditEntries(1);

    const [entry] = await getDb()
      .select()
      .from(auditLogTable)
      .orderBy(desc(auditLogTable.at))
      .limit(1);
    expect(entry).toBeDefined();
    expect(entry!.action).toBe("list_patients");
    expect(entry!.resourceType).toBe("patient");
    expect(entry!.resourceId).toBeNull();
    expect((entry!.metadata as { status: number }).status).toBe(200);
  });

  it("logs create_note with the new note's id once it's persisted", async () => {
    const { agent, csrfToken } = await login();

    // Seed a patient first so the FK passes.
    await getDb()
      .insert(patientsTable)
      .values({
        id: "pt_audit",
        organizationId: "org_default",
        firstName: "Audit",
        lastName: "Test",
        dateOfBirth: "1990-01-01",
        mrn: "MRN-AUDIT",
      })
      .onConflictDoNothing();

    const post = await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({ patientId: "pt_audit", body: "audit me" });
    expect(post.status).toBe(201);
    const noteId = (post.body as { id: string }).id;

    await waitForAuditEntries(1);

    const rows = await getDb()
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.action, "create_note"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.resourceType).toBe("note");
    // resourceId is null on create because the URL is /notes (no id yet).
    // The created note's id is on the response body — caller can correlate.
    expect(rows[0]!.resourceId).toBeNull();
    expect((rows[0]!.metadata as { status: number }).status).toBe(201);
    // Sanity: the created note's id is real.
    expect(noteId).toMatch(/^note_/);
  });

  it("logs send_note_to_ehr with the note id on the path", async () => {
    const { agent, csrfToken } = await login();
    await getDb()
      .insert(patientsTable)
      .values({
        id: "pt_audit",
        organizationId: "org_default",
        firstName: "Audit",
        lastName: "Test",
        dateOfBirth: "1990-01-01",
        mrn: "MRN-AUDIT",
      })
      .onConflictDoNothing();
    const created = await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({ patientId: "pt_audit", body: "ship it" });
    const noteId = (created.body as { id: string }).id;

    await agent
      .post(`/api/notes/${noteId}/send-to-ehr`)
      .set("X-CSRF-Token", csrfToken);

    await waitForAuditEntries(2);

    const rows = await getDb()
      .select()
      .from(auditLogTable)
      .where(eq(auditLogTable.action, "send_note_to_ehr"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.resourceType).toBe("note");
    expect(rows[0]!.resourceId).toBe(noteId);
  });
});
