import { index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { patientsTable } from "./patients";
import { usersTable } from "./users";

// Server-side claim that a provider is working on a note for a given
// appointment. Replaces the localStorage-only mechanism shipped in
// the Wave 1 interim — moving it server-side fixes three things:
//
//   1. Cross-device consistency. A provider who claims an appointment
//      on their iPad sees it as claimed on their desktop.
//   2. Server-enforced TTL. The interim's 7-day client check could be
//      bypassed by clock tampering; expires_at is now authoritative.
//   3. No PHI-adjacent data on shared clinic devices. localStorage is
//      cleared on logout (Wave 1 interim) but the FK to patients is
//      what motivated the move — anything tying an appointment_id to
//      a patient_id should live behind auth.
//
// The composite primary key (organization_id, appointment_id) means
// only one claim exists per appointment within an org — the second
// provider clicking "start note" replaces the first (last-write-wins;
// see routes/appointment-claims.ts for the UPSERT). If we ever need
// "multiple providers shadowing the same appointment", split the PK
// into (org, appointment, user) and add a uniqueness check at the
// route layer instead.
export const appointmentClaimsTable = pgTable(
  "appointment_claims",
  {
    // Tenant scope. Cascades on org delete so a closed clinic's claims
    // disappear with the org row (claims are ephemeral state, not audit).
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    // The EHR-side appointment identifier the provider clicked into.
    // Free-form text — the actual format depends on the EHR provider
    // (Athena uses numeric, Epic uses prefixed strings). We don't FK
    // because appointments live in the EHR, not our DB.
    appointmentId: text("appointment_id").notNull(),
    // The provider doing the work. Cascades on user delete — claims
    // are ephemeral; a departed user shouldn't keep an active claim.
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    // Internal HaloNote patient id the provider correlated to this
    // appointment. The Today view uses this to thread the right note
    // back to the schedule row when the provider finishes a recording.
    // Cascades on patient delete (rare; usually soft-delete via status).
    patientId: text("patient_id")
      .notNull()
      .references(() => patientsTable.id, { onDelete: "cascade" }),
    claimedAt: timestamp("claimed_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    // Server-enforced TTL. Routes filter `expiresAt > NOW()` on read.
    // 7 days default matches the prior localStorage cap; the route
    // layer is the only place this value gets set.
    expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true })
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.organizationId, t.appointmentId] }),
    // Fast "my claims" lookup for the Today view.
    index("appointment_claims_user_idx").on(t.organizationId, t.userId),
  ],
);

export type AppointmentClaim = typeof appointmentClaimsTable.$inferSelect;
export type NewAppointmentClaim = typeof appointmentClaimsTable.$inferInsert;
