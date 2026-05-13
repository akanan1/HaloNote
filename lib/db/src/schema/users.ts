import { randomUUID } from "node:crypto";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export type UserRole = "admin" | "member";

export const usersTable = pgTable("users", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => `usr_${randomUUID()}`),
  email: text("email").notNull().unique(),
  // scrypt output: `<saltHex>:<keyHex>`. See api-server/src/lib/auth.ts.
  passwordHash: text("password_hash").notNull(),
  displayName: text("display_name").notNull(),
  // Application-level role. "admin" can view the audit log and other
  // compliance surfaces; "member" is the default and what signup creates.
  // Postgres-side this is just text — we narrow in TS so the API layer
  // can pattern-match exhaustively, but the DB will accept anything.
  role: text("role").$type<UserRole>().notNull().default("member"),
  // TOTP secret in Base32 (RFC 4648). Nullable — only set after the
  // user has confirmed a setup code matches. Stored at rest; rotate
  // to encrypted-at-rest before enforcing 2FA org-wide.
  totpSecret: text("totp_secret"),
  // When the user finished 2FA enrollment. Nullable until enrolled.
  // Login requires a fresh TOTP code whenever this is non-null.
  totpEnabledAt: timestamp("totp_enabled_at", {
    mode: "date",
    withTimezone: true,
  }),
  // Provider's identity in the EHR (e.g. Athena Practitioner.id). Used
  // to scope schedule queries to "this user's appointments today".
  // Manually provisioned in Phase 1; will be set automatically when
  // the OAuth-on-web flow ships (Phase 3).
  ehrPractitionerId: text("ehr_practitioner_id"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type User = typeof usersTable.$inferSelect;
export type NewUser = typeof usersTable.$inferInsert;
