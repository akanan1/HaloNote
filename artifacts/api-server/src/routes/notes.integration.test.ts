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

const EMAIL = "notes@halonote.test";
const PASSWORD = "correct horse battery staple";
const DISPLAY = "Notes User";

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

describe("notes routes (integration)", () => {
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
    await seedPatient("pt_n1", "MRN-N1");
    await seedPatient("pt_n2", "MRN-N2");
  });

  it("POST /notes records authorId and embeds author in the response", async () => {
    const { agent, csrfToken } = await loginAgent();
    const res = await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({ patientId: "pt_n1", body: "hello" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      patientId: "pt_n1",
      body: "hello",
      author: { displayName: DISPLAY },
    });

    // updatedAt == createdAt on a freshly-created note.
    expect(res.body.updatedAt).toBe(res.body.createdAt);
  });

  it("GET /notes/:id returns 404 for an unknown id", async () => {
    const { agent } = await loginAgent();
    const res = await agent.get("/api/notes/note_does_not_exist");
    expect(res.status).toBe(404);
  });

  it("PATCH /notes/:id updates the body and bumps updatedAt", async () => {
    const { agent, csrfToken } = await loginAgent();
    const created = await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({ patientId: "pt_n1", body: "original" });
    const noteId = (created.body as { id: string }).id;
    const originalCreatedAt = (created.body as { createdAt: string }).createdAt;

    // Give the clock a tick so updatedAt differs from createdAt.
    await new Promise((r) => setTimeout(r, 50));

    const patched = await agent
      .patch(`/api/notes/${noteId}`)
      .set("X-CSRF-Token", csrfToken)
      .send({ body: "revised" });

    expect(patched.status).toBe(200);
    expect(patched.body.body).toBe("revised");
    expect(patched.body.createdAt).toBe(originalCreatedAt);
    expect(new Date(patched.body.updatedAt).getTime()).toBeGreaterThan(
      new Date(originalCreatedAt).getTime(),
    );
  });

  it("PATCH /notes/:id rejects an empty body with 400", async () => {
    const { agent, csrfToken } = await loginAgent();
    const created = await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({ patientId: "pt_n1", body: "original" });
    const noteId = (created.body as { id: string }).id;

    const res = await agent
      .patch(`/api/notes/${noteId}`)
      .set("X-CSRF-Token", csrfToken)
      .send({ body: "" });
    expect(res.status).toBe(400);
  });

  it("GET /notes?patientId filters server-side", async () => {
    const { agent, csrfToken } = await loginAgent();
    for (const [pid, body] of [
      ["pt_n1", "n1 first"],
      ["pt_n2", "n2 first"],
      ["pt_n1", "n1 second"],
    ] as const) {
      await agent
        .post("/api/notes")
        .set("X-CSRF-Token", csrfToken)
        .send({ patientId: pid, body });
    }

    const res = await agent.get("/api/notes?patientId=pt_n1");
    expect(res.status).toBe(200);
    const notes = res.body.data as Array<{ patientId: string }>;
    expect(notes).toHaveLength(2);
    expect(notes.every((n) => n.patientId === "pt_n1")).toBe(true);
  });

  it("GET /notes paginates by createdAt cursor", async () => {
    const { agent, csrfToken } = await loginAgent();
    // 5 notes, spaced so createdAt is strictly increasing.
    for (let i = 0; i < 5; i++) {
      await agent
        .post("/api/notes")
        .set("X-CSRF-Token", csrfToken)
        .send({ patientId: "pt_n1", body: `note ${i}` });
      await new Promise((r) => setTimeout(r, 15));
    }

    const page1 = await agent.get("/api/notes?limit=2");
    expect(page1.status).toBe(200);
    expect(page1.body.data).toHaveLength(2);
    expect(page1.body.nextCursor).toBeTypeOf("string");

    const page2 = await agent.get(
      `/api/notes?limit=2&before=${encodeURIComponent(page1.body.nextCursor)}`,
    );
    expect(page2.body.data).toHaveLength(2);
    expect(page2.body.nextCursor).toBeTypeOf("string");

    const page3 = await agent.get(
      `/api/notes?limit=2&before=${encodeURIComponent(page2.body.nextCursor)}`,
    );
    expect(page3.body.data).toHaveLength(1);
    expect(page3.body.nextCursor).toBeNull();

    // Strictly decreasing createdAt order across pages — no overlap.
    const ids = [
      ...page1.body.data,
      ...page2.body.data,
      ...page3.body.data,
    ].map((n: { id: string }) => n.id);
    expect(new Set(ids).size).toBe(5);
  });

  it("DELETE /notes/:id soft-deletes (sets status=entered-in-error)", async () => {
    const { agent, csrfToken } = await loginAgent();
    const created = await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({ patientId: "pt_n1", body: "to be withdrawn" });
    const noteId = (created.body as { id: string }).id;

    const del = await agent
      .delete(`/api/notes/${noteId}`)
      .set("X-CSRF-Token", csrfToken);
    expect(del.status).toBe(204);

    const after = await agent.get(`/api/notes/${noteId}`);
    expect(after.status).toBe(200);
    expect(after.body.status).toBe("entered-in-error");
    // Row is preserved — body unchanged, just status flipped.
    expect(after.body.body).toBe("to be withdrawn");

    // 404 for a genuinely missing id; idempotent for a now-soft-deleted one.
    const missing = await agent
      .delete("/api/notes/note_does_not_exist")
      .set("X-CSRF-Token", csrfToken);
    expect(missing.status).toBe(404);

    const second = await agent
      .delete(`/api/notes/${noteId}`)
      .set("X-CSRF-Token", csrfToken);
    expect(second.status).toBe(204);
  });

  it("POST /notes with replacesNoteId chains amendments", async () => {
    const { agent, csrfToken } = await loginAgent();
    const original = await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({ patientId: "pt_n1", body: "first draft" });
    const originalId = (original.body as { id: string }).id;

    const amended = await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({
        patientId: "pt_n1",
        body: "second draft, addressing earlier note",
        replacesNoteId: originalId,
      });
    expect(amended.status).toBe(201);
    expect(amended.body.replacesNoteId).toBe(originalId);

    // The original is preserved unchanged.
    const checkOriginal = await agent.get(`/api/notes/${originalId}`);
    expect(checkOriginal.body.body).toBe("first draft");
    expect(checkOriginal.body.status).toBe("active");
  });

  it("rejects replacement of a different patient's note", async () => {
    const { agent, csrfToken } = await loginAgent();
    const cross = await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({ patientId: "pt_n1", body: "for pt_n1" });
    const noteId = (cross.body as { id: string }).id;

    const bad = await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({
        patientId: "pt_n2",
        body: "wrong patient",
        replacesNoteId: noteId,
      });
    expect(bad.status).toBe(400);
  });

  it("rejects replacement of a missing predecessor with 404", async () => {
    const { agent, csrfToken } = await loginAgent();
    const res = await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({
        patientId: "pt_n1",
        body: "no predecessor",
        replacesNoteId: "note_nonexistent",
      });
    expect(res.status).toBe(404);
  });

  it("send-to-ehr on a withdrawn note 409s", async () => {
    const { agent, csrfToken } = await loginAgent();
    const created = await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({ patientId: "pt_n1", body: "withdrawn before push" });
    const noteId = (created.body as { id: string }).id;
    await agent
      .delete(`/api/notes/${noteId}`)
      .set("X-CSRF-Token", csrfToken);

    const push = await agent
      .post(`/api/notes/${noteId}/send-to-ehr`)
      .set("X-CSRF-Token", csrfToken);
    expect(push.status).toBe(409);
  });

  it("POST /notes/:id/send-to-ehr persists outcome on the note row", async () => {
    // Default EHR_MODE is unset → mock push, which is what we want here.
    const { agent, csrfToken } = await loginAgent();
    const created = await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({ patientId: "pt_n1", body: "ship me" });
    const noteId = (created.body as { id: string }).id;

    const push = await agent
      .post(`/api/notes/${noteId}/send-to-ehr`)
      .set("X-CSRF-Token", csrfToken);
    expect(push.status).toBe(200);
    expect(push.body).toMatchObject({ provider: "mock", mock: true });

    const [row] = await getDb()
      .select()
      .from(notesTable)
      .where(eq(notesTable.id, noteId));
    expect(row?.ehrProvider).toBe("mock");
    expect(row?.ehrDocumentRef).toMatch(/^DocumentReference\//);
    expect(row?.ehrPushedAt).toBeInstanceOf(Date);
    expect(row?.ehrError).toBeNull();
  });
});
