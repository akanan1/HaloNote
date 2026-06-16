// End-to-end safety net for the legal-onboarding journey.
//
// What we're protecting: a user who hasn't accepted the BAA must
// never reach a PHI route. The check spans `routes/legal.ts`,
// `routes/onboarding.ts`, `middlewares/require-baa.ts`, and the
// routing order in `routes/index.ts`. If any single piece regresses
// the gate, this test catches it.

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

const EMAIL = "journey@halonote.test";
const PASSWORD = "correct horse battery staple";

async function loginAgent() {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ email: EMAIL, password: PASSWORD });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${res.text}`);
  }
  const cookies = res.headers["set-cookie"] as unknown as string[];
  const csrf = cookies.find((c) => c.startsWith("halonote_csrf="))!;
  const csrfToken = csrf.split("=")[1]!.split(";")[0]!;
  return { agent, csrfToken };
}

describe("Legal onboarding → PHI access journey (integration)", () => {
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
      displayName: "Journey User",
    });
  });

  it("blocks PHI access until the BAA is accepted, then opens after acceptance", async () => {
    const { agent, csrfToken } = await loginAgent();

    // Step 1 — fresh user has not accepted anything; the BAA gate
    // must reject the patient-list request.
    const blocked = await agent.get("/api/patients");
    expect(blocked.status).toBe(403);
    expect(blocked.body).toMatchObject({ error: "baa_not_accepted" });

    // Step 2 — pull the current required documents. The body + hash
    // are what the client echoes back on accept.
    const agreementsRes = await agent.get("/api/legal/agreements");
    expect(agreementsRes.status).toBe(200);
    const docs = agreementsRes.body.data as Array<{
      type: string;
      currentVersion: string;
      contentHash: string;
      accepted: boolean;
    }>;
    expect(docs.length).toBeGreaterThan(0);
    for (const d of docs) {
      expect(d.accepted).toBe(false);
    }

    // Step 3 — accept every required document at once.
    const acceptRes = await agent
      .post("/api/legal/accept")
      .set("X-CSRF-Token", csrfToken)
      .send({
        acceptances: docs.map((d) => ({
          type: d.type,
          version: d.currentVersion,
          contentHash: d.contentHash,
        })),
      });
    expect(acceptRes.status).toBe(200);
    for (const d of acceptRes.body.data) {
      expect(d.accepted).toBe(true);
    }

    // Step 4 — finish onboarding so future loads don't bounce to the
    // wizard.
    const onboardingRes = await agent
      .post("/api/onboarding/complete")
      .set("X-CSRF-Token", csrfToken)
      .send({});
    expect(onboardingRes.status).toBe(200);
    expect(onboardingRes.body.onboardingCompleted).toBe(true);

    // Step 5 — PHI route should now be reachable. We don't assert on
    // the response body shape (no patients exist for this test user);
    // a 200 confirms the gate let us through.
    const allowed = await agent.get("/api/patients");
    expect(allowed.status).toBe(200);

    // Step 6 — defense-in-depth: a stale hash on submit must be
    // rejected, never silently persisted.
    const baa = docs.find((d) => d.type === "baa")!;
    const tampered = await agent
      .post("/api/legal/accept")
      .set("X-CSRF-Token", csrfToken)
      .send({
        acceptances: [
          {
            type: "baa",
            version: baa.currentVersion,
            contentHash: "deadbeef".repeat(8),
          },
        ],
      });
    expect(tampered.status).toBe(400);
    expect(tampered.body.error).toBe("content_hash_mismatch");
  });

  it("blocks PHI access for an unknown route under requireBaa even without specific configuration", async () => {
    const { agent } = await loginAgent();
    // /api/recordings is also gated; without acceptance it must 403
    // with the same code so the frontend's single redirect handler
    // works for every PHI route.
    const res = await agent.get("/api/recordings/does-not-exist");
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "baa_not_accepted" });
  });
});
