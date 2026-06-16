import type { RequestHandler } from "express";
import { auditLogTable, getDb } from "@workspace/db";
import { logger } from "../lib/logger";

/**
 * Logs an audit-log row for every request that reaches the protected
 * routes (mounted after requireAuth + requireCsrf). The write is
 * fire-and-forget — failure to persist is logged but doesn't fail the
 * underlying request, since the operator probably wants the response
 * to ship even if the bookkeeping DB hiccups. A production-grade
 * deployment may want sync writes or a write-behind queue with
 * durability guarantees, depending on compliance posture.
 *
 * Tests can `await waitForPendingAudits()` before truncating tables to
 * avoid racing the FK insert into users against a TRUNCATE on users.
 */

let pending = 0;
const flushed: Array<() => void> = [];

export function pendingAuditWrites(): number {
  return pending;
}

export function waitForPendingAudits(timeoutMs = 2000): Promise<void> {
  if (pending === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      logger.warn(
        { pending, timeoutMs },
        "waitForPendingAudits timed out",
      );
      resolve();
    }, timeoutMs);
    timer.unref();
    flushed.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function notifyIfDone(): void {
  if (pending === 0) {
    while (flushed.length) {
      const fn = flushed.shift();
      fn?.();
    }
  }
}

export const auditLog: RequestHandler = (req, res, next) => {
  // Capture intent before the route handler mutates anything.
  const action = inferAction(req.method, req.path);
  const resourceType = inferResourceType(req.path);
  const resourceId = inferResourceId(req.path);
  const userId = req.user?.id ?? null;
  // Tenant scope. Null is acceptable for authenticated requests that
  // haven't selected an org yet (fresh signup mid-flow) and for system
  // events (cron, seed). Routes that touch PHI gate on the org being
  // non-null via getActiveOrgId — so any audit row attached to a PHI
  // mutation already has a real org by the time we get here.
  const organizationId = req.activeOrganizationId ?? null;

  res.on("close", () => {
    // Only log meaningful outcomes — skip aborted requests with no status.
    if (!res.statusCode) return;

    pending++;
    getDb()
      .insert(auditLogTable)
      .values({
        organizationId,
        userId,
        action,
        resourceType,
        resourceId,
        metadata: { status: res.statusCode, method: req.method },
      })
      .catch((err: unknown) => {
        logger.warn(
          { err, action, resourceType, resourceId },
          "audit log write failed",
        );
      })
      .finally(() => {
        pending--;
        notifyIfDone();
      });
  });

  next();
};

const ACTION_BY_METHOD: Record<string, string> = {
  GET: "view",
  POST: "create",
  PATCH: "update",
  PUT: "update",
  DELETE: "delete",
};

function inferAction(method: string, path: string): string {
  const verb = ACTION_BY_METHOD[method.toUpperCase()] ?? method.toLowerCase();
  const resource = inferResourceType(path);
  const collection = isCollection(path);
  // list_patients reads better than view_patients for the index endpoint.
  if (verb === "view" && collection) return `list_${pluralize(resource)}`;
  // send_note_to_ehr — special-case the EHR push action.
  if (path.includes("/send-to-ehr")) return `send_${resource}_to_ehr`;
  return `${verb}_${resource}`;
}

function inferResourceType(path: string): string {
  // First non-empty segment after the API base. The router already
  // strips /api before reaching middleware.
  const first = path.split("/").filter(Boolean)[0] ?? "unknown";
  // /notes -> note; /patients -> patient
  return first.endsWith("s") ? first.slice(0, -1) : first;
}

function inferResourceId(path: string): string | null {
  // Path shapes we expect:
  //   /patients          -> null
  //   /patients/pt_x     -> pt_x
  //   /notes/note_x      -> note_x
  //   /notes/note_x/send-to-ehr -> note_x
  const parts = path.split("/").filter(Boolean);
  const id = parts[1];
  return id && id !== "send-to-ehr" ? id : null;
}

function isCollection(path: string): boolean {
  // Collection paths have exactly one segment after the /api base.
  return path.split("/").filter(Boolean).length === 1;
}

function pluralize(noun: string): string {
  return noun.endsWith("s") ? noun : `${noun}s`;
}
