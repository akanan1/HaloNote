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
import { getDb, usersTable } from "@workspace/db";
import app from "../app";
import {
  TEST_ADMIN_TOTP_SECRET,
  createTestUser,
  currentTotpCode,
  resetTestDb,
  teardownTestDb,
} from "../../test/helpers";

const ADMIN_EMAIL = "admin-users-test@halonote.test";
const MEMBER_EMAIL = "member-users-test@halonote.test";
const PASSWORD = "correct horse battery staple";

async function login(email: string) {
  const agent = request.agent(app);
  // createTestUser auto-enrolls admins with TEST_ADMIN_TOTP_SECRET.
  // Sending the current code unconditionally is harmless for members
  // — the login endpoint ignores `totpCode` when totpEnabledAt is null.
  const res = await agent.post("/api/auth/login").send({
    email,
    password: PASSWORD,
    totpCode: currentTotpCode(TEST_ADMIN_TOTP_SECRET),
  });
  const cookies = res.headers["set-cookie"] as unknown as string[];
  const csrf = cookies.find((c) => c.startsWith("halonote_csrf="))!;
  const csrfToken = csrf.split("=")[1]!.split(";")[0]!;
  return { agent, csrfToken, userId: (res.body as { id: string }).id };
}

describe("users routes (integration)", () => {
  beforeAll(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    await createTestUser({
      email: ADMIN_EMAIL,
      password: PASSWORD,
      displayName: "Admin User",
      role: "admin",
    });
    await createTestUser({
      email: MEMBER_EMAIL,
      password: PASSWORD,
      displayName: "Member User",
      role: "member",
    });
  });

  it("GET /users requires admin role (member -> 403)", async () => {
    const { agent } = await login(MEMBER_EMAIL);
    const res = await agent.get("/api/users");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
  });

  it("GET /users returns the user list to admins", async () => {
    const { agent } = await login(ADMIN_EMAIL);
    const res = await agent.get("/api/users");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    const emails = (
      res.body.data as Array<{ email: string }>
    ).map((u) => u.email);
    expect(emails).toContain(ADMIN_EMAIL);
    expect(emails).toContain(MEMBER_EMAIL);
    // No password hash leaks through.
    expect(res.body.data[0]).not.toHaveProperty("passwordHash");
  });

  it("PATCH /users/:id promotes a member to admin once they've enrolled TOTP", async () => {
    const { agent, csrfToken } = await login(ADMIN_EMAIL);
    const list = await agent.get("/api/users");
    const member = (
      list.body.data as Array<{ id: string; email: string; role: string }>
    ).find((u) => u.email === MEMBER_EMAIL)!;
    expect(member.role).toBe("member");

    // Pretend the member has already enrolled TOTP (separate test
    // covers that endpoint). Directly set totpEnabledAt — we only care
    // that the promotion gate sees a non-null timestamp.
    await getDb()
      .update(usersTable)
      .set({
        totpSecret: "JBSWY3DPEHPK3PXP",
        totpEnabledAt: new Date(),
      })
      .where(eq(usersTable.id, member.id));

    const res = await agent
      .patch(`/api/users/${member.id}`)
      .set("X-CSRF-Token", csrfToken)
      .send({ role: "admin" });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("admin");

    const [updated] = await getDb()
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, member.id));
    expect(updated?.role).toBe("admin");
  });

  it("PATCH /users/:id refuses to promote a user who hasn't enrolled TOTP", async () => {
    const { agent, csrfToken } = await login(ADMIN_EMAIL);
    const list = await agent.get("/api/users");
    const member = (
      list.body.data as Array<{ id: string; email: string }>
    ).find((u) => u.email === MEMBER_EMAIL)!;

    // The member is fresh out of createTestUser — no TOTP enrolled.
    const res = await agent
      .patch(`/api/users/${member.id}`)
      .set("X-CSRF-Token", csrfToken)
      .send({ role: "admin" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "target_must_enroll_totp_before_admin",
    });

    // DB unchanged — still a member.
    const [row] = await getDb()
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, member.id));
    expect(row?.role).toBe("member");
  });

  it("PATCH /users/:id refuses self-demotion", async () => {
    const { agent, csrfToken, userId } = await login(ADMIN_EMAIL);
    const res = await agent
      .patch(`/api/users/${userId}`)
      .set("X-CSRF-Token", csrfToken)
      .send({ role: "member" });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "cannot_demote_self" });

    // DB unchanged.
    const [row] = await getDb()
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    expect(row?.role).toBe("admin");
  });

  it("PATCH /users/:id allows admin to demote a different admin", async () => {
    // A second admin so the system isn't down to one.
    const OTHER_ADMIN = "other-admin@halonote.test";
    await createTestUser({
      email: OTHER_ADMIN,
      password: PASSWORD,
      displayName: "Other Admin",
      role: "admin",
    });

    const { agent, csrfToken } = await login(ADMIN_EMAIL);
    const list = await agent.get("/api/users");
    const other = (
      list.body.data as Array<{ id: string; email: string }>
    ).find((u) => u.email === OTHER_ADMIN)!;

    const res = await agent
      .patch(`/api/users/${other.id}`)
      .set("X-CSRF-Token", csrfToken)
      .send({ role: "member" });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("member");
  });

  it("PATCH /users/:id 404s for an unknown id", async () => {
    const { agent, csrfToken } = await login(ADMIN_EMAIL);
    const res = await agent
      .patch("/api/users/usr_does_not_exist")
      .set("X-CSRF-Token", csrfToken)
      .send({ role: "admin" });
    expect(res.status).toBe(404);
  });

  it("PATCH /users/:id rejects an empty body", async () => {
    const { agent, csrfToken } = await login(ADMIN_EMAIL);
    const list = await agent.get("/api/users");
    const member = (
      list.body.data as Array<{ id: string; email: string }>
    ).find((u) => u.email === MEMBER_EMAIL)!;

    const res = await agent
      .patch(`/api/users/${member.id}`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    expect(res.status).toBe(400);
  });

  it("admin login is refused when the user hasn't enrolled TOTP", async () => {
    // Stand up an admin with TOTP explicitly off — this should only
    // happen via a legacy row or DB tampering, but the login endpoint
    // refuses to mint a session for them either way.
    const LEGACY_EMAIL = "legacy-admin@halonote.test";
    await createTestUser({
      email: LEGACY_EMAIL,
      password: PASSWORD,
      displayName: "Legacy Admin",
      role: "admin",
      enrollTotp: false,
    });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: LEGACY_EMAIL, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "totp_required_for_admin" });
    // No session cookie set on a rejected admin login.
    const cookies = (res.headers["set-cookie"] as unknown as string[]) ?? [];
    expect(cookies.some((c) => c.startsWith("halonote_session="))).toBe(false);
  });

  it("PATCH /users/:id rejects an invalid role value", async () => {
    const { agent, csrfToken } = await login(ADMIN_EMAIL);
    const list = await agent.get("/api/users");
    const member = (
      list.body.data as Array<{ id: string; email: string }>
    ).find((u) => u.email === MEMBER_EMAIL)!;

    const res = await agent
      .patch(`/api/users/${member.id}`)
      .set("X-CSRF-Token", csrfToken)
      .send({ role: "superuser" });
    expect(res.status).toBe(400);
  });
});
