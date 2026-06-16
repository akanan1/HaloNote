import { randomUUID } from "node:crypto";
import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
  // Distilled, non-PHI description of *how* this provider writes their
  // notes — section ordering preferences, abbreviation patterns,
  // sentence register, level of detail. NOT patient content. Generated
  // by an LLM pass over the provider's own recent notes with explicit
  // instructions to omit PHI; refreshed asynchronously after each
  // successful recording so it tracks how the provider's voice
  // evolves. Used as a cached prompt block in the recording pipeline
  // so newly generated notes mirror the provider's house style.
  writingStyleProfile: text("writing_style_profile"),
  // When `writingStyleProfile` was last regenerated. Null until the
  // first profile is computed. Pipeline uses this to decide whether
  // to schedule a background refresh.
  writingStyleUpdatedAt: timestamp("writing_style_updated_at", {
    mode: "date",
    withTimezone: true,
  }),
  // When the user finished the first-run onboarding flow (or skipped
  // it). Null routes them to /onboarding on next sign-in; non-null
  // means they've seen it and don't get redirected. Backfilled to the
  // signup time for existing accounts so the redirect doesn't fire
  // for users who never had the flow.
  onboardingCompletedAt: timestamp("onboarding_completed_at", {
    mode: "date",
    withTimezone: true,
  }),
  // Founder-tier access flag. A super-admin permission on top of the
  // existing admin/member role — gates the cross-tenant Founder
  // dashboard (analytics, per-user legal acceptance status, etc.).
  // Defaults to false; granted manually via SQL or a future admin UI
  // for the HaloNote team only. Distinct from `role` so we can
  // promote a non-admin member to founder access (or vice versa)
  // without losing the existing role semantics.
  isFounder: boolean("is_founder").notNull().default(false),
  // Founder-set "you must re-accept the agreements" timestamp. Any
  // legal acceptance row older than this is treated as stale by both
  // the GET /legal/agreements status check and the requireBaa gate,
  // so the next login bounces the user back into the agreements
  // step of onboarding. The original acceptance row stays on file
  // for the audit trail; this column only changes which row counts
  // as "current". Nullable — null means no forced invalidation.
  legalReacceptRequiredAt: timestamp("legal_reaccept_required_at", {
    mode: "date",
    withTimezone: true,
  }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type User = typeof usersTable.$inferSelect;
export type NewUser = typeof usersTable.$inferInsert;
