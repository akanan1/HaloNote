// Integration tests for the Athena-existing-note ingestion path.
//
//   GET  /patients/:id/athena-notes
//   GET  /patients/:id/athena-encounters
//   POST /encounters/:id/coding/ingest-athena-note
//
// Mock-mode (default) is exercised here — the real Athena pull needs
// EHR_MODE=athenahealth + sandbox credentials and is verified separately.

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
import {
  encounterCodingSessionsTable,
  encountersTable,
  getDb,
  notesTable,
  patientsTable,
} from "@workspace/db";
import app from "../app";
import {
  createTestUser,
  resetTestDb,
  teardownTestDb,
} from "../../test/helpers";

const EMAIL = "ingest@halonote.test";
const PASSWORD = "correct horse battery staple";
const DISPLAY = "Ingest User";

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

async function seedPatient(id: string, opts: { ehrPatientId?: string } = {}) {
  await getDb()
    .insert(patientsTable)
    .values({
      id,
      organizationId: "org_default",
      firstName: "Test",
      lastName: "Patient",
      dateOfBirth: "1990-01-01",
      mrn: `MRN-${id}`,
      ...(opts.ehrPatientId ? { ehrPatientId: opts.ehrPatientId } : {}),
    })
    .onConflictDoNothing();
}

describe("Athena-ingest routes (integration)", () => {
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
  });

  it("GET /patients/:id/athena-notes returns [] when patient has no ehrPatientId", async () => {
    await seedPatient("pt_i1");
    const { agent } = await loginAgent();
    const res = await agent.get("/api/patients/pt_i1/athena-notes");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("GET /patients/:id/athena-notes returns mock candidates when patient has ehrPatientId", async () => {
    await seedPatient("pt_i2", { ehrPatientId: "athena-pt-9999" });
    const { agent } = await loginAgent();
    const res = await agent.get("/api/patients/pt_i2/athena-notes");
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const c of res.body.data) {
      expect(c.documentReferenceId).toMatch(/^mock-doc-/);
      expect(c.contentType).toBe("text/plain");
    }
  });

  it("GET /patients/:id/athena-encounters returns mock candidates for linked patients", async () => {
    await seedPatient("pt_i3", { ehrPatientId: "athena-pt-3333" });
    const { agent } = await loginAgent();
    const res = await agent.get("/api/patients/pt_i3/athena-encounters");
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const c of res.body.data) {
      expect(c.encounterId).toMatch(/^mock-enc-/);
      expect(c.status).toBe("finished");
    }
  });

  it("POST /encounters/:id/coding/ingest-athena-note materializes a local approved note + fires Coder", async () => {
    await seedPatient("pt_i4");
    const { agent, csrfToken } = await loginAgent();
    const enc = await agent
      .post("/api/encounters")
      .set("X-CSRF-Token", csrfToken)
      .send({ patientId: "pt_i4", visitType: "established_patient" });
    const encounterId = (enc.body as { id: string }).id;

    const res = await agent
      .post(`/api/encounters/${encounterId}/coding/ingest-athena-note`)
      .set("X-CSRF-Token", csrfToken)
      .send({ athenaDocumentReferenceId: "mock-doc-12345" });

    expect(res.status).toBe(201);
    expect(res.body.noteSource).toBe("mock");
    expect(res.body.session.noteSource).toBe("athena_existing");
    expect(res.body.session.status).toBe("ready");
    expect(res.body.suggestions.length).toBeGreaterThan(0);

    // The local note row should be approved + carry an EHR doc ref.
    const [note] = await getDb()
      .select()
      .from(notesTable)
      .where(eq(notesTable.id, res.body.noteId));
    expect(note!.status).toBe("approved");
    expect(note!.signedNoteHash).toMatch(/^[0-9a-f]{64}$/);
    expect(note!.ehrDocumentRef).toBe("DocumentReference/mock-doc-12345");
  });

  it("ingest-athena-note returns 404 for unknown encounter", async () => {
    await seedPatient("pt_i5");
    const { agent, csrfToken } = await loginAgent();
    const res = await agent
      .post("/api/encounters/enc_does_not_exist/coding/ingest-athena-note")
      .set("X-CSRF-Token", csrfToken)
      .send({ athenaDocumentReferenceId: "mock-doc-1" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("encounter_not_found");
  });

  it("creates an EncounterCodingSession that mirrors the pulled note source", async () => {
    await seedPatient("pt_i6");
    const { agent, csrfToken } = await loginAgent();
    const enc = await agent
      .post("/api/encounters")
      .set("X-CSRF-Token", csrfToken)
      .send({ patientId: "pt_i6", visitType: "established_patient" });
    const encounterId = (enc.body as { id: string }).id;

    const ingest = await agent
      .post(`/api/encounters/${encounterId}/coding/ingest-athena-note`)
      .set("X-CSRF-Token", csrfToken)
      .send({ athenaDocumentReferenceId: "mock-doc-77" });

    const [session] = await getDb()
      .select()
      .from(encounterCodingSessionsTable)
      .where(
        eq(encounterCodingSessionsTable.id, ingest.body.session.id),
      );
    expect(session!.noteSource).toBe("athena_existing");
    expect(session!.encounterId).toBe(encounterId);
    expect(session!.noteId).toBe(ingest.body.noteId);
  });

  it("ingesting does not break encounters that already have a local note", async () => {
    await seedPatient("pt_i7");
    const { agent, csrfToken } = await loginAgent();
    const enc = await agent
      .post("/api/encounters")
      .set("X-CSRF-Token", csrfToken)
      .send({ patientId: "pt_i7", visitType: "established_patient" });
    const encounterId = (enc.body as { id: string }).id;
    // Existing local note (a Scribe-authored draft).
    await agent
      .post("/api/notes")
      .set("X-CSRF-Token", csrfToken)
      .send({
        patientId: "pt_i7",
        encounterId,
        body: "Pre-existing local draft.",
      });

    const ingest = await agent
      .post(`/api/encounters/${encounterId}/coding/ingest-athena-note`)
      .set("X-CSRF-Token", csrfToken)
      .send({ athenaDocumentReferenceId: "mock-doc-88" });

    // Ingest creates a SECOND note (the Athena-pulled one); the local
    // draft stays in place. Both should exist for this encounter.
    expect(ingest.status).toBe(201);
    const notesForEnc = await getDb()
      .select()
      .from(encountersTable)
      .where(eq(encountersTable.id, encounterId));
    expect(notesForEnc.length).toBe(1); // encounter still exists
  });
});
