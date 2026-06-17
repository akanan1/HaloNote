import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import request from "supertest";
import {
  getDb,
  notesTable,
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

const ADMIN_EMAIL = "auto-push-admin@halonote.test";
const MEMBER_EMAIL = "auto-push-member@halonote.test";
const PASSWORD = "correct horse battery staple";
const ADMIN_DISPLAY = "Auto-Push Admin";
const MEMBER_DISPLAY = "Auto-Push Member";

async function loginAsAdmin() {
  const agent = request.agent(app);
  await agent.post("/api/auth/login").send({
    email: ADMIN_EMAIL,
    password: PASSWORD,
    totpCode: currentTotpCode(TEST_ADMIN_TOTP_SECRET),
  });
  return agent;
}

async function loginAsMember() {
  const agent = request.agent(app);
  await agent
    .post("/api/auth/login")
    .send({ email: MEMBER_EMAIL, password: PASSWORD });
  return agent;
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

interface SeedNote {
  id: string;
  patientId: string;
  authorId: string;
  body?: string;
  autoPushed: boolean;
  createdAt: Date;
  ehrPushedAt?: Date;
  ehrProvider?: string;
  ehrDocumentRef?: string;
  ehrError?: string;
}

async function seedNote(input: SeedNote) {
  await getDb().insert(notesTable).values({
    id: input.id,
    organizationId: "org_default",
    patientId: input.patientId,
    authorId: input.authorId,
    body: input.body ?? "scribed body",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    autoPushedWithoutReview: input.autoPushed,
    ...(input.ehrPushedAt ? { ehrPushedAt: input.ehrPushedAt } : {}),
    ...(input.ehrProvider ? { ehrProvider: input.ehrProvider } : {}),
    ...(input.ehrDocumentRef ? { ehrDocumentRef: input.ehrDocumentRef } : {}),
    ...(input.ehrError ? { ehrError: input.ehrError } : {}),
  });
}

describe("GET /admin/auto-pushed-notes (integration)", () => {
  let adminId: string;
  let memberId: string;

  beforeAll(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    const admin = await createTestUser({
      email: ADMIN_EMAIL,
      password: PASSWORD,
      displayName: ADMIN_DISPLAY,
      role: "admin",
    });
    adminId = admin.id;
    const member = await createTestUser({
      email: MEMBER_EMAIL,
      password: PASSWORD,
      displayName: MEMBER_DISPLAY,
      role: "member",
    });
    memberId = member.id;
    await seedPatient("pt_ap_aud_1", "MRN-AP-AUD-1");
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/admin/auto-pushed-notes");
    expect(res.status).toBe(401);
  });

  it("returns 403 to authenticated non-admins", async () => {
    const agent = await loginAsMember();
    const res = await agent.get("/api/admin/auto-pushed-notes");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
  });

  it("returns only notes flagged auto_pushed_without_review", async () => {
    const base = new Date("2026-06-10T12:00:00Z");
    await seedNote({
      id: "note_auto_a",
      patientId: "pt_ap_aud_1",
      authorId: memberId,
      autoPushed: true,
      createdAt: base,
      ehrPushedAt: base,
      ehrProvider: "athenahealth",
      ehrDocumentRef: "DocumentReference/abc",
    });
    await seedNote({
      id: "note_manual_b",
      patientId: "pt_ap_aud_1",
      authorId: memberId,
      autoPushed: false,
      createdAt: new Date(base.getTime() + 1000),
    });

    const agent = await loginAsAdmin();
    const res = await agent.get("/api/admin/auto-pushed-notes");
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { noteId: string }) => r.noteId)).toEqual([
      "note_auto_a",
    ]);
    expect(res.body.data[0]).toMatchObject({
      noteId: "note_auto_a",
      patientId: "pt_ap_aud_1",
      authorId: memberId,
      authorDisplayName: MEMBER_DISPLAY,
      ehrProvider: "athenahealth",
      ehrDocumentRef: "DocumentReference/abc",
    });
    // Body must not appear in the response — admin audit view is
    // metadata-only.
    expect(res.body.data[0].body).toBeUndefined();
    expect(res.body.nextCursor).toBeNull();
  });

  it("filters by userId", async () => {
    const base = new Date("2026-06-10T12:00:00Z");
    await seedNote({
      id: "note_member",
      patientId: "pt_ap_aud_1",
      authorId: memberId,
      autoPushed: true,
      createdAt: base,
    });
    await seedNote({
      id: "note_admin",
      patientId: "pt_ap_aud_1",
      authorId: adminId,
      autoPushed: true,
      createdAt: new Date(base.getTime() + 1000),
    });

    const agent = await loginAsAdmin();
    const res = await agent.get(
      `/api/admin/auto-pushed-notes?userId=${memberId}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { noteId: string }) => r.noteId)).toEqual([
      "note_member",
    ]);
  });

  it("filters by from/to date range", async () => {
    await seedNote({
      id: "note_before",
      patientId: "pt_ap_aud_1",
      authorId: memberId,
      autoPushed: true,
      createdAt: new Date("2026-06-09T12:00:00Z"),
    });
    await seedNote({
      id: "note_inside",
      patientId: "pt_ap_aud_1",
      authorId: memberId,
      autoPushed: true,
      createdAt: new Date("2026-06-10T12:00:00Z"),
    });
    await seedNote({
      id: "note_after",
      patientId: "pt_ap_aud_1",
      authorId: memberId,
      autoPushed: true,
      createdAt: new Date("2026-06-11T12:00:00Z"),
    });

    const agent = await loginAsAdmin();
    const res = await agent.get(
      "/api/admin/auto-pushed-notes?from=2026-06-10T00:00:00Z&to=2026-06-10T23:59:59Z",
    );
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { noteId: string }) => r.noteId)).toEqual([
      "note_inside",
    ]);
  });

  it("paginates with a stable opaque cursor and sorts newest-first", async () => {
    // Six rows with strictly increasing createdAt.
    for (let i = 0; i < 6; i++) {
      await seedNote({
        id: `note_p_${i}`,
        patientId: "pt_ap_aud_1",
        authorId: memberId,
        autoPushed: true,
        createdAt: new Date(`2026-06-10T12:00:${String(i).padStart(2, "0")}Z`),
      });
    }

    const agent = await loginAsAdmin();
    const page1 = await agent.get("/api/admin/auto-pushed-notes?limit=2");
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    // Newest first.
    expect(page1.body.data.map((r: { noteId: string }) => r.noteId)).toEqual([
      "note_p_5",
      "note_p_4",
    ]);
    expect(typeof page1.body.nextCursor).toBe("string");

    const page2 = await agent.get(
      `/api/admin/auto-pushed-notes?limit=2&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
    );
    expect(page2.body.data.map((r: { noteId: string }) => r.noteId)).toEqual([
      "note_p_3",
      "note_p_2",
    ]);

    const page3 = await agent.get(
      `/api/admin/auto-pushed-notes?limit=2&cursor=${encodeURIComponent(page2.body.nextCursor)}`,
    );
    expect(page3.body.data.map((r: { noteId: string }) => r.noteId)).toEqual([
      "note_p_1",
      "note_p_0",
    ]);
    expect(page3.body.nextCursor).toBeNull();

    // No overlap across pages.
    const allIds = [
      ...page1.body.data,
      ...page2.body.data,
      ...page3.body.data,
    ].map((r: { noteId: string }) => r.noteId);
    expect(new Set(allIds).size).toBe(6);
  });

  it("uses (createdAt, id) compound ordering so same-millisecond rows are stable", async () => {
    // Two rows with IDENTICAL createdAt — ordering should fall back to id DESC.
    const t = new Date("2026-06-10T12:00:00.000Z");
    await seedNote({
      id: "note_aa",
      patientId: "pt_ap_aud_1",
      authorId: memberId,
      autoPushed: true,
      createdAt: t,
    });
    await seedNote({
      id: "note_bb",
      patientId: "pt_ap_aud_1",
      authorId: memberId,
      autoPushed: true,
      createdAt: t,
    });

    const agent = await loginAsAdmin();
    const page1 = await agent.get("/api/admin/auto-pushed-notes?limit=1");
    expect(page1.body.data).toHaveLength(1);
    // id DESC: "note_bb" comes before "note_aa".
    expect(page1.body.data[0].noteId).toBe("note_bb");
    expect(page1.body.nextCursor).toBeTypeOf("string");

    const page2 = await agent.get(
      `/api/admin/auto-pushed-notes?limit=1&cursor=${encodeURIComponent(page1.body.nextCursor)}`,
    );
    expect(page2.body.data).toHaveLength(1);
    expect(page2.body.data[0].noteId).toBe("note_aa");
  });

  it("ignores notes belonging to other organizations", async () => {
    // Create a second org + patient + note that should NOT appear.
    await getDb()
      .insert(organizationsTable)
      .values({ id: "org_other", name: "Other Org", slug: "other-org" })
      .onConflictDoNothing();
    await getDb()
      .insert(patientsTable)
      .values({
        id: "pt_other",
        organizationId: "org_other",
        firstName: "Other",
        lastName: "Patient",
        dateOfBirth: "1990-01-01",
        mrn: "MRN-OTHER",
      })
      .onConflictDoNothing();
    await getDb().insert(notesTable).values({
      id: "note_other_org",
      organizationId: "org_other",
      patientId: "pt_other",
      authorId: memberId,
      body: "elsewhere",
      autoPushedWithoutReview: true,
    });

    // Plus one in the default org so we know the filter excluded the
    // other org but didn't break the happy-path.
    await seedNote({
      id: "note_default_org",
      patientId: "pt_ap_aud_1",
      authorId: memberId,
      autoPushed: true,
      createdAt: new Date("2026-06-10T12:00:00Z"),
    });

    const agent = await loginAsAdmin();
    const res = await agent.get("/api/admin/auto-pushed-notes");
    expect(res.status).toBe(200);
    const ids = res.body.data.map((r: { noteId: string }) => r.noteId);
    expect(ids).toContain("note_default_org");
    expect(ids).not.toContain("note_other_org");
  });
});
