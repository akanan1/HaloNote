// Integration tests for the Coder refinement endpoints.
//
//   POST /coding/suggestions/:id/refine
//   POST /coding/suggestions/:id/apply-refinement
//   POST /coding/sessions/:id/refine-all
//
// Forces CODING_SUGGESTER=stub so AI is deterministic — stub returns
// empty refinements by design (never fabricate codes), so we monkey-
// patch the suggestion + use direct DB writes to set up scenarios.

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
  billingSuggestionsTable,
  getDb,
  patientsTable,
} from "@workspace/db";
import app from "../app";
import {
  createTestUser,
  resetTestDb,
  teardownTestDb,
} from "../../test/helpers";

const EMAIL = "refine@halonote.test";
const PASSWORD = "correct horse battery staple";
const DISPLAY = "Refine User";

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

async function seedPatient(id: string) {
  await getDb()
    .insert(patientsTable)
    .values({
      id,
      organizationId: "org_default",
      firstName: "Test",
      lastName: "Patient",
      dateOfBirth: "1990-01-01",
      mrn: `MRN-${id}`,
    })
    .onConflictDoNothing();
}

async function seedSessionWithSuggestion(
  agent: ReturnType<typeof request.agent>,
  csrfToken: string,
  body: string,
): Promise<{
  encounterId: string;
  sessionId: string;
  icd10SuggestionId: string;
  emSuggestionId: string | null;
}> {
  const enc = await agent
    .post("/api/encounters")
    .set("X-CSRF-Token", csrfToken)
    .send({ patientId: "pt_r1", visitType: "established_patient" });
  const encounterId = (enc.body as { id: string }).id;
  await agent
    .post("/api/notes")
    .set("X-CSRF-Token", csrfToken)
    .send({ patientId: "pt_r1", encounterId, body });
  const gen = await agent
    .post(`/api/encounters/${encounterId}/coding/generate`)
    .set("X-CSRF-Token", csrfToken)
    .send({});
  const sessionId = gen.body.session.id;
  const icd10 = gen.body.suggestions.find(
    (s: { codeSystem: string }) => s.codeSystem === "icd10",
  );
  const em = gen.body.suggestions.find(
    (s: { codeSystem: string }) => s.codeSystem === "em",
  );
  return {
    encounterId,
    sessionId,
    icd10SuggestionId: icd10.id,
    emSuggestionId: em?.id ?? null,
  };
}

const NOTE_BODY = `
HPI: 64yo F with T2DM, A1c 8.3, neuropathy symptoms noted.

Assessment:
1. Type 2 diabetes mellitus
2. Essential hypertension

Plan:
- Increase metformin
- Continue lisinopril
`.trim();

describe("coding refinement routes (integration)", () => {
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
    await seedPatient("pt_r1");
  });

  it("POST /coding/suggestions/:id/refine returns empty options in stub mode (never fabricates)", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { icd10SuggestionId } = await seedSessionWithSuggestion(
      agent,
      csrfToken,
      NOTE_BODY,
    );

    const res = await agent
      .post(`/api/coding/suggestions/${icd10SuggestionId}/refine`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("stub");
    // Stub deliberately emits zero refinements — fabricating a more-
    // specific ICD-10 that a tired provider might click-accept is a
    // patient-billing harm vector.
    expect(res.body.options).toEqual([]);
  });

  it("POST /coding/suggestions/:id/refine returns 409 for non-refinable code systems (em/modifier)", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { emSuggestionId } = await seedSessionWithSuggestion(
      agent,
      csrfToken,
      NOTE_BODY,
    );
    expect(emSuggestionId).not.toBeNull();

    const res = await agent
      .post(`/api/coding/suggestions/${emSuggestionId}/refine`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("suggestion_not_refinable");
  });

  it("POST /coding/suggestions/:id/apply-refinement sets edited fields + bumps HCC when unlocked", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { icd10SuggestionId } = await seedSessionWithSuggestion(
      agent,
      csrfToken,
      NOTE_BODY,
    );

    // Apply a refinement that unlocks HCC. We pass the chosen option
    // directly (the refiner-driven flow would have surfaced it first).
    const res = await agent
      .post(`/api/coding/suggestions/${icd10SuggestionId}/apply-refinement`)
      .set("X-CSRF-Token", csrfToken)
      .send({
        chosenCode: "E11.65",
        chosenDescription: "Type 2 diabetes mellitus with hyperglycemia",
        chosenHccCategory: "HCC 18 — Diabetes with Chronic Complications",
        hccUnlocked: true,
      });
    expect(res.status).toBe(200);
    expect(res.body.editedCode).toBe("E11.65");
    expect(res.body.editedDescription).toBe(
      "Type 2 diabetes mellitus with hyperglycemia",
    );
    expect(res.body.hccCategory).toContain("HCC 18");
    expect(res.body.rafRelevant).toBe(true);
    expect(res.body.statusNote).toContain("Refined");
    expect(res.body.statusNote).toContain("unlocked HCC");

    // Verify the row was actually updated (not just the response).
    const [row] = await getDb()
      .select()
      .from(billingSuggestionsTable)
      .where(eq(billingSuggestionsTable.id, icd10SuggestionId));
    expect(row!.editedCode).toBe("E11.65");
    expect(row!.rafRelevant).toBe(true);
  });

  it("apply-refinement with hccUnlocked=false preserves existing HCC category", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { icd10SuggestionId } = await seedSessionWithSuggestion(
      agent,
      csrfToken,
      NOTE_BODY,
    );

    // Pre-set an HCC on the suggestion (would normally come from
    // the original AI extraction).
    await getDb()
      .update(billingSuggestionsTable)
      .set({ hccCategory: "HCC 19 — Diabetes without Complication" })
      .where(eq(billingSuggestionsTable.id, icd10SuggestionId));

    const res = await agent
      .post(`/api/coding/suggestions/${icd10SuggestionId}/apply-refinement`)
      .set("X-CSRF-Token", csrfToken)
      .send({
        chosenCode: "E11.9",
        chosenDescription: "Type 2 diabetes mellitus without complications",
        chosenHccCategory: null,
        hccUnlocked: false,
      });
    expect(res.status).toBe(200);
    // HCC-neutral refinement must not overwrite the original — that would
    // silently drop revenue capture.
    expect(res.body.hccCategory).toBe("HCC 19 — Diabetes without Complication");
  });

  it("apply-refinement returns 409 for non-editable suggestion (already approved)", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { icd10SuggestionId } = await seedSessionWithSuggestion(
      agent,
      csrfToken,
      NOTE_BODY,
    );

    await getDb()
      .update(billingSuggestionsTable)
      .set({ status: "provider_approved" })
      .where(eq(billingSuggestionsTable.id, icd10SuggestionId));

    const res = await agent
      .post(`/api/coding/suggestions/${icd10SuggestionId}/apply-refinement`)
      .set("X-CSRF-Token", csrfToken)
      .send({
        chosenCode: "E11.65",
        chosenDescription: "x",
        hccUnlocked: false,
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("suggestion_not_editable");
  });

  it("POST /coding/sessions/:id/refine-all returns aggregate with hccUnlockCount", async () => {
    const { agent, csrfToken } = await loginAgent();
    const { sessionId } = await seedSessionWithSuggestion(
      agent,
      csrfToken,
      NOTE_BODY,
    );

    const res = await agent
      .post(`/api/coding/sessions/${sessionId}/refine-all`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("stub");
    // Stub returns no refinement options, so items each have empty arrays
    // and hccUnlockCount is 0. Items array still includes every refinable
    // suggestion (icd10 + cpt) so the UI can show "checked, nothing found".
    expect(res.body.hccUnlockCount).toBe(0);
    expect(Array.isArray(res.body.items)).toBe(true);
    for (const item of res.body.items) {
      expect(item.options).toEqual([]);
    }
  });
});
