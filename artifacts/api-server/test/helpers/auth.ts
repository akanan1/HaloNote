import { TOTP, Secret } from "otpauth";
import { getDb, usersTable, type User, type UserRole } from "@workspace/db";
import { hashPassword } from "../../src/lib/auth";

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
  return user;
}
