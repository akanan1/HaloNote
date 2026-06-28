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

const EMAIL = "twofactor@halonote.test";
const PASSWORD = "correct horse battery staple";

async function loginAgent(extra?: { totpCode?: string }) {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ email: EMAIL, password: PASSWORD, ...(extra ?? {}) });
  return { agent, res };
}

async function loginAgentWithCsrf() {
  const { agent, res } = await loginAgent();
  const cookies = res.headers["set-cookie"] as unknown as string[];
  const csrf = cookies.find((c) => c.startsWith("halonote_csrf="))!;
  const csrfToken = csrf.split("=")[1]!.split(";")[0]!;
  return { agent, csrfToken };
}

function currentTotpCode(secretBase32: string): string {
  return new TOTP({
    issuer: "HaloNote",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  }).generate();
}

describe("2FA (TOTP) integration", () => {
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
      displayName: "2FA User",
    });
  });

  it("setup returns a secret + otpauth URI + QR data URL", async () => {
    const { agent, csrfToken } = await loginAgentWithCsrf();
    const res = await agent
      .post("/api/auth/2fa/setup")
      .set("X-CSRF-Token", csrfToken)
      .send({});

    expect(res.status).toBe(200);
    expect(typeof res.body.secret).toBe("string");
    expect(res.body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(res.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);

    // Secret stored, but enabledAt should still be null.
    const [row] = await getDb()
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, EMAIL));
    expect(row?.totpSecret).toBe(res.body.secret);
    expect(row?.totpEnabledAt).toBeNull();
  });

  it("verify-setup with a valid code enables 2FA", async () => {
    const { agent, csrfToken } = await loginAgentWithCsrf();
    const setup = await agent
      .post("/api/auth/2fa/setup")
      .set("X-CSRF-Token", csrfToken)
      .send({});

    const code = currentTotpCode(setup.body.secret as string);
    const verify = await agent
      .post("/api/auth/2fa/verify-setup")
      .set("X-CSRF-Token", csrfToken)
      .send({ code });

    expect(verify.status).toBe(204);

    const [row] = await getDb()
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, EMAIL));
    expect(row?.totpEnabledAt).not.toBeNull();
  });

  it("verify-setup rejects an invalid code", async () => {
    const { agent, csrfToken } = await loginAgentWithCsrf();
    await agent
      .post("/api/auth/2fa/setup")
      .set("X-CSRF-Token", csrfToken)
      .send({});

    const verify = await agent
      .post("/api/auth/2fa/verify-setup")
      .set("X-CSRF-Token", csrfToken)
      .send({ code: "000000" });

    expect(verify.status).toBe(400);
    expect(verify.body).toEqual({ error: "invalid_totp_code" });
  });

  it("login on a 2FA-enabled account requires totpCode", async () => {
    // Enable 2FA.
    const { agent, csrfToken } = await loginAgentWithCsrf();
    const setup = await agent
      .post("/api/auth/2fa/setup")
      .set("X-CSRF-Token", csrfToken)
      .send({});
    const code = currentTotpCode(setup.body.secret as string);
    await agent
      .post("/api/auth/2fa/verify-setup")
      .set("X-CSRF-Token", csrfToken)
      .send({ code });

    // Fresh login without totpCode → 401 totp_required.
    const noCode = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    expect(noCode.status).toBe(401);
    expect(noCode.body).toEqual({ error: "totp_required" });

    // Wrong totpCode → 401 invalid_totp_code.
    const wrong = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD, totpCode: "000000" });
    expect(wrong.status).toBe(401);
    expect(wrong.body).toEqual({ error: "invalid_totp_code" });

    // Correct code → 200 + session cookie.
    const fresh = currentTotpCode(setup.body.secret as string);
    const okRes = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: PASSWORD, totpCode: fresh });
    expect(okRes.status).toBe(200);
    expect(okRes.body.email).toBe(EMAIL);
  });

  it("disable clears the secret and enabled flag when given valid password + code", async () => {
    const { agent, csrfToken } = await loginAgentWithCsrf();
    const setup = await agent
      .post("/api/auth/2fa/setup")
      .set("X-CSRF-Token", csrfToken)
      .send({});
    const code = currentTotpCode(setup.body.secret as string);
    await agent
      .post("/api/auth/2fa/verify-setup")
      .set("X-CSRF-Token", csrfToken)
      .send({ code });

    const fresh = currentTotpCode(setup.body.secret as string);
    const disable = await agent
      .post("/api/auth/2fa/disable")
      .set("X-CSRF-Token", csrfToken)
      .send({ password: PASSWORD, totpCode: fresh });
    expect(disable.status).toBe(204);

    const [row] = await getDb()
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, EMAIL));
    expect(row?.totpSecret).toBeNull();
    expect(row?.totpEnabledAt).toBeNull();
  });

  it("setup on an already-enabled account 409s", async () => {
    const { agent, csrfToken } = await loginAgentWithCsrf();
    const setup = await agent
      .post("/api/auth/2fa/setup")
      .set("X-CSRF-Token", csrfToken)
      .send({});
    const code = currentTotpCode(setup.body.secret as string);
    await agent
      .post("/api/auth/2fa/verify-setup")
      .set("X-CSRF-Token", csrfToken)
      .send({ code });

    const second = await agent
      .post("/api/auth/2fa/setup")
      .set("X-CSRF-Token", csrfToken)
      .send({});
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: "totp_already_enabled" });
  });
});
