import { lt, sql } from "drizzle-orm";
import { auditLogTable, getDb } from "@workspace/db";
import { logger } from "./logger";

// HIPAA expects audit logs to be retained for at least 6 years
// (45 CFR 164.530(j)). Default to 7 to leave a buffer, but let the
// operator dial it via env. Set to 0 to disable cleanup entirely.
const DEFAULT_RETENTION_DAYS = 365 * 7;

function readRetentionDays(): number {
  const raw = process.env["AUDIT_LOG_RETENTION_DAYS"]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_RETENTION_DAYS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_RETENTION_DAYS;
  return Math.floor(n);
}

/**
 * Delete audit_log rows older than the retention window. Returns the
 * number of rows deleted. A retention of 0 disables cleanup (treats
 * the table as append-only forever).
 */
export async function cleanupExpiredAuditLogs(): Promise<number> {
  const days = readRetentionDays();
  if (days === 0) return 0;

  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const result = await getDb()
    .delete(auditLogTable)
    .where(lt(auditLogTable.at, cutoff))
    .returning({ id: auditLogTable.id });
  return result.length;
}

let timer: NodeJS.Timeout | undefined;

/**
 * Fire cleanup once now and then daily for the lifetime of the
 * process. .unref() so the interval doesn't keep the event loop alive
 * past SIGTERM. Idempotent — calling twice is a no-op past the first.
 *
 * For multi-replica deployments, prefer an out-of-process cron (only
 * one instance should run cleanup at a time). This in-process schedule
 * is fine for single-replica scaffolds.
 */
export function scheduleAuditLogCleanup(): void {
  if (timer) return;

  const tick = async (): Promise<void> => {
    try {
      const deleted = await cleanupExpiredAuditLogs();
      if (deleted > 0) {
        logger.info({ deleted }, "audit log cleanup ran");
      }
    } catch (err) {
      logger.error({ err }, "audit log cleanup failed");
    }
  };

  void tick();
  timer = setInterval(() => void tick(), 24 * 60 * 60 * 1000);
  timer.unref();
}

export function stopAuditLogCleanup(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

// Re-exported so tests can poke at the cutoff math without exporting
// the env-reading function on its own.
export { readRetentionDays as _readRetentionDays };

// Suppress the unused-eq import lint that would fire if we ever
// switched the WHERE off lt — keep the import resolution path stable.
void sql;
