import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import {
  getDb,
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
  const [row] = await getDb()
    .insert(sessionsTable)
    .values({ id, userId, expiresAt })
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
