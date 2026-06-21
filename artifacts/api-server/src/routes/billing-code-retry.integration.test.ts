// Integration tests for the per-card retry path for stranded billing
// codes — codes that the bulk-approve push left with ehrError set and
// exportedAt null.
//
// Distinct from the existing biller-driven /billing/codes/:id/send-to-ehr
// route which gates on billerApprovedAt. This new endpoint covers the
// recovery hatch for bulk-approve failures where biller approval was
// never set.

import {
  afterAll,
  afterEach,
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
  encountersTable,
  getDb,
  notesTable,
  patientsTable,
  type NoteStatus,
} from "@workspace/db";
import app from "../app";
import {
  createTestUser,
  resetTestDb,
  teardownTestDb,
} from "../../test/helpers";
import { waitForPendingAudits } from "../middlewares/audit";

const EMAIL = "bcretry@halonote.test";
const PASSWORD = "correct horse battery staple";
const DISPLAY = "BC Retry User";

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

interface SeedFixture {
  patientId: string;
  encounterId: string;
  noteId: string;
  codeId: string;
}

let seedCounter = 0;

async function seedScenario(opts: {
  noteStatus: NoteStatus;
  /** Whether the code should be in the "stranded" state. When true,
   *  ehrError is set + exportedAt null. When false, exportedAt is set
   *  (already exported — not stranded). */
  stranded: boolean;
  /** Override: simulate "never tried" (no ehrError, no exportedAt). */
  neverTried?: boolean;
}): Promise<SeedFixture> {
  seedCounter += 1;
  const patientId = `pt_bcr${seedCounter}`;
  const encounterId = `enc_bcr${seedCounter}`;
  const noteId = `note_bcr${seedCounter}`;
  const codeId = `bcd_bcr${seedCounter}`;

  const db = getDb();
  await db.insert(patientsTable).values({
    id: patientId,
    organizationId: "org_default",
    firstName: "Test",
    lastName: "Patient",
    dateOfBirth: "1990-01-01",
    mrn: `MRN-${patientId}`,
  });
  await db.insert(encountersTable).values({
    id: encounterId,
    organizationId: "org_default",
    patientId,
    visitType: "established_patient",
    status: "in_progress",
    ehrEncounterRef: "Encounter/athena-enc-77",
  });
  await db.insert(notesTable).values({
    id: noteId,
    organizationId: "org_default",
    patientId,
    encounterId,
    body: "Visit summary.",
    status: opts.noteStatus,
    ...(opts.noteStatus === "approved" || opts.noteStatus === "exported"
      ? {
          approvedAt: new Date(),
          signedNoteHash:
            "0000000000000000000000000000000000000000000000000000000000000000",
        }
      : {}),
  });
  await db.insert(approvedBillingCodesTable).values({
    id: codeId,
    organizationId: "org_default",
    encounterId,
    codeSystem: "icd10",
    code: "E11.9",
    description: "Type 2 diabetes mellitus without complications",
    approvedAt: new Date(),
    ...(opts.neverTried
      ? {}
      : opts.stranded
        ? { ehrError: "athena returned 502 last time", exportedAt: null }
        : {
            exportedAt: new Date(),
            ehrDocumentRef: "Claim/old-success-ref",
          }),
  });

  return { patientId, encounterId, noteId, codeId };
}

async function getCode(codeId: string) {
  const [row] = await getDb()
    .select()
    .from(approvedBillingCodesTable)
    .where(eq(approvedBillingCodesTable.id, codeId));
  return row;
}

async function getAuditActions(codeId: string): Promise<string[]> {
  await waitForPendingAudits();
  const rows = await getDb()
    .select({ action: auditLogTable.action })
    .from(auditLogTable)
    .where(
      and(
        eq(auditLogTable.resourceType, "approved_billing_code"),
        eq(auditLogTable.resourceId, codeId),
      ),
    );
  return rows.map((r) => r.action);
}

describe("/billing/codes/:id/retry-push (integration)", () => {
  beforeAll(async () => {
    await resetTestDb();
    delete process.env["EHR_MODE"];
  });

  afterAll(async () => {
    delete process.env["EHR_MODE"];
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

  afterEach(() => {
    delete process.env["EHR_MODE"];
  });

  // -------------------------------------------------------------------------
  // Happy path: stranded code retries successfully via mock provider.
  // -------------------------------------------------------------------------
  it("stranded code retries successfully: exportedAt stamped, ehrError cleared, succeeded audit", async () => {
    const { codeId } = await seedScenario({
      noteStatus: "approved",
      stranded: true,
    });
    const { agent, csrfToken } = await loginAgent();

    const res = await agent
      .post(`/api/billing/codes/${codeId}/retry-push`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.mock).toBe(true);
    expect(res.body.ehrDocumentRef).toMatch(/^Claim\/mock-/);

    const row = await getCode(codeId);
    expect(row!.exportedAt).toBeInstanceOf(Date);
    expect(row!.ehrError).toBeNull();
    expect(row!.ehrDocumentRef).toBe(res.body.ehrDocumentRef);

    const actions = await getAuditActions(codeId);
    expect(actions).toEqual(["coder.billing_code.push.succeeded"]);
  });

  // -------------------------------------------------------------------------
  // Reject: code is already exported (not stranded — caller should
  // treat as success on their end).
  // -------------------------------------------------------------------------
  it("already-exported code is rejected with 409 + skipped_not_stranded audit", async () => {
    const { codeId } = await seedScenario({
      noteStatus: "approved",
      stranded: false,
    });
    const { agent, csrfToken } = await loginAgent();

    const res = await agent
      .post(`/api/billing/codes/${codeId}/retry-push`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("code_not_stranded");
    expect(res.body.exportedAt).toBeTruthy();

    const row = await getCode(codeId);
    expect(row!.ehrDocumentRef).toBe("Claim/old-success-ref");

    const actions = await getAuditActions(codeId);
    expect(actions).toEqual(["coder.billing_code.push.skipped_not_stranded"]);
  });

  // -------------------------------------------------------------------------
  // Reject: code has never been pushed (no ehrError). This isn't the
  // endpoint's job — the caller should go through the biller-approval
  // flow or wait for the bulk-approve to fire.
  // -------------------------------------------------------------------------
  it("never-tried code is rejected with 409 (not stranded)", async () => {
    const { codeId } = await seedScenario({
      noteStatus: "approved",
      stranded: false,
      neverTried: true,
    });
    const { agent, csrfToken } = await loginAgent();

    const res = await agent
      .post(`/api/billing/codes/${codeId}/retry-push`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("code_not_stranded");
    expect(res.body.exportedAt).toBeNull();
    expect(res.body.ehrError).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Note-finalized gate.
  // -------------------------------------------------------------------------
  it("stranded code with draft note is rejected with 409 + skipped_unfinalized audit", async () => {
    const { codeId } = await seedScenario({
      noteStatus: "draft",
      stranded: true,
    });
    const { agent, csrfToken } = await loginAgent();

    const res = await agent
      .post(`/api/billing/codes/${codeId}/retry-push`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("note_not_finalized");
    expect(res.body.noteStatus).toBe("draft");

    const row = await getCode(codeId);
    // Original ehrError preserved — never overwritten by the gate path.
    expect(row!.ehrError).toBe("athena returned 502 last time");
    expect(row!.exportedAt).toBeNull();

    const actions = await getAuditActions(codeId);
    expect(actions).toEqual(["coder.billing_code.push.skipped_unfinalized"]);
  });

  // -------------------------------------------------------------------------
  // Code-not-found.
  // -------------------------------------------------------------------------
  it("unknown code id returns 404", async () => {
    await createTestUser({
      email: EMAIL,
      password: PASSWORD,
      displayName: DISPLAY,
    }).catch(() => {});
    const { agent, csrfToken } = await loginAgent();

    const res = await agent
      .post(`/api/billing/codes/bcd_does_not_exist/retry-push`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("code_not_found");
  });

  // -------------------------------------------------------------------------
  // Failure path: simulate by pointing at the not-yet-implemented Epic
  // adapter via EHR_MODE=epic. pushBillingCodeToEhr throws 501 — the
  // service catches, persists ehrError (overwriting the stale one), and
  // emits failed audit.
  // -------------------------------------------------------------------------
  it("real-mode failure updates ehrError + emits failed audit, status code is forwarded", async () => {
    const { codeId } = await seedScenario({
      noteStatus: "approved",
      stranded: true,
    });
    process.env["EHR_MODE"] = "epic"; // 501 NotImplemented
    const { agent, csrfToken } = await loginAgent();

    const res = await agent
      .post(`/api/billing/codes/${codeId}/retry-push`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(501);
    expect(res.body.error).toBe("ehr_push_failed");
    expect(res.body.retryable).toBe(false); // 501 — caller must fix config

    const row = await getCode(codeId);
    expect(row!.ehrError).toMatch(/not_implemented_for_epic/);
    // Stale "athena returned 502 last time" message was overwritten by
    // the new failure message — surfaces the most recent attempt's
    // problem to the UI.
    expect(row!.ehrError).not.toMatch(/athena returned 502/);
    expect(row!.exportedAt).toBeNull();

    const actions = await getAuditActions(codeId);
    expect(actions).toEqual(["coder.billing_code.push.failed"]);
  });
});
