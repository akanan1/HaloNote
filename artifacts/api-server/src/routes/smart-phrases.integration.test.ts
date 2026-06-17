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

const EMAIL = "smart-phrases@halonote.test";
const PASSWORD = "correct horse battery staple";
const DISPLAY = "Smart Phrases User";

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

describe("smart phrases routes (integration)", () => {
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

  it("GET /smart-phrases returns an empty list for a new account", async () => {
    const { agent } = await loginAgent();
    const res = await agent.get("/api/smart-phrases");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: [] });
  });

  it("POST /smart-phrases creates a phrase and lowercases the shortcut", async () => {
    const { agent, csrfToken } = await loginAgent();
    const res = await agent
      .post("/api/smart-phrases")
      .set("X-CSRF-Token", csrfToken)
      .send({
        shortcut: "HTN",
        body: "Hypertension, well-controlled on lisinopril.",
        description: "Hypertension A&P",
      });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      shortcut: "htn",
      body: "Hypertension, well-controlled on lisinopril.",
      description: "Hypertension A&P",
      usageCount: 0,
    });
  });

  it("POST /smart-phrases rejects shortcuts with whitespace or dots", async () => {
    const { agent, csrfToken } = await loginAgent();
    const withSpace = await agent
      .post("/api/smart-phrases")
      .set("X-CSRF-Token", csrfToken)
      .send({ shortcut: "ht n", body: "x" });
    expect(withSpace.status).toBe(400);

    const withDot = await agent
      .post("/api/smart-phrases")
      .set("X-CSRF-Token", csrfToken)
      .send({ shortcut: ".htn", body: "x" });
    expect(withDot.status).toBe(400);
  });

  it("POST /smart-phrases returns 409 on case-insensitive duplicate shortcut", async () => {
    const { agent, csrfToken } = await loginAgent();
    const first = await agent
      .post("/api/smart-phrases")
      .set("X-CSRF-Token", csrfToken)
      .send({ shortcut: "htn", body: "A" });
    expect(first.status).toBe(201);

    const second = await agent
      .post("/api/smart-phrases")
      .set("X-CSRF-Token", csrfToken)
      .send({ shortcut: "HTN", body: "B" });
    expect(second.status).toBe(409);
  });

  it("PATCH /smart-phrases/:id updates fields and accepts null description", async () => {
    const { agent, csrfToken } = await loginAgent();
    const created = await agent
      .post("/api/smart-phrases")
      .set("X-CSRF-Token", csrfToken)
      .send({ shortcut: "htn", body: "old", description: "old desc" });
    const id = (created.body as { id: string }).id;

    const patched = await agent
      .patch(`/api/smart-phrases/${id}`)
      .set("X-CSRF-Token", csrfToken)
      .send({ body: "new", description: null });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      shortcut: "htn",
      body: "new",
      description: null,
    });
  });

  it("POST /smart-phrases/:id/used increments usageCount and ranks listing", async () => {
    const { agent, csrfToken } = await loginAgent();
    const a = await agent
      .post("/api/smart-phrases")
      .set("X-CSRF-Token", csrfToken)
      .send({ shortcut: "aaa", body: "A" });
    const b = await agent
      .post("/api/smart-phrases")
      .set("X-CSRF-Token", csrfToken)
      .send({ shortcut: "bbb", body: "B" });
    const aId = (a.body as { id: string }).id;
    const bId = (b.body as { id: string }).id;

    // Fire `bbb` twice. Listing should put bbb above aaa even though
    // aaa wins the alphabetical tiebreaker.
    await agent
      .post(`/api/smart-phrases/${bId}/used`)
      .set("X-CSRF-Token", csrfToken)
      .send({});
    await agent
      .post(`/api/smart-phrases/${bId}/used`)
      .set("X-CSRF-Token", csrfToken)
      .send({});

    const listed = await agent.get("/api/smart-phrases");
    expect(listed.status).toBe(200);
    const ids = (listed.body as { data: Array<{ id: string }> }).data.map(
      (r) => r.id,
    );
    expect(ids).toEqual([bId, aId]);
  });

  it("DELETE /smart-phrases/:id removes the phrase and 404s on repeat", async () => {
    const { agent, csrfToken } = await loginAgent();
    const created = await agent
      .post("/api/smart-phrases")
      .set("X-CSRF-Token", csrfToken)
      .send({ shortcut: "rm", body: "remove me" });
    const id = (created.body as { id: string }).id;

    const first = await agent
      .delete(`/api/smart-phrases/${id}`)
      .set("X-CSRF-Token", csrfToken);
    expect(first.status).toBe(204);

    const second = await agent
      .delete(`/api/smart-phrases/${id}`)
      .set("X-CSRF-Token", csrfToken);
    expect(second.status).toBe(404);
  });

  it("GET /smart-phrases is rejected without a session", async () => {
    const res = await request(app).get("/api/smart-phrases");
    expect(res.status).toBe(401);
  });
});
