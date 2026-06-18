import { eq, inArray } from "drizzle-orm";
import {
  getDb,
  legalAcceptancesTable,
  organizationMembersTable,
  usersTable,
  type UserRole,
} from "@workspace/db";
import { hashPassword } from "./auth";
import { logger } from "./logger";
import { resolveAllRequiredDocuments } from "./legal-resolver";

// Default org installed by migration 0021. Demo accounts get dropped
// here so the seeded patient roster (also pinned to this org) shows
// up immediately on sign-in — without it the dev experience is "sign
// in, see an empty patient list, wonder why".
const DEMO_ORG_ID = "org_default";

// Deterministic, dev-only TOTP secret. Admin login enforces TOTP, so
// the seeded admin (alice) is pre-enrolled with this Base32 secret. Any
// authenticator app (Google Authenticator, 1Password, `oathtool`) can
// generate a current 6-digit code from it.
//
// `JBSWY3DPEHPK3PXP` is the canonical RFC 4226 test vector — published
// in countless examples — so we are NOT leaking real secret material by
// committing it. It will never be used outside of `NODE_ENV !==
// "production"` seeds (see the guard in seedUsersIfEmpty below).
const DEMO_ADMIN_TOTP_SECRET = "JBSWY3DPEHPK3PXP";

// Demo users idempotently re-seeded at every boot (in non-production).
// alice is seeded as an admin so the audit-log UI is reachable from at
// least one demo account; bob is a regular member.
const DEMO_USERS: Array<{
  id: string;
  email: string;
  displayName: string;
  password: string;
  role: UserRole;
  totpSecret?: string;
}> = [
  {
    id: "usr_demo_alice",
    email: "alice@halonote.example",
    displayName: "Dr. Alice Chen",
    password: "hunter2",
    role: "admin",
    // Admin login enforces TOTP — pre-enroll with the dev secret so
    // local sign-in still works. Code: any authenticator app pointed
    // at otpauth://totp/HaloNote:alice?secret=JBSWY3DPEHPK3PXP&issuer=HaloNote
    totpSecret: DEMO_ADMIN_TOTP_SECRET,
  },
  {
    id: "usr_demo_bob",
    email: "bob@halonote.example",
    displayName: "Dr. Bob Park",
    password: "hunter2",
    role: "member",
  },
];

/**
 * Ensure the demo users exist with the documented passwords + roles.
 * Idempotent — safe to call on every boot. Production deployments
 * should set NODE_ENV=production to suppress (real users don't want
 * a seeded alice@example backdoor in their prod DB).
 *
 * Naming kept for backwards compat with index.ts wiring; the
 * "IfEmpty" suffix is misleading now (the function used to bail on
 * a non-empty users table). Leaving for git-blame continuity.
 */
export async function seedUsersIfEmpty(): Promise<void> {
  if (process.env["NODE_ENV"] === "production") return;

  const db = getDb();
  const emails = DEMO_USERS.map((u) => u.email);
  const existing = await db
    .select({ email: usersTable.email })
    .from(usersTable)
    .where(inArray(usersTable.email, emails));
  const have = new Set(existing.map((r) => r.email));
  const missing = DEMO_USERS.filter((u) => !have.has(u.email));
  if (missing.length === 0) {
    // Already-present demo users keep their stored hashes. We don't
    // overwrite passwords here — if a developer changes them locally,
    // re-seeding shouldn't clobber that.
    return;
  }

  const now = new Date();
  const rows = await Promise.all(
    missing.map(async (u) => ({
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      passwordHash: await hashPassword(u.password),
      role: u.role,
      // Demo users skip the first-run onboarding wizard — they exist
      // for quick sign-in during dev/E2E, not to walk a real provider
      // through the flow.
      onboardingCompletedAt: now,
      // Pre-enroll TOTP for demo admins so they can clear the
      // admin-requires-TOTP login check without manual setup.
      ...(u.totpSecret
        ? { totpSecret: u.totpSecret, totpEnabledAt: now }
        : {}),
    })),
  );
  // ON CONFLICT DO NOTHING on email — two parallel boots seeding at once
  // are both fine with this. ID conflicts are also possible if a previous
  // run inserted alice with a different email; covered by the conflict.
  await db
    .insert(usersTable)
    .values(rows)
    .onConflictDoNothing({ target: usersTable.email });

  // Bootstrap the membership + legal acceptances that signup would
  // create for a real user. Without these, login resolves no active
  // org and requireBaa fails closed → demo accounts can't reach any
  // PHI route.
  await db
    .insert(organizationMembersTable)
    .values(
      missing.map((u) => ({
        organizationId: DEMO_ORG_ID,
        userId: u.id,
        role: (u.role === "admin" ? "admin" : "provider") as
          | "admin"
          | "provider",
        isActive: true,
        joinedAt: now,
      })),
    )
    .onConflictDoNothing();

  const documents = await resolveAllRequiredDocuments();
  await db
    .insert(legalAcceptancesTable)
    .values(
      missing.flatMap((u) =>
        documents.map((doc) => ({
          userId: u.id,
          documentType: doc.type,
          version: doc.currentVersion,
          contentHash: doc.contentHash,
        })),
      ),
    );

  logger.info(
    { count: rows.length, emails: missing.map((u) => u.email) },
    "Seeded missing demo accounts (password: hunter2)",
  );
}

/**
 * Test helper: nuke and re-seed the demo users. Resets hashes back to
 * the documented passwords. Use from E2E globalSetup, not production.
 */
export async function resetDemoUsersForTests(): Promise<void> {
  if (process.env["NODE_ENV"] === "production") {
    throw new Error("resetDemoUsersForTests called in production");
  }
  const db = getDb();
  const emails = DEMO_USERS.map((u) => u.email);
  await db.delete(usersTable).where(inArray(usersTable.email, emails));
  await seedUsersIfEmpty();
}

void eq;
