// Regression test for the route-ordering bug fixed by mounting the
// admin sub-routers (audit-log, users) under explicit path prefixes in
// routes/index.ts. Before that fix, `router.use(requireAdmin)` at the
// top of audit-log.ts fired path-agnostically for every request that
// reached the parent router after patientsRouter/notesRouter, which
// 403'd every non-admin request to ehrOauthRouter (mounted later).
//
// We assert three behaviors that, taken together, prove the gate is
// scoped to its sub-router and no longer leaks onto adjacent routes:
//   1. a member user can hit POST /api/auth/ehr/:provider/start
//   2. a member user is still 403'd on GET /api/audit-log
//   3. an admin user is allowed on GET /api/audit-log
//
// We deliberately do NOT exercise the full Athena exchange — we only
// need the start route to make it past requireAdmin and into its own
// handler. ATHENA_* env vars are stubbed to local values so
// providerConfig() resolves; no network is touched (the SMART
// authorize URL is built locally and returned to the caller).

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
  TEST_ADMIN_TOTP_SECRET,
  createTestUser,
  currentTotpCode,
  resetTestDb,
  teardownTestDb,
} from "../../test/helpers";

const MEMBER_EMAIL = "physician@halonote.test";
const ADMIN_EMAIL = "admin@halonote.test";
const PASSWORD = "correct horse battery staple";

interface LoggedIn {
  agent: ReturnType<typeof request.agent>;
  csrfToken: string;
}

async function loginAsMember(): Promise<LoggedIn> {
  const agent = request.agent(app);
  const res = await agent
    .post("/api/auth/login")
    .send({ email: MEMBER_EMAIL, password: PASSWORD });
  const cookies = res.headers["set-cookie"] as unknown as string[];
  const csrf = cookies.find((c) => c.startsWith("halonote_csrf="))!;
  const csrfToken = csrf.split("=")[1]!.split(";")[0]!;
  return { agent, csrfToken };
}

async function loginAsAdmin(): Promise<LoggedIn> {
  const agent = request.agent(app);
  const res = await agent.post("/api/auth/login").send({
    email: ADMIN_EMAIL,
    password: PASSWORD,
    totpCode: currentTotpCode(TEST_ADMIN_TOTP_SECRET),
  });
  const cookies = res.headers["set-cookie"] as unknown as string[];
  const csrf = cookies.find((c) => c.startsWith("halonote_csrf="))!;
  const csrfToken = csrf.split("=")[1]!.split(";")[0]!;
  return { agent, csrfToken };
}

describe("route gating: admin sub-routers must not block non-admin sibling routes (integration)", () => {
  const saved: Record<string, string | undefined> = {};
  const ATHENA_ENV: Record<string, string> = {
    ATHENA_FHIR_BASE_URL: "https://fhir.test.invalid/r4",
    ATHENA_TOKEN_URL: "https://idp.test.invalid/oauth2/v1/token",
    ATHENA_CLIENT_ID: "test-client",
    ATHENA_CLIENT_SECRET: "test-secret",
    ATHENA_REDIRECT_URI: "http://localhost/api/auth/ehr/callback",
    ATHENA_SCOPE: "openid fhirUser offline_access",
  };

  beforeAll(async () => {
    for (const [k, v] of Object.entries(ATHENA_ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    await resetTestDb();
  });

  afterAll(async () => {
    for (const k of Object.keys(ATHENA_ENV)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await teardownTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    await createTestUser({
      email: ADMIN_EMAIL,
      password: PASSWORD,
      displayName: "Admin Annie",
      role: "admin",
    });
    await createTestUser({
      email: MEMBER_EMAIL,
      password: PASSWORD,
      displayName: "Dr. Member",
      role: "member",
    });
  });

  it("member user can reach POST /auth/ehr/athenahealth/start", async () => {
    const { agent, csrfToken } = await loginAsMember();
    const res = await agent
      .post("/api/auth/ehr/athenahealth/start")
      .set("X-CSRF-Token", csrfToken)
      .send({ returnPath: "/settings" });

    expect(res.status).toBe(200);
    // The handler returned its own success shape — proves we made it
    // past requireAdmin (which would have sent {"error":"forbidden"}).
    expect(typeof res.body.authorizeUrl).toBe("string");
    expect(res.body.authorizeUrl).toContain("code_challenge_method=S256");
    expect(res.body.authorizeUrl).toContain("state=");
    // Sanity: the stub IdP host is in the URL — proves the env stubs
    // flowed through providerConfig and nothing real was contacted.
    expect(res.body.authorizeUrl.startsWith("https://idp.test.invalid/")).toBe(
      true,
    );
  });

  it("member user is still forbidden from GET /audit-log", async () => {
    const { agent } = await loginAsMember();
    const res = await agent.get("/api/audit-log");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "forbidden" });
  });

  it("admin user can access GET /audit-log", async () => {
    const { agent } = await loginAsAdmin();
    const res = await agent.get("/api/audit-log");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});
