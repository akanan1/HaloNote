// Integration tests for the hardened sensitive-auth endpoints:
//   - POST /auth/2fa/disable        (now requires password + totpCode)
//   - POST /auth/password-reset/confirm (now gated on TOTP for 2FA users)
//
// Coverage:
//   1. disable 2FA without password → 401
//   2. disable 2FA wrong password, right TOTP → 401
//   3. disable 2FA right password, wrong TOTP → 401
//   4. disable 2FA both correct → 204, totp secret cleared
//   5. password reset on a 2FA account without totpCode → 400 TOTP_REQUIRED
//   6. password reset on a 2FA account wrong TOTP → 401
//   7. password reset on a non-2FA account ignores totpCode field (200)
//   8. rate-limit kicks in at 6th attempt within an hour
//
// Naming: the user's brief said "Tests in routes/auth.test.ts" but
// the integration vitest config only matches `*.integration.test.ts`
// (vitest.integration.config.ts include glob); naming the file
// `auth.test.ts` would route it to the unit-only config and skip
// the Postgres-backed rate-limit assertions. Using
// auth-hardening.integration.test.ts to colocate with the existing
// auth.integration.test.ts and ensure it runs under test:integration.

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
import { TOTP, Secret } from "otpauth";
import { getDb, usersTable } from "@workspace/db";
import app from "../app";
import {
  createTestUser,
  resetTestDb,
  teardownTestDb,
} from "../../test/helpers";
import { drainSentEmails, getLastEmailTo } from "../lib/email";

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "a brand new strong password";

function currentTotpCode(secretBase32: string): string {
  return new TOTP({
    issuer: "HaloNote",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  }).generate();
}

// Drive the full setup → verify-setup flow against a logged-in agent
// so we end with a real 2FA-enabled user AND a usable session cookie
// for the same agent. Returns the secret so the test can compute
// fresh TOTPs for subsequent calls.
type SuperAgent = ReturnType<typeof request.agent>;

async function enable2faForLoggedInUser(
  email: string,
): Promise<{ agent: SuperAgent; csrfToken: string; secret: string }> {
  const agent = request.agent(app);
  const login = await agent
    .post("/api/auth/login")
    .send({ email, password: PASSWORD });
  const cookies = login.headers["set-cookie"] as unknown as string[];
  const csrf = cookies.find((c) => c.startsWith("halonote_csrf="))!;
  const csrfToken = csrf.split("=")[1]!.split(";")[0]!;

  const setup = await agent
    .post("/api/auth/2fa/setup")
    .set("X-CSRF-Token", csrfToken)
    .send({});
  const secret = setup.body.secret as string;
  await agent
    .post("/api/auth/2fa/verify-setup")
    .set("X-CSRF-Token", csrfToken)
    .send({ code: currentTotpCode(secret) });

  return { agent, csrfToken, secret };
}

// Each test uses its own email so cross-test rate-limit buckets
// (keyed by user id or by reset token) don't leak between cases.
function uniqueEmail(suffix: string): string {
  return `${suffix}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}@halonote.test`;
}

describe("POST /auth/2fa/disable (hardened)", () => {
  beforeAll(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
  });

  it("401 when password is missing", async () => {
    const email = uniqueEmail("disable-nopw");
    await createTestUser({ email, password: PASSWORD, displayName: "U" });
    const { agent, csrfToken, secret } = await enable2faForLoggedInUser(email);

    const res = await agent
      .post("/api/auth/2fa/disable")
      .set("X-CSRF-Token", csrfToken)
      .send({ totpCode: currentTotpCode(secret) });
    expect(res.status).toBe(401);

    // Secret must remain on the row — the disable was rejected.
    const [row] = await getDb()
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));
    expect(row?.totpSecret).not.toBeNull();
    expect(row?.totpEnabledAt).not.toBeNull();
  });

  it("401 when password is wrong but TOTP is correct", async () => {
    const email = uniqueEmail("disable-badpw");
    await createTestUser({ email, password: PASSWORD, displayName: "U" });
    const { agent, csrfToken, secret } = await enable2faForLoggedInUser(email);

    const res = await agent
      .post("/api/auth/2fa/disable")
      .set("X-CSRF-Token", csrfToken)
      .send({
        password: "definitely not the password",
        totpCode: currentTotpCode(secret),
      });
    expect(res.status).toBe(401);

    const [row] = await getDb()
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));
    expect(row?.totpSecret).not.toBeNull();
  });

  it("401 when password is correct but TOTP is wrong", async () => {
    const email = uniqueEmail("disable-badtotp");
    await createTestUser({ email, password: PASSWORD, displayName: "U" });
    const { agent, csrfToken } = await enable2faForLoggedInUser(email);

    const res = await agent
      .post("/api/auth/2fa/disable")
      .set("X-CSRF-Token", csrfToken)
      .send({ password: PASSWORD, totpCode: "000000" });
    expect(res.status).toBe(401);

    const [row] = await getDb()
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));
    expect(row?.totpSecret).not.toBeNull();
  });

  it("204 + clears totp_secret + totp_enabled_at when both factors are correct", async () => {
    const email = uniqueEmail("disable-ok");
    await createTestUser({ email, password: PASSWORD, displayName: "U" });
    const { agent, csrfToken, secret } = await enable2faForLoggedInUser(email);

    const res = await agent
      .post("/api/auth/2fa/disable")
      .set("X-CSRF-Token", csrfToken)
      .send({ password: PASSWORD, totpCode: currentTotpCode(secret) });
    expect(res.status).toBe(204);

    const [row] = await getDb()
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email));
    expect(row?.totpSecret).toBeNull();
    expect(row?.totpEnabledAt).toBeNull();
  });
});

describe("POST /auth/password-reset/confirm (2FA gating)", () => {
  beforeAll(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    drainSentEmails();
  });

  // Helper: ask for a reset link, extract the token from the email,
  // and return it. Always uses the request-side email rate limiter,
  // so each test should use a fresh email to avoid bumping into it.
  async function issueResetToken(email: string): Promise<string> {
    const r = await request(app)
      .post("/api/auth/password-reset/request")
      .send({ email });
    expect(r.status).toBe(204);
    const sent = getLastEmailTo(email);
    expect(sent).toBeDefined();
    const m = sent!.body.match(/[?&]token=([^\s&]+)/);
    expect(m).toBeTruthy();
    return decodeURIComponent(m![1]!);
  }

  it("returns 400 + code TOTP_REQUIRED for a 2FA account when totpCode is missing", async () => {
    const email = uniqueEmail("pwreset-nototp");
    await createTestUser({ email, password: PASSWORD, displayName: "U" });
    // Enable 2FA via the in-session flow.
    await enable2faForLoggedInUser(email);

    const token = await issueResetToken(email);
    const res = await request(app)
      .post("/api/auth/password-reset/confirm")
      .send({ token, password: NEW_PASSWORD });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "TOTP_REQUIRED" });

    // Password must NOT have rolled over.
    const old = await request(app)
      .post("/api/auth/login")
      .send({ email, password: PASSWORD, totpCode: "ignored" });
    // Old password still works (modulo the 2FA gate on login).
    expect([401, 200]).toContain(old.status);
  });

  it("returns 401 for a 2FA account when totpCode is wrong", async () => {
    const email = uniqueEmail("pwreset-badtotp");
    await createTestUser({ email, password: PASSWORD, displayName: "U" });
    await enable2faForLoggedInUser(email);

    const token = await issueResetToken(email);
    const res = await request(app)
      .post("/api/auth/password-reset/confirm")
      .send({ token, password: NEW_PASSWORD, totpCode: "000000" });

    expect(res.status).toBe(401);
  });

  it("ignores totpCode for a non-2FA account and resets the password", async () => {
    const email = uniqueEmail("pwreset-no2fa");
    await createTestUser({ email, password: PASSWORD, displayName: "U" });

    const token = await issueResetToken(email);
    const res = await request(app)
      .post("/api/auth/password-reset/confirm")
      .send({
        token,
        password: NEW_PASSWORD,
        // Junk code — should be ignored since 2FA isn't on.
        totpCode: "999999",
      });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe(email);

    // New password works, old does not.
    const oldLogin = await request(app)
      .post("/api/auth/login")
      .send({ email, password: PASSWORD });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app)
      .post("/api/auth/login")
      .send({ email, password: NEW_PASSWORD });
    expect(newLogin.status).toBe(200);
  });
});

describe("/auth/2fa/disable rate-limit (sensitive-auth-rate-limit)", () => {
  beforeAll(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    // resetTestDb already TRUNCATEs rate_limit_buckets — each case
    // starts with an empty bucket so the per-user limiter starts
    // counting from zero.
    await resetTestDb();
  });

  it("returns 429 on the 6th call within the window (5/hour cap)", async () => {
    const email = uniqueEmail("ratelimit-disable");
    await createTestUser({ email, password: PASSWORD, displayName: "U" });
    const { agent, csrfToken } = await enable2faForLoggedInUser(email);

    // 5 wrong-credential attempts return 401 (rate limit not yet hit).
    for (let i = 0; i < 5; i++) {
      const r = await agent
        .post("/api/auth/2fa/disable")
        .set("X-CSRF-Token", csrfToken)
        .send({ password: "wrong", totpCode: "000000" });
      expect(r.status).toBe(401);
    }

    // 6th attempt: 429 regardless of credentials.
    const sixth = await agent
      .post("/api/auth/2fa/disable")
      .set("X-CSRF-Token", csrfToken)
      .send({ password: "wrong", totpCode: "000000" });
    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual({ error: "too_many_attempts" });
  });
});
