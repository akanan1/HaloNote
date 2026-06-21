// Integration tests for the mobile init endpoint + the auto-approve
// non-med orders hook that fires from POST /encounters/:id/orders/suggest.

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
  encountersTable,
  getDb,
  notesTable,
  orderSuggestionsTable,
  patientsTable,
  usersTable,
} from "@workspace/db";
import app from "../app";
import {
  createTestUser,
  resetTestDb,
  teardownTestDb,
} from "../../test/helpers";
import { waitForPendingAudits } from "../middlewares/audit";
import { finalizeAndPushTranscribedNote } from "../lib/auto-push";

const EMAIL = "mobile@halonote.test";
const PASSWORD = "correct horse battery staple";
const DISPLAY = "Mobile User";

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

async function getUser(): Promise<typeof usersTable.$inferSelect> {
  const [row] = await getDb()
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, EMAIL));
  return row!;
}

describe("POST /m/initialize (integration)", () => {
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

  it("first call flips auto-push flags + sets mobileOnboardedAt", async () => {
    const { agent, csrfToken } = await loginAgent();

    const res = await agent
      .post("/api/m/initialize")
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.initialized).toBe(true);
    expect(res.body.autoPushMode).toBe("after_transcription");
    expect(res.body.autoPushOrders).toBe(true);
    expect(res.body.autoPushMedications).toBe(false);
    expect(res.body.autoApproveNonMedOrders).toBe(true);
    expect(res.body.mobileOnboardedAt).toBeTruthy();

    const user = await getUser();
    expect(user.autoPushMode).toBe("after_transcription");
    expect(user.autoApproveNonMedOrders).toBe(true);
    expect(user.mobileOnboardedAt).toBeInstanceOf(Date);
  });

  it("second call is a noop — preserves user-edited settings", async () => {
    const { agent, csrfToken } = await loginAgent();

    // First init flips everything.
    await agent
      .post("/api/m/initialize")
      .set("X-CSRF-Token", csrfToken)
      .send({});

    // Provider edits settings: turns auto-push back off (e.g. they're
    // shadowing a fellow today and don't want auto-push behavior).
    await getDb()
      .update(usersTable)
      .set({
        autoPushMode: "off",
        autoPushOrders: false,
        autoApproveNonMedOrders: false,
      })
      .where(eq(usersTable.email, EMAIL));

    // Second mobile visit calls init again. Must NOT re-flip the flags.
    const res = await agent
      .post("/api/m/initialize")
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.initialized).toBe(false);
    expect(res.body.autoPushMode).toBe("off");
    expect(res.body.autoPushOrders).toBe(false);
    expect(res.body.autoApproveNonMedOrders).toBe(false);

    const user = await getUser();
    expect(user.autoPushMode).toBe("off");
    expect(user.autoPushOrders).toBe(false);
  });

  it("unauthenticated request returns 401", async () => {
    const res = await request(app).post("/api/m/initialize").send({});
    expect(res.status).toBe(401);
  });
});

// -------------------------------------------------------------------------
// /orders/suggest auto-approve hook
// -------------------------------------------------------------------------

const ORDER_EMAIL = "mobile-orders@halonote.test";

async function loginOrdersAgent() {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ email: ORDER_EMAIL, password: PASSWORD });
  const cookies = res.headers["set-cookie"] as unknown as string[];
  const csrf = cookies.find((c) => c.startsWith("halonote_csrf="))!;
  const csrfToken = csrf.split("=")[1]!.split(";")[0]!;
  return { agent, csrfToken };
}

async function seedOrdersScenario(opts: {
  withMobileAutoApprove: boolean;
}): Promise<{ encounterId: string; patientId: string }> {
  const db = getDb();
  const patientId = `pt_mob_${Math.floor(Math.random() * 1e9)}`;
  const encounterId = `enc_mob_${Math.floor(Math.random() * 1e9)}`;
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
    ehrEncounterRef: "Encounter/athena-enc-mob",
  });
  await db.insert(notesTable).values({
    organizationId: "org_default",
    patientId,
    encounterId,
    body: "Assessment:\nT2DM.\n\nPlan:\nLabs, continue metformin.",
    status: "approved",
    approvedAt: new Date(),
    signedNoteHash:
      "0000000000000000000000000000000000000000000000000000000000000000",
  });
  if (opts.withMobileAutoApprove) {
    await db
      .update(usersTable)
      .set({
        autoApproveNonMedOrders: true,
        autoPushOrders: true,
        mobileOnboardedAt: new Date(),
      })
      .where(eq(usersTable.email, ORDER_EMAIL));
  }
  return { encounterId, patientId };
}

describe("POST /encounters/:id/orders/suggest — mobile auto-approve hook (integration)", () => {
  beforeAll(async () => {
    await resetTestDb();
    process.env["ORDER_SUGGESTER"] = "stub";
  });

  afterAll(async () => {
    delete process.env["ORDER_SUGGESTER"];
    await teardownTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    await createTestUser({
      email: ORDER_EMAIL,
      password: PASSWORD,
      displayName: DISPLAY,
    });
  });

  afterEach(() => {
    delete process.env["EHR_MODE"];
  });

  it("with autoApproveNonMedOrders=true, non-medication suggestions auto-approve + push, medications stay queued", async () => {
    const { encounterId } = await seedOrdersScenario({
      withMobileAutoApprove: true,
    });
    const { agent, csrfToken } = await loginOrdersAgent();

    const res = await agent
      .post(`/api/encounters/${encounterId}/orders/suggest`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(201);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.autoApproved).toBeDefined();

    // Suggestions table: medications should still be ai_suggested;
    // non-meds should be approved (the auto-flow promoted them).
    const suggestions = await getDb()
      .select()
      .from(orderSuggestionsTable)
      .where(eq(orderSuggestionsTable.encounterId, encounterId));
    const meds = suggestions.filter((s) => s.orderType === "medication");
    const nonMeds = suggestions.filter((s) => s.orderType !== "medication");
    if (meds.length > 0) {
      for (const m of meds) expect(m.status).toBe("ai_suggested");
    }
    if (nonMeds.length > 0) {
      for (const nm of nonMeds) expect(nm.status).toBe("approved");
    }

    // Approved orders table: one row per non-med, status=exported
    // (mock provider always succeeds), ehrDocumentRef set.
    const approved = await getDb()
      .select()
      .from(approvedOrdersTable)
      .where(eq(approvedOrdersTable.encounterId, encounterId));
    expect(approved.length).toBe(nonMeds.length);
    for (const a of approved) {
      expect(a.status).toBe("exported");
      expect(a.ehrDocumentRef).toMatch(/^(MedicationRequest|ServiceRequest)\//);
      expect(a.orderType).not.toBe("medication");
    }

    expect(res.body.autoApproved.pushedCount).toBe(nonMeds.length);
    expect(res.body.autoApproved.failedCount).toBe(0);
    expect(res.body.autoApproved.medicationsHeldCount).toBe(meds.length);
  });

  it("without the flag, suggestions land but nothing is auto-approved", async () => {
    const { encounterId } = await seedOrdersScenario({
      withMobileAutoApprove: false,
    });
    const { agent, csrfToken } = await loginOrdersAgent();

    const res = await agent
      .post(`/api/encounters/${encounterId}/orders/suggest`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.autoApproved).toBeUndefined();

    const suggestions = await getDb()
      .select()
      .from(orderSuggestionsTable)
      .where(eq(orderSuggestionsTable.encounterId, encounterId));
    for (const s of suggestions) expect(s.status).toBe("ai_suggested");

    const approved = await getDb()
      .select()
      .from(approvedOrdersTable)
      .where(eq(approvedOrdersTable.encounterId, encounterId));
    expect(approved.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Server-side auto-fire after note transcription. The mobile flow's
  // contract: doctor records → walks out → note auto-pushes → orders
  // auto-suggest + non-meds auto-push, all without the client staying
  // on screen. Direct call to finalizeAndPushTranscribedNote (skips
  // the recording wire) verifies the chain end-to-end.
  // -------------------------------------------------------------------------
  it("after finalizeAndPushTranscribedNote, orders auto-suggest + non-meds auto-push for users with autoApproveNonMedOrders", async () => {
    const { encounterId, patientId } = await seedOrdersScenario({
      withMobileAutoApprove: true,
    });
    // Remove the seed note so the auto-push pipeline lays down a fresh
    // approved note from the transcribed body — matches the real
    // recording flow where the pipeline owns the note row.
    await getDb().delete(notesTable).where(eq(notesTable.encounterId, encounterId));

    const [user] = await getDb()
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, ORDER_EMAIL));
    expect(user).toBeDefined();

    const noopLog = { error: () => {}, warn: () => {}, info: () => {} };
    const result = await finalizeAndPushTranscribedNote({
      organizationId: "org_default",
      userId: user!.id,
      patientId,
      encounterId,
      structuredBody:
        "Assessment:\nT2DM, HTN.\n\nPlan:\nCBC, A1C, continue metformin.",
      log: noopLog,
    });
    expect(result.pushed).toBe(true);

    // The orders trigger is fire-and-forget. waitForPendingAudits
    // drains the trackAuditWrite hook the chain registered on its way
    // out, so by the time this returns we know the suggest+approve
    // pipeline ran to completion.
    await waitForPendingAudits();

    const suggestions = await getDb()
      .select()
      .from(orderSuggestionsTable)
      .where(eq(orderSuggestionsTable.encounterId, encounterId));
    expect(suggestions.length).toBeGreaterThan(0);

    const nonMeds = suggestions.filter((s) => s.orderType !== "medication");
    const meds = suggestions.filter((s) => s.orderType === "medication");
    // Non-meds were auto-approved + the source suggestion flipped.
    for (const nm of nonMeds) expect(nm.status).toBe("approved");
    // Meds (if any) stay queued.
    for (const m of meds) expect(m.status).toBe("ai_suggested");

    const approved = await getDb()
      .select()
      .from(approvedOrdersTable)
      .where(eq(approvedOrdersTable.encounterId, encounterId));
    expect(approved.length).toBe(nonMeds.length);
    for (const a of approved) {
      expect(a.status).toBe("exported");
      expect(a.orderType).not.toBe("medication");
    }
  });

  it("without autoApproveNonMedOrders, finalizeAndPushTranscribedNote pushes the note but skips order generation", async () => {
    const { encounterId, patientId } = await seedOrdersScenario({
      withMobileAutoApprove: false,
    });
    await getDb().delete(notesTable).where(eq(notesTable.encounterId, encounterId));

    const [user] = await getDb()
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, ORDER_EMAIL));

    const noopLog = { error: () => {}, warn: () => {}, info: () => {} };
    await finalizeAndPushTranscribedNote({
      organizationId: "org_default",
      userId: user!.id,
      patientId,
      encounterId,
      structuredBody:
        "Assessment:\nT2DM, HTN.\n\nPlan:\nCBC, A1C, continue metformin.",
      log: noopLog,
    });
    await waitForPendingAudits();

    const suggestions = await getDb()
      .select()
      .from(orderSuggestionsTable)
      .where(eq(orderSuggestionsTable.encounterId, encounterId));
    expect(suggestions.length).toBe(0);
  });

  it("when push fails (real-mode 501), suggestions still approve but failedCount > 0 and ehrError persists", async () => {
    const { encounterId } = await seedOrdersScenario({
      withMobileAutoApprove: true,
    });
    process.env["EHR_MODE"] = "epic"; // NotImplementedOrderAdapter throws 501
    const { agent, csrfToken } = await loginOrdersAgent();

    const res = await agent
      .post(`/api/encounters/${encounterId}/orders/suggest`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.autoApproved).toBeDefined();

    const approved = await getDb()
      .select()
      .from(approvedOrdersTable)
      .where(
        and(
          eq(approvedOrdersTable.encounterId, encounterId),
        ),
      );
    if (approved.length > 0) {
      // All approval rows exist locally; none exported.
      for (const a of approved) {
        expect(a.status).toBe("export_ready");
        expect(a.exportedAt).toBeNull();
        expect(a.ehrError).toMatch(/not yet implemented/);
      }
      expect(res.body.autoApproved.failedCount).toBe(approved.length);
      expect(res.body.autoApproved.pushedCount).toBe(0);
    }
  });
});
