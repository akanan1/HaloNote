import { TOTP, Secret } from "otpauth";
import {
  getDb,
  legalAcceptancesTable,
  organizationMembersTable,
  usersTable,
  type User,
  type UserRole,
} from "@workspace/db";
import { hashPassword } from "../../src/lib/auth";
import { resolveCurrentDocument } from "../../src/lib/legal-resolver";

// Default org seeded by migration 0021. Every freshly-created test
// user is bootstrapped into this org so login picks up an active
// org_id (without it `getActiveOrgId` 409s every tenant-scoped route)
// — opt out with skipOrgBootstrap when the test specifically targets
// the no-org code path.
const DEFAULT_TEST_ORG_ID = "org_default";

/**
 * Deterministic TOTP secret used to pre-enroll admin test users so they
 * can clear the "admins must have TOTP" login enforcement. This is the
 * canonical RFC 4226 test vector — not a real secret. Tests that need
 * to log in as an admin must include `currentTotpCode(...)` in the
 * login body.
 */
export const TEST_ADMIN_TOTP_SECRET = "JBSWY3DPEHPK3PXP";

export function currentTotpCode(secretBase32: string): string {
  return new TOTP({
    issuer: "HaloNote",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  }).generate();
}

export interface TestUserInput {
  id?: string;
  email: string;
  password: string;
  displayName: string;
  role?: UserRole;
  /**
   * Override the auto-enroll-TOTP-for-admin behavior. Set false to
   * create an admin row without TOTP — useful for asserting the
   * "admins must have TOTP" guard rejects them.
   */
  enrollTotp?: boolean;
  /**
   * Skip the default-org membership bootstrap. Set true for tests
   * that explicitly target the "user has no active org" code path
   * (e.g. asserting tenant-scoped routes 409 in that state).
   */
  skipOrgBootstrap?: boolean;
  /**
   * Skip the BAA acceptance bootstrap. Set true for tests that
   * specifically target the unaccepted-BAA path (the onboarding
   * flow test does this — it asserts PHI routes 403 until the
   * BAA acceptance lands).
   */
  skipBaaAcceptance?: boolean;
}

export async function createTestUser(input: TestUserInput): Promise<User> {
  const passwordHash = await hashPassword(input.password);
  // Admins must have TOTP enrolled (auth.ts login enforcement). Default
  // to auto-enrolling with the fixed dev secret so existing tests keep
  // working — tests that specifically want a no-TOTP admin can opt out
  // via `enrollTotp: false`.
  const shouldEnrollTotp =
    input.enrollTotp ??
    (input.role === "admin");
  const totpFields = shouldEnrollTotp
    ? { totpSecret: TEST_ADMIN_TOTP_SECRET, totpEnabledAt: new Date() }
    : {};
  const values = {
    email: input.email,
    displayName: input.displayName,
    passwordHash,
    ...(input.role ? { role: input.role } : {}),
    ...(input.id ? { id: input.id } : {}),
    ...totpFields,
  };
  const [user] = await getDb().insert(usersTable).values(values).returning();
  if (!user) throw new Error("Failed to create test user");

  // Membership bootstrap: every test user gets dropped into
  // org_default so login resolves an active_organization_id. The
  // role mapping mirrors what migration 0021 does — admins land as
  // org admins, members as org providers. clinical_read_granted
  // stays false so the principle of least privilege still holds in
  // tests that exercise role gating.
  if (!input.skipOrgBootstrap) {
    await getDb()
      .insert(organizationMembersTable)
      .values({
        organizationId: DEFAULT_TEST_ORG_ID,
        userId: user.id,
        role: input.role === "admin" ? "admin" : "provider",
        isActive: true,
        joinedAt: new Date(),
      })
      .onConflictDoNothing();
  }

  // BAA acceptance: pin the user to the current BAA version so
  // requireBaa lets them through. Tests that want to exercise the
  // unaccepted-BAA path opt out via skipBaaAcceptance.
  if (!input.skipBaaAcceptance) {
    const currentBaa = await resolveCurrentDocument("baa");
    await getDb()
      .insert(legalAcceptancesTable)
      .values({
        userId: user.id,
        documentType: "baa",
        version: currentBaa.currentVersion,
        contentHash: currentBaa.contentHash,
        // ipAddress + userAgent are nullable; left unset here since
        // a fixture write doesn't have a request to attribute.
      });
  }

  return user;
}
