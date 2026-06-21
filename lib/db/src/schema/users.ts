import { randomUUID } from "node:crypto";
import { boolean, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

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
  // Auto-push behavior for completed notes:
  //   "off"                  — manual Send to EHR (default)
  //   "after_approve"        — /notes/:id/approve pushes inline
  //   "after_transcription"  — the recording pipeline approves + pushes
  //                            as soon as the AI structured body lands.
  //                            The provider's review step is SKIPPED;
  //                            amend via the normal replaces chain.
  // Postgres-side this is just text — we narrow in TS so the call
  // sites pattern-match exhaustively. Stored as text rather than enum
  // because Drizzle's pg-enum support is finicky with renames; the
  // legibility win isn't worth the migration headache.
  autoPushMode: text("auto_push_mode")
    .$type<"off" | "after_approve" | "after_transcription">()
    .notNull()
    .default("off"),
  // Seconds of continuous silence before the recorder auto-stops. 0
  // disables the feature entirely (recorder only stops on manual tap).
  // Default 0 — the provider opts in via Settings rather than having
  // recordings cut off unexpectedly. Typical opt-in value is 45.
  silenceAutoStopSec: integer("silence_auto_stop_sec").notNull().default(0),
  // When true, /orders/:id/mark-export-ready fires the EHR push
  // inline so a non-medication order ships to the chart in one tap.
  // Push failure persists ehrError + leaves the order in
  // export_ready; the manual Send to EHR button can retry. Off by
  // default; medication orders are governed by a separate flag
  // (autoPushMedications) since they carry higher safety stakes.
  autoPushOrders: boolean("auto_push_orders").notNull().default(false),
  // Same semantics as autoPushOrders but specifically for orders
  // with orderType='medication'. Independent toggle on purpose:
  // a provider may want auto-push for labs and imaging but still
  // hand-confirm every script.
  autoPushMedications: boolean("auto_push_medications")
    .notNull()
    .default(false),
  // Mobile PWA hands-off mode: when an AI order suggestion lands and
  // this is true, non-medication suggestions auto-approve + auto-push
  // without provider review. Medications never auto-approve regardless
  // (patient-safety call — autoPushMedications is the orthogonal toggle
  // that governs auto-PUSH of approved meds, not auto-APPROVE of AI
  // suggestions). Off by default for desktop users; mobile init flips
  // it on the first /m visit so the doctor can record and walk away.
  autoApproveNonMedOrders: boolean("auto_approve_non_med_orders")
    .notNull()
    .default(false),
  // Set on first POST /m/initialize. Used as the one-shot guard so we
  // never re-flip the auto-push flags above on subsequent mobile
  // visits — once initialized, user edits to the flags are respected.
  mobileOnboardedAt: timestamp("mobile_onboarded_at", {
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
