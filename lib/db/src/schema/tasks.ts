import { randomUUID } from "node:crypto";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { encountersTable } from "./encounters";
import { notesTable } from "./notes";
import { organizationsTable } from "./organizations";
import { patientsTable } from "./patients";
import { usersTable } from "./users";

// Categories from the spec's "Clinical Task Generation" section. Stored
// as text so adding new categories doesn't require a migration; narrowed
// in TS for the AI prompt's enum.
//
// Surfaced verbatim on the UI as a label badge ("📞 Call patient"); not
// used for state machine decisions.
export type TaskCategory =
  | "call_patient"
  | "schedule_followup"
  | "send_referral"
  | "prior_auth"
  | "obtain_records"
  | "repeat_labs"
  | "nursing_instruction"
  | "billing_followup"
  | "patient_instruction"
  | "other";

export type TaskStatus = "open" | "in_progress" | "completed" | "cancelled";
export type TaskPriority = "low" | "normal" | "high";
export type TaskSource = "ai" | "manual";

// One task = one piece of follow-up work tied to a patient. Unlike
// billing_suggestions / order_suggestions, there's no separate
// "suggested" table — tasks are operational items, not clinical
// decisions, so there's no audit need to separate AI-emitted from
// approved. The `source` field captures provenance instead.
//
// On AI generation: a task lands directly at status='open', assigned
// to the encounter's recording provider (the most defensible default).
// The provider can reassign, reschedule, or dismiss.
export const tasksTable = pgTable(
  "tasks",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => `tsk_${randomUUID()}`),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),

    // Tasks are always patient-bound. Encounter is optional because a
    // task can be created outside the encounter flow (manual add from
    // the patient chart, recurring labs, etc.).
    patientId: text("patient_id")
      .notNull()
      .references(() => patientsTable.id, { onDelete: "cascade" }),
    encounterId: text("encounter_id").references(() => encountersTable.id, {
      onDelete: "set null",
    }),
    // The note that triggered the task. Null on manual-add and on
    // tasks generated outside the AI flow.
    sourceNoteId: text("source_note_id").references(() => notesTable.id, {
      onDelete: "set null",
    }),

    category: text("category").$type<TaskCategory>().notNull().default("other"),
    title: text("title").notNull(),
    description: text("description"),

    // Optional due-by date. Used by the dashboard's "overdue" filter.
    // Stored as full timestamptz so cross-timezone teams sort correctly.
    dueAt: timestamp("due_at", { mode: "date", withTimezone: true }),

    // Assignee + creator. Both nullable for system tasks (cron-generated
    // reminders) and to survive a user being deleted; the route layer
    // requires assignedUserId to be non-null on creates that originate
    // from a request.
    assignedUserId: text("assigned_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdByUserId: text("created_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),

    status: text("status").$type<TaskStatus>().notNull().default("open"),
    priority: text("priority").$type<TaskPriority>().notNull().default("normal"),
    source: text("source").$type<TaskSource>().notNull().default("manual"),

    // The AI's rationale + verbatim excerpts when source='ai'. Both
    // null on manual tasks. Surfaced in the task detail view so the
    // provider can see why the AI suggested the task without grepping
    // the note themselves.
    rationale: text("rationale"),
    supportingExcerpts: jsonb("supporting_excerpts").notNull().default("[]"),

    completedAt: timestamp("completed_at", {
      mode: "date",
      withTimezone: true,
    }),
    completedByUserId: text("completed_by_user_id").references(
      () => usersTable.id,
      { onDelete: "set null" },
    ),
    // Set on cancel; captured so audit answers "why was this task dropped".
    cancellationReason: text("cancellation_reason"),
    // Set when a status transition happens — true when the task is
    // truly terminal so the dashboard can hide it from the active
    // queue without a status-based WHERE.
    isClosed: boolean("is_closed").notNull().default(false),

    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Hot path: "what's on my plate" — tasks assigned to a specific
    // user, filtered by closed/open, ordered by due date then creation.
    index("tasks_assignee_status_idx").on(
      t.assignedUserId,
      t.isClosed,
      t.dueAt,
    ),
    // Patient chart view: "all tasks for this patient".
    index("tasks_patient_idx").on(t.patientId, t.isClosed),
    // Org rollup: every open task across the clinic for the admin/
    // billing dashboard.
    index("tasks_org_open_idx").on(
      t.organizationId,
      t.isClosed,
      t.priority,
      t.dueAt,
    ),
  ],
);

export type Task = typeof tasksTable.$inferSelect;
export type NewTask = typeof tasksTable.$inferInsert;
