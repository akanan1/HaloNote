import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import {
  getDb,
  organizationMembersTable,
  sessionsTable,
  usersTable,
  type Session,
  type User,
} from "@workspace/db";

function scrypt(
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// Reasonable scrypt cost. Node's default N for scryptSync is 2^14 (16384).
const SCRYPT_OPTS: ScryptOptions = { N: 16384, r: 8, p: 1 };

const SESSION_ID_BYTES = 32;
export const SESSION_COOKIE = "halonote_session";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionCookieMode = {
  sameSite: "lax" | "none";
  secure: boolean;
};

// Resolve SameSite/secure for our auth-related cookies (session + CSRF)
// from env. Defaults to lax (current behavior). Set
// SESSION_COOKIE_SAMESITE=none when the app is launched in a cross-site
// iframe (e.g. Cerner PowerChart SMART launch) — browsers require
// SameSite=None; Secure for cookies to ship into that iframe context.
//
// One env var controls both the session and CSRF cookies on purpose:
// they must always agree, or the iframe loads with a session but the
// first state-changing request fails CSRF.
export function resolveSessionCookieMode(): SessionCookieMode {
  const raw = process.env["SESSION_COOKIE_SAMESITE"]?.trim().toLowerCase();
  const isProd = process.env["NODE_ENV"] === "production";

  if (raw === undefined || raw === "" || raw === "lax") {
    return { sameSite: "lax", secure: isProd };
  }
  if (raw === "none") {
    // sameSite=none is meaningless without secure — browsers reject it.
    // Force secure=true regardless of NODE_ENV so the cookie actually
    // ships; local dev must run over HTTPS to use this mode.
    return { sameSite: "none", secure: true };
  }
  throw new Error(
    `Invalid SESSION_COOKIE_SAMESITE="${raw}" (expected "lax" or "none")`,
  );
}

// Call at startup. Throws if the cookie config is unsafe for the current
// environment so the process exits before serving any traffic.
export function validateSessionCookieConfig(): void {
  const mode = resolveSessionCookieMode();
  const isProd = process.env["NODE_ENV"] === "production";
  if (isProd && mode.sameSite === "none" && !mode.secure) {
    throw new Error(
      "SESSION_COOKIE_SAMESITE=none requires secure cookies in production",
    );
  }
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scrypt(plain, salt, KEY_LENGTH, SCRYPT_OPTS);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

export async function verifyPassword(
  plain: string,
  stored: string,
): Promise<boolean> {
  const idx = stored.indexOf(":");
  if (idx < 0) return false;
  const saltHex = stored.slice(0, idx);
  const keyHex = stored.slice(idx + 1);
  if (!saltHex || !keyHex) return false;

  let saltBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    saltBuf = Buffer.from(saltHex, "hex");
    expectedBuf = Buffer.from(keyHex, "hex");
  } catch {
    return false;
  }
  if (expectedBuf.length !== KEY_LENGTH) return false;

  const actualBuf = await scrypt(plain, saltBuf, KEY_LENGTH, SCRYPT_OPTS);

  // Constant-time compare to avoid leaking length / position via timing.
  return (
    actualBuf.length === expectedBuf.length &&
    timingSafeEqual(actualBuf, expectedBuf)
  );
}

export async function createSession(userId: string): Promise<Session> {
  const id = randomBytes(SESSION_ID_BYTES).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  // Resolve the user's active org at login time so PHI-routes have
  // tenant context without an extra round-trip per request. Picks the
  // user's oldest active membership — deterministic, and the common
  // case (one membership) makes it the user's only org. Multi-org
  // users can switch via PATCH /sessions/active-org (Phase 0c+).
  // Null is acceptable: a brand-new user with no memberships yet
  // signs in fine; PHI routes refuse with 409 until an org is set.
  const [membership] = await getDb()
    .select({ organizationId: organizationMembersTable.organizationId })
    .from(organizationMembersTable)
    .where(
      and(
        eq(organizationMembersTable.userId, userId),
        eq(organizationMembersTable.isActive, true),
      ),
    )
    .orderBy(organizationMembersTable.createdAt)
    .limit(1);
  const activeOrganizationId = membership?.organizationId ?? null;

  const [row] = await getDb()
    .insert(sessionsTable)
    .values({ id, userId, activeOrganizationId, expiresAt })
    .returning();
  if (!row) {
    throw new Error("Failed to create session");
  }
  return row;
}

export interface SessionLookup {
  session: Session;
  user: User;
}

export async function lookupSession(
  sessionId: string,
): Promise<SessionLookup | null> {
  const rows = await getDb()
    .select({ session: sessionsTable, user: usersTable })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
    .where(
      and(
        eq(sessionsTable.id, sessionId),
        gt(sessionsTable.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function destroySession(sessionId: string): Promise<void> {
  await getDb().delete(sessionsTable).where(eq(sessionsTable.id, sessionId));
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const rows = await getDb()
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, email.toLowerCase().trim()))
    .limit(1);
  return rows[0] ?? null;
}
