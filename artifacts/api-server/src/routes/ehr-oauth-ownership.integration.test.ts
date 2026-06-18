// Ownership boundary tests for the EHR OAuth routes.
//
// These routes already scope every DB read/write by `req.user.id`
// (see comments in routes/ehr-oauth.ts). The risk this suite is
// guarding against is a future regression that lets one physician
// view or modify another's EHR connection — by adding a `?userId=`
// param, by trusting a header, by widening a WHERE clause, etc.
//
// We seed two users with two separate connections and assert that
// neither can observe or affect the other's row through the public
// HTTP surface.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { ehrConnectionsTable, getDb } from "@workspace/db";
import app from "../app";
import {
  createTestUser,
  resetTestDb,
  teardownTestDb,
} from "../../test/helpers";

const USER_A_EMAIL = "physician-a@halonote.test";
const USER_B_EMAIL = "physician-b@halonote.test";
const PASSWORD = "correct horse battery staple";

// Placeholder ciphertext values for the seeded rows. The status route
// does NOT decrypt — it only reports metadata fields — so we don't
// need real ciphertext for these tests. The shape is just enough to
// not look like a plaintext token if something logs them by accident.
const PLACEHOLDER_CT = "v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBB.CCCCCCCCCCCCCCCC";

interface LoggedIn {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
}

async function login(email: string): Promise<LoggedIn> {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ email, password: PASSWORD });
  expect(res.status).toBe(200);
  const cookies = res.headers["set-cookie"] as unknown as string[];
  const csrf = cookies.find((c) => c.startsWith("halonote_csrf="))!;
  const csrfToken = csrf.split("=")[1]!.split(";")[0]!;
  return { agent, csrfToken };
}

async function seedConnection(opts: {
  userId: string;
  provider: "athenahealth";
  practitionerId: string;
  scope: string;
  expiresAt: Date;
}): Promise<void> {
  await getDb().insert(ehrConnectionsTable).values({
    organizationId: "org_default",
    userId: opts.userId,
    provider: opts.provider,
    accessToken: PLACEHOLDER_CT,
    refreshToken: PLACEHOLDER_CT,
    expiresAt: opts.expiresAt,
    practitionerId: opts.practitionerId,
    scope: opts.scope,
  });
}

async function countConnectionsFor(
  userId: string,
  provider: "athenahealth",
): Promise<number> {
  const rows = await getDb()
    .select({ id: ehrConnectionsTable.id })
    .from(ehrConnectionsTable)
    .where(
      and(
        eq(ehrConnectionsTable.userId, userId),
        eq(ehrConnectionsTable.provider, provider),
      ),
    );
  return rows.length;
}

describe("EHR OAuth ownership boundaries (integration)", () => {
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    const a = await createTestUser({
      email: USER_A_EMAIL,
      password: PASSWORD,
      displayName: "Dr. A",
      role: "member",
    });
    const b = await createTestUser({
      email: USER_B_EMAIL,
      password: PASSWORD,
      displayName: "Dr. B",
      role: "member",
    });
    userAId = a.id;
    userBId = b.id;

    // Seed both users with their OWN athenahealth connection. Distinct
    // practitioner ids so we can prove each user only sees their own.
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000);
    await seedConnection({
      userId: userAId,
      provider: "athenahealth",
      practitionerId: "Practitioner-AAA",
      scope: "openid fhirUser scope-for-A",
      expiresAt: tomorrow,
    });
    await seedConnection({
      userId: userBId,
      provider: "athenahealth",
      practitionerId: "Practitioner-BBB",
      scope: "openid fhirUser scope-for-B",
      expiresAt: tomorrow,
    });
  });

  it("user A sees only their own connection on GET /auth/ehr/status", async () => {
    const { agent } = await login(USER_A_EMAIL);
    const res = await agent.get("/api/auth/ehr/status");
    expect(res.status).toBe(200);
    expect(res.body.athenahealth.connected).toBe(true);
    expect(res.body.athenahealth.practitionerId).toBe("Practitioner-AAA");
    expect(res.body.athenahealth.scope).toBe("openid fhirUser scope-for-A");
    // Belt-and-suspenders: the response must not contain user B's
    // practitioner id anywhere (no leak via stringified body).
    expect(JSON.stringify(res.body)).not.toContain("Practitioner-BBB");
    expect(JSON.stringify(res.body)).not.toContain("scope-for-B");
  });

  it("user B sees only their own connection on GET /auth/ehr/status", async () => {
    const { agent } = await login(USER_B_EMAIL);
    const res = await agent.get("/api/auth/ehr/status");
    expect(res.status).toBe(200);
    expect(res.body.athenahealth.practitionerId).toBe("Practitioner-BBB");
    expect(JSON.stringify(res.body)).not.toContain("Practitioner-AAA");
    expect(JSON.stringify(res.body)).not.toContain("scope-for-A");
  });

  it("a user with no connection sees connected:false (does NOT see another user's row)", async () => {
    // Wipe user A's connection so they have nothing of their own;
    // user B's row stays.
    await getDb()
      .delete(ehrConnectionsTable)
      .where(eq(ehrConnectionsTable.userId, userAId));
    const { agent } = await login(USER_A_EMAIL);
    const res = await agent.get("/api/auth/ehr/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ athenahealth: { connected: false } });
    // Crucially: even though user B still has a row, A's status must
    // not reveal it. The empty-state shape must be identical to the
    // genuinely-no-connections case.
    expect(JSON.stringify(res.body)).not.toContain("Practitioner-BBB");
  });

  it("user A can DELETE their own provider connection and B's row is untouched", async () => {
    const { agent, csrfToken } = await login(USER_A_EMAIL);
    const res = await agent
      .delete("/api/auth/ehr/athenahealth")
      .set("X-CSRF-Token", csrfToken);
    expect(res.status).toBe(204);

    // A's row is gone, B's row is intact — proves the WHERE was
    // scoped to req.user.id.
    expect(await countConnectionsFor(userAId, "athenahealth")).toBe(0);
    expect(await countConnectionsFor(userBId, "athenahealth")).toBe(1);
  });

  it("DELETE with no connection of your own returns 404 and does NOT touch another user's row", async () => {
    // Wipe A's row, then have A try to delete — expect 404
    // not_connected. Critically, B's row must still exist (proves the
    // 404 isn't a global "no such row anywhere" signal).
    await getDb()
      .delete(ehrConnectionsTable)
      .where(eq(ehrConnectionsTable.userId, userAId));
    const { agent, csrfToken } = await login(USER_A_EMAIL);
    const res = await agent
      .delete("/api/auth/ehr/athenahealth")
      .set("X-CSRF-Token", csrfToken);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_connected" });
    expect(await countConnectionsFor(userBId, "athenahealth")).toBe(1);
  });

  it("unauthenticated GET /auth/ehr/status returns 401", async () => {
    const res = await request(app).get("/api/auth/ehr/status");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthenticated" });
  });

  it("unauthenticated DELETE /auth/ehr/:provider returns 401 and does not touch any row", async () => {
    // Note: unauthenticated POST/DELETE/PATCH typically hits the CSRF
    // middleware first — but requireAuth is mounted before requireCsrf
    // (see routes/index.ts), so we expect 401, not 403.
    const res = await request(app).delete("/api/auth/ehr/athenahealth");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "unauthenticated" });
    // Both users' rows must remain intact.
    expect(await countConnectionsFor(userAId, "athenahealth")).toBe(1);
    expect(await countConnectionsFor(userBId, "athenahealth")).toBe(1);
  });
});
