// Integration tests for the per-order EHR push flow (Phase: real-mode
// orders push, adapter boundary). Drives the route + the
// pushApprovedOrder service through it. Forces EHR_MODE off (mock
// default) except for the failure / retry tests which flip the
// EHR_ORDER_PUSH_FORCE test-only escape hatch (see ehr-order-adapter.ts).
//
// Covers the requirements list:
//   - dry-run does not call external adapter (verifies via outcome
//     shape + that an EHR_MODE=athenahealth dispatch which would
//     normally throw 501 instead succeeds with dryRun=true)
//   - real mode calls adapter once (single status flip, audit event,
//     idempotency key persisted)
//   - duplicate push returns previous result (idempotent short-circuit;
//     no new exportedAt, audit event = skipped_duplicate)
//   - failed push stores error state + audit event (force-fail adapter)
//   - retry succeeds after failed attempt (fail-once adapter)
//   - unapproved order cannot be pushed (cancelled status)
//   - non-finalized note cannot push orders (note.status='draft')

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
  approvedOrdersTable,
  auditLogTable,
  encountersTable,
  getDb,
  notesTable,
  patientsTable,
  type ApprovedOrderStatus,
  type NoteStatus,
} from "@workspace/db";
import app from "../app";
import {
  createTestUser,
  resetTestDb,
  teardownTestDb,
} from "../../test/helpers";
import { waitForPendingAudits } from "../middlewares/audit";
import { __resetForceFailOnceLatchForTesting } from "../lib/ehr-order-adapter";

const EMAIL = "ordpush@halonote.test";
const PASSWORD = "correct horse battery staple";
const DISPLAY = "Order Push User";

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
  orderId: string;
}

let seedCounter = 0;

async function seedScenario(opts: {
  noteStatus: NoteStatus;
  orderStatus: ApprovedOrderStatus;
  isComplete?: boolean;
  withEncounterRef?: boolean;
}): Promise<SeedFixture> {
  seedCounter += 1;
  // Per-scenario unique IDs so beforeEach TRUNCATE + parallel-safe
  // assertions don't bleed.
  const patientId = `pt_op${seedCounter}`;
  const encounterId = `enc_op${seedCounter}`;
  const noteId = `note_op${seedCounter}`;
  const orderId = `ord_op${seedCounter}`;

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
    ehrEncounterRef:
      opts.withEncounterRef === false ? null : "Encounter/athena-enc-99",
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
  await db.insert(approvedOrdersTable).values({
    id: orderId,
    organizationId: "org_default",
    encounterId,
    orderType: "lab",
    name: "CBC",
    priority: "routine",
    isComplete: opts.isComplete ?? true,
    status: opts.orderStatus,
    approvedAt: new Date(),
  });

  return { patientId, encounterId, noteId, orderId };
}

async function getOrder(orderId: string) {
  const [row] = await getDb()
    .select()
    .from(approvedOrdersTable)
    .where(eq(approvedOrdersTable.id, orderId));
  return row;
}

async function getAuditActions(orderId: string): Promise<string[]> {
  await waitForPendingAudits();
  const rows = await getDb()
    .select({ action: auditLogTable.action })
    .from(auditLogTable)
    .where(
      and(
        eq(auditLogTable.resourceType, "approved_order"),
        eq(auditLogTable.resourceId, orderId),
      ),
    );
  return rows.map((r) => r.action);
}

describe("/orders/:id/send-to-ehr (integration)", () => {
  beforeAll(async () => {
    await resetTestDb();
    // Never let CI accidentally point at a real EHR.
    delete process.env["EHR_MODE"];
    delete process.env["EHR_ORDER_PUSH_FORCE"];
  });

  afterAll(async () => {
    delete process.env["EHR_MODE"];
    delete process.env["EHR_ORDER_PUSH_FORCE"];
    await teardownTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    await createTestUser({
      email: EMAIL,
      password: PASSWORD,
      displayName: DISPLAY,
    });
    __resetForceFailOnceLatchForTesting();
  });

  afterEach(() => {
    // Defensive — never let a test leak EHR config into the next one.
    delete process.env["EHR_MODE"];
    delete process.env["EHR_ORDER_PUSH_FORCE"];
  });

  // -------------------------------------------------------------------------
  // Happy path: mock-mode push lands status=exported + a single audit event
  // + a persisted idempotency key for any future retry.
  // -------------------------------------------------------------------------
  it("real mode (mock provider) calls adapter once: row flips to exported, ehrDocumentRef + idempotency key persisted, single succeeded audit event", async () => {
    const { orderId } = await seedScenario({
      noteStatus: "approved",
      orderStatus: "export_ready",
    });
    const { agent, csrfToken } = await loginAgent();

    const res = await agent
      .post(`/api/orders/${orderId}/send-to-ehr`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.mock).toBe(true);
    expect(res.body.ehrDocumentRef).toMatch(/^ServiceRequest\/mock-/);

    const row = await getOrder(orderId);
    expect(row!.status).toBe("exported");
    expect(row!.ehrDocumentRef).toBe(res.body.ehrDocumentRef);
    expect(row!.ehrError).toBeNull();
    expect(row!.exportedAt).toBeInstanceOf(Date);
    expect(row!.ehrIdempotencyKey).toMatch(/^ord-/);

    const actions = await getAuditActions(orderId);
    expect(actions).toContain("coder.order.push.succeeded");
    expect(
      actions.filter((a) => a === "coder.order.push.succeeded").length,
    ).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Dry-run never touches the upstream. We force EHR_MODE=athenahealth
  // (which would normally 501 from the NotImplemented adapter) and assert
  // success with dryRun=true — proves the dry-run path bypassed dispatch.
  // -------------------------------------------------------------------------
  it("dry-run does NOT call the external adapter — succeeds even with EHR_MODE=athenahealth, no DB status flip", async () => {
    const { orderId } = await seedScenario({
      noteStatus: "approved",
      orderStatus: "export_ready",
    });
    process.env["EHR_MODE"] = "athenahealth"; // real adapter would throw 501.
    const { agent, csrfToken } = await loginAgent();

    const res = await agent
      .post(`/api/orders/${orderId}/send-to-ehr?dryRun=1`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.provider).toBe("athenahealth_dry_run");
    expect(res.body.payloadPreview).toBeDefined();
    expect(res.body.payloadPreview.resourceType).toBe("ServiceRequest");

    const row = await getOrder(orderId);
    // No status flip, no exportedAt, no idempotency key — dry-run is
    // strictly read-only.
    expect(row!.status).toBe("export_ready");
    expect(row!.exportedAt).toBeNull();
    expect(row!.ehrDocumentRef).toBeNull();
    expect(row!.ehrIdempotencyKey).toBeNull();

    const actions = await getAuditActions(orderId);
    expect(actions).toEqual(["coder.order.push.dry_run"]);
  });

  // -------------------------------------------------------------------------
  // Idempotency: second push on an already-exported row short-circuits
  // and returns the previous ref. No second exportedAt stamp, no extra
  // succeeded audit event.
  // -------------------------------------------------------------------------
  it("duplicate push is blocked: returns previous result + skipped_duplicate audit, no second exportedAt stamp", async () => {
    const { orderId } = await seedScenario({
      noteStatus: "approved",
      orderStatus: "export_ready",
    });
    const { agent, csrfToken } = await loginAgent();

    const first = await agent
      .post(`/api/orders/${orderId}/send-to-ehr`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    expect(first.status).toBe(200);
    const firstRow = await getOrder(orderId);
    const firstExportedAt = firstRow!.exportedAt!.getTime();
    const firstRef = firstRow!.ehrDocumentRef!;

    // Second push, same order.
    const second = await agent
      .post(`/api/orders/${orderId}/send-to-ehr`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.ehrDocumentRef).toBe(firstRef);

    const after = await getOrder(orderId);
    expect(after!.exportedAt!.getTime()).toBe(firstExportedAt);
    expect(after!.ehrDocumentRef).toBe(firstRef);

    const actions = await getAuditActions(orderId);
    // Exactly one succeeded + exactly one skipped_duplicate.
    expect(
      actions.filter((a) => a === "coder.order.push.succeeded").length,
    ).toBe(1);
    expect(
      actions.filter((a) => a === "coder.order.push.skipped_duplicate")
        .length,
    ).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Failure: force the adapter to throw. ehrError is persisted (scrubbed),
  // status stays at export_ready so the UI can offer retry, audit event
  // fires.
  // -------------------------------------------------------------------------
  it("failed push stores ehrError + emits failed audit event, status stays at export_ready for retry", async () => {
    const { orderId } = await seedScenario({
      noteStatus: "approved",
      orderStatus: "export_ready",
    });
    process.env["EHR_ORDER_PUSH_FORCE"] = "fail";
    const { agent, csrfToken } = await loginAgent();

    const res = await agent
      .post(`/api/orders/${orderId}/send-to-ehr`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("ehr_push_failed");
    expect(res.body.retryable).toBe(true);

    const row = await getOrder(orderId);
    expect(row!.status).toBe("export_ready"); // not flipped
    expect(row!.exportedAt).toBeNull();
    expect(row!.ehrError).toMatch(/Forced failure/);

    const actions = await getAuditActions(orderId);
    expect(actions).toContain("coder.order.push.failed");
    expect(
      actions.filter((a) => a === "coder.order.push.failed").length,
    ).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Retry succeeds after a failure: fail_once adapter throws first time,
  // succeeds the second. ehrError is cleared, status becomes exported.
  // -------------------------------------------------------------------------
  it("retry succeeds after a failed attempt: ehrError cleared, status=exported, idempotency key reused", async () => {
    const { orderId } = await seedScenario({
      noteStatus: "approved",
      orderStatus: "export_ready",
    });
    process.env["EHR_ORDER_PUSH_FORCE"] = "fail_once";
    const { agent, csrfToken } = await loginAgent();

    const fail = await agent
      .post(`/api/orders/${orderId}/send-to-ehr`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    expect(fail.status).toBe(502);
    const afterFail = await getOrder(orderId);
    expect(afterFail!.ehrError).toMatch(/Forced failure/);
    expect(afterFail!.status).toBe("export_ready");
    const keyAfterFail = afterFail!.ehrIdempotencyKey;
    expect(keyAfterFail).toMatch(/^ord-/);

    // Second attempt — the fail_once latch has been consumed, so the
    // adapter falls through to mock success.
    const ok = await agent
      .post(`/api/orders/${orderId}/send-to-ehr`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    expect(ok.status).toBe(200);
    expect(ok.body.mock).toBe(true);

    const afterOk = await getOrder(orderId);
    expect(afterOk!.status).toBe("exported");
    expect(afterOk!.ehrError).toBeNull();
    // Idempotency key is reused across the failed → retry boundary so
    // the upstream can dedupe.
    expect(afterOk!.ehrIdempotencyKey).toBe(keyAfterFail);

    const actions = await getAuditActions(orderId);
    expect(actions).toContain("coder.order.push.failed");
    expect(actions).toContain("coder.order.push.succeeded");
  });

  // -------------------------------------------------------------------------
  // Approval gate: cancelled (or any non-pushable) order is rejected
  // with 409 + skipped_unapproved audit event.
  // -------------------------------------------------------------------------
  it("unapproved order (status=cancelled) cannot be pushed: 409 + skipped_unapproved audit", async () => {
    const { orderId } = await seedScenario({
      noteStatus: "approved",
      orderStatus: "cancelled",
    });
    const { agent, csrfToken } = await loginAgent();

    const res = await agent
      .post(`/api/orders/${orderId}/send-to-ehr`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("order_not_export_ready");
    expect(res.body.status).toBe("cancelled");

    const row = await getOrder(orderId);
    expect(row!.status).toBe("cancelled");
    expect(row!.exportedAt).toBeNull();

    const actions = await getAuditActions(orderId);
    expect(actions).toEqual(["coder.order.push.skipped_unapproved"]);
  });

  // -------------------------------------------------------------------------
  // Note-finalized gate: draft note blocks the push. Patient-safety
  // contract: never push orders from an unsigned note.
  // -------------------------------------------------------------------------
  it("non-finalized note (status=draft) cannot push orders: 409 + skipped_unfinalized audit", async () => {
    const { orderId } = await seedScenario({
      noteStatus: "draft",
      orderStatus: "export_ready",
    });
    const { agent, csrfToken } = await loginAgent();

    const res = await agent
      .post(`/api/orders/${orderId}/send-to-ehr`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("note_not_finalized");
    expect(res.body.noteStatus).toBe("draft");

    const row = await getOrder(orderId);
    expect(row!.status).toBe("export_ready");
    expect(row!.exportedAt).toBeNull();

    const actions = await getAuditActions(orderId);
    expect(actions).toEqual(["coder.order.push.skipped_unfinalized"]);
  });
});
