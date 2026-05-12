import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { sql } from "drizzle-orm";
import { auditLogTable, getDb } from "@workspace/db";
import {
  cleanupExpiredAuditLogs,
  _readRetentionDays,
} from "./audit-cleanup";
import {
  createTestUser,
  resetTestDb,
  teardownTestDb,
} from "../../test/helpers";

const EMAIL = "audit-cleanup@halonote.test";

async function insertAuditAt(userId: string, daysAgo: number): Promise<void> {
  // Bypass the middleware to directly seed historical rows at a specific
  // timestamp.
  await getDb()
    .insert(auditLogTable)
    .values({
      userId,
      action: "view_test",
      resourceType: "test",
    });
  // Set `at` by raw SQL so we can put it in the past.
  await getDb().execute(sql`
    UPDATE audit_log
    SET at = NOW() - (${daysAgo}::int * INTERVAL '1 day')
    WHERE id = (SELECT id FROM audit_log ORDER BY at DESC LIMIT 1)
  `);
}

describe("audit log cleanup (integration)", () => {
  beforeAll(async () => {
    await resetTestDb();
  });

  afterAll(async () => {
    await teardownTestDb();
  });

  beforeEach(async () => {
    await resetTestDb();
    delete process.env["AUDIT_LOG_RETENTION_DAYS"];
  });

  afterEach(() => {
    delete process.env["AUDIT_LOG_RETENTION_DAYS"];
  });

  it("deletes rows older than the retention window, keeps newer ones", async () => {
    process.env["AUDIT_LOG_RETENTION_DAYS"] = "30";
    const user = await createTestUser({
      email: EMAIL,
      password: "x".repeat(10),
      displayName: "Audit Cleanup User",
    });

    await insertAuditAt(user.id, 0);   // today
    await insertAuditAt(user.id, 15);  // 15 days ago
    await insertAuditAt(user.id, 45);  // 45 days ago — past retention
    await insertAuditAt(user.id, 200); // 200 days ago — past retention

    const deleted = await cleanupExpiredAuditLogs();
    expect(deleted).toBe(2);

    const rows = await getDb().select().from(auditLogTable);
    expect(rows.length).toBe(2);
  });

  it("is a no-op when retention is 0 (disabled)", async () => {
    process.env["AUDIT_LOG_RETENTION_DAYS"] = "0";
    const user = await createTestUser({
      email: EMAIL,
      password: "x".repeat(10),
      displayName: "Audit Cleanup User",
    });
    await insertAuditAt(user.id, 9999);

    const deleted = await cleanupExpiredAuditLogs();
    expect(deleted).toBe(0);

    const rows = await getDb().select().from(auditLogTable);
    expect(rows.length).toBe(1);
  });

  it("readRetentionDays falls back to the 7-year default on bad input", () => {
    delete process.env["AUDIT_LOG_RETENTION_DAYS"];
    expect(_readRetentionDays()).toBe(2555);

    process.env["AUDIT_LOG_RETENTION_DAYS"] = "not-a-number";
    expect(_readRetentionDays()).toBe(2555);

    process.env["AUDIT_LOG_RETENTION_DAYS"] = "-5";
    expect(_readRetentionDays()).toBe(2555);

    process.env["AUDIT_LOG_RETENTION_DAYS"] = "90";
    expect(_readRetentionDays()).toBe(90);
  });
});
