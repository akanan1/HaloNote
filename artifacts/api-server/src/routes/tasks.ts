import { Router, type IRouter } from "express";
import { and, asc, desc, eq, isNull, lte } from "drizzle-orm";
import { z } from "@workspace/api-zod";
import {
  encountersTable,
  getDb,
  notesTable,
  patientsTable,
  tasksTable,
  type Task,
  type TaskCategory,
  type TaskPriority,
  type TaskStatus,
} from "@workspace/db";
import { generateTasks } from "../lib/task-generator";
import { getActiveOrgId } from "../lib/active-org";

const router: IRouter = Router();

const CATEGORIES = [
  "call_patient",
  "schedule_followup",
  "send_referral",
  "prior_auth",
  "obtain_records",
  "repeat_labs",
  "nursing_instruction",
  "billing_followup",
  "patient_instruction",
  "other",
] as const satisfies readonly TaskCategory[];

const PRIORITIES = ["low", "normal", "high"] as const satisfies readonly TaskPriority[];

// A task's status closes the task when it hits a terminal state. Keeping
// isClosed in sync with status here (and not via a CHECK constraint)
// because the rule is application-level — the dashboard's hot path
// filters on isClosed, not status, so the column stays denormalized
// for query speed.
function closedForStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "cancelled";
}

function serialize(row: Task) {
  return {
    id: row.id,
    organizationId: row.organizationId,
    patientId: row.patientId,
    encounterId: row.encounterId,
    sourceNoteId: row.sourceNoteId,
    category: row.category,
    title: row.title,
    description: row.description,
    dueAt: row.dueAt?.toISOString() ?? null,
    assignedUserId: row.assignedUserId,
    createdByUserId: row.createdByUserId,
    status: row.status,
    priority: row.priority,
    source: row.source,
    rationale: row.rationale,
    supportingExcerpts: row.supportingExcerpts,
    completedAt: row.completedAt?.toISOString() ?? null,
    completedByUserId: row.completedByUserId,
    cancellationReason: row.cancellationReason,
    isClosed: row.isClosed,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// POST /encounters/:id/tasks/generate — run the AI generator and persist the
// tasks. Default assignee is the encounter's provider; due dates resolve
// from dueOffsetDays.
// ---------------------------------------------------------------------------
router.post("/encounters/:id/tasks/generate", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const encounterId = req.params.id;
  const db = getDb();

  const [encounter] = await db
    .select()
    .from(encountersTable)
    .where(
      and(
        eq(encountersTable.id, encounterId),
        eq(encountersTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!encounter) {
    res.status(404).json({ error: "encounter_not_found" });
    return;
  }

  const [note] = await db
    .select({ id: notesTable.id, body: notesTable.body })
    .from(notesTable)
    .where(
      and(
        eq(notesTable.encounterId, encounterId),
        eq(notesTable.organizationId, orgId),
      ),
    )
    .orderBy(desc(notesTable.updatedAt))
    .limit(1);
  if (!note) {
    res.status(409).json({ error: "no_note_to_generate_from" });
    return;
  }

  const { result, source } = await generateTasks({
    encounter: {
      id: encounter.id,
      visitType: encounter.visitType,
      customLabel: encounter.customLabel,
      scheduledAt: encounter.scheduledAt,
    },
    noteBody: note.body,
  });

  if (result.tasks.length === 0) {
    res.json({ data: [], source });
    return;
  }

  // Resolve due dates from the encounter's anchor timestamp. Prefer
  // startedAt → scheduledAt → now; this lets the tasks land at sensible
  // dates regardless of when the generator runs.
  const anchor =
    encounter.startedAt ?? encounter.scheduledAt ?? new Date();

  // Default assignee: the encounter's provider. Null if the encounter
  // doesn't have one yet (rare — happens on MA-pre-created encounters
  // where the provider hasn't been set).
  const defaultAssignee = encounter.providerId ?? req.user?.id ?? null;

  try {
    const inserted = await db
      .insert(tasksTable)
      .values(
        result.tasks.map((t) => ({
          organizationId: orgId,
          patientId: encounter.patientId,
          encounterId: encounter.id,
          sourceNoteId: note.id,
          category: t.category,
          title: t.title,
          description: t.description ?? null,
          dueAt:
            typeof t.dueOffsetDays === "number"
              ? new Date(anchor.getTime() + t.dueOffsetDays * 86400_000)
              : null,
          assignedUserId: defaultAssignee,
          createdByUserId: req.user?.id ?? null,
          priority: t.priority,
          source: "ai" as const,
          rationale: t.rationale,
          supportingExcerpts: t.supportingExcerpts,
        })),
      )
      .returning();
    res.status(201).json({ data: inserted.map(serialize), source });
  } catch (err) {
    req.log.error({ err, encounterId }, "Failed to persist generated tasks");
    res.status(500).json({ error: "persistence_failed" });
  }
});

// ---------------------------------------------------------------------------
// GET /tasks — list with filters. Default: open tasks assigned to caller,
// soonest due first. Filters: status, assignedUserId (use "me" shorthand),
// patientId, includeClosed, overdueOnly.
// ---------------------------------------------------------------------------
router.get("/tasks", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const db = getDb();
  const caller = req.user;

  const status = typeof req.query["status"] === "string" ? req.query["status"] : undefined;
  const assignedRaw =
    typeof req.query["assignedUserId"] === "string"
      ? req.query["assignedUserId"]
      : undefined;
  const assignedUserId =
    assignedRaw === "me" ? caller?.id : assignedRaw;
  const patientId =
    typeof req.query["patientId"] === "string" ? req.query["patientId"] : undefined;
  const includeClosed = req.query["includeClosed"] === "true";
  const overdueOnly = req.query["overdueOnly"] === "true";

  const conditions = [eq(tasksTable.organizationId, orgId)];
  if (status) conditions.push(eq(tasksTable.status, status as TaskStatus));
  if (assignedUserId) conditions.push(eq(tasksTable.assignedUserId, assignedUserId));
  if (patientId) conditions.push(eq(tasksTable.patientId, patientId));
  if (!includeClosed) conditions.push(eq(tasksTable.isClosed, false));
  if (overdueOnly) conditions.push(lte(tasksTable.dueAt, new Date()));

  const rows = await db
    .select()
    .from(tasksTable)
    .where(and(...conditions))
    .orderBy(
      // NULL dueAt sorts after non-null when ASC; pgsql defaults are
      // NULLS LAST in ASC. Pair with priority so high-priority work
      // floats up among same-day items.
      asc(tasksTable.dueAt),
      desc(tasksTable.priority),
      desc(tasksTable.createdAt),
    )
    .limit(500);
  res.json({ data: rows.map(serialize) });
});

router.get("/tasks/:id", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const [row] = await getDb()
    .select()
    .from(tasksTable)
    .where(
      and(
        eq(tasksTable.id, req.params.id),
        eq(tasksTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!row) {
    res.status(404).json({ error: "task_not_found" });
    return;
  }
  res.json(serialize(row));
});

// ---------------------------------------------------------------------------
// POST /tasks — manual create.
// ---------------------------------------------------------------------------
const CreateTaskBody = z.object({
  patientId: z.string().min(1),
  encounterId: z.string().min(1).optional(),
  category: z.enum(CATEGORIES).optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  dueAt: z.iso.datetime().optional(),
  assignedUserId: z.string().min(1).optional(),
  priority: z.enum(PRIORITIES).optional(),
});

router.post("/tasks", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = CreateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }
  const db = getDb();

  // Tenant-scope the patient. Encounter (if supplied) must belong to
  // the same patient — otherwise the chart view would show the task on
  // the wrong record.
  const [patient] = await db
    .select({ id: patientsTable.id })
    .from(patientsTable)
    .where(
      and(
        eq(patientsTable.id, parsed.data.patientId),
        eq(patientsTable.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!patient) {
    res.status(404).json({ error: "patient_not_found" });
    return;
  }
  if (parsed.data.encounterId) {
    const [enc] = await db
      .select({ id: encountersTable.id, patientId: encountersTable.patientId })
      .from(encountersTable)
      .where(
        and(
          eq(encountersTable.id, parsed.data.encounterId),
          eq(encountersTable.organizationId, orgId),
        ),
      )
      .limit(1);
    if (!enc || enc.patientId !== parsed.data.patientId) {
      res.status(400).json({ error: "encounter_patient_mismatch" });
      return;
    }
  }

  try {
    const [inserted] = await db
      .insert(tasksTable)
      .values({
        organizationId: orgId,
        patientId: parsed.data.patientId,
        encounterId: parsed.data.encounterId ?? null,
        category: parsed.data.category ?? "other",
        title: parsed.data.title,
        description: parsed.data.description ?? null,
        dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : null,
        assignedUserId: parsed.data.assignedUserId ?? req.user?.id ?? null,
        createdByUserId: req.user?.id ?? null,
        priority: parsed.data.priority ?? "normal",
        source: "manual",
      })
      .returning();
    if (!inserted) throw new Error("Insert returned no row");
    res.status(201).json(serialize(inserted));
  } catch (err) {
    req.log.error({ err }, "Failed to create task");
    res.status(500).json({ error: "persistence_failed" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /tasks/:id — edit. Status transitions go through the dedicated
// complete/cancel endpoints so the side-effect bookkeeping (completedAt
// stamp, isClosed flip) is consolidated.
// ---------------------------------------------------------------------------
const UpdateTaskBody = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  category: z.enum(CATEGORIES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  dueAt: z.iso.datetime().nullable().optional(),
  assignedUserId: z.string().min(1).nullable().optional(),
  // status: z.enum(["open", "in_progress"]).optional(),
  status: z.enum(["open", "in_progress"]).optional(),
});

router.patch("/tasks/:id", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = UpdateTaskBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }
  const id = req.params.id;
  const db = getDb();

  const [existing] = await db
    .select({ id: tasksTable.id, isClosed: tasksTable.isClosed })
    .from(tasksTable)
    .where(
      and(eq(tasksTable.id, id), eq(tasksTable.organizationId, orgId)),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "task_not_found" });
    return;
  }
  if (existing.isClosed) {
    res.status(409).json({ error: "task_closed" });
    return;
  }

  const updates: Partial<typeof tasksTable.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (parsed.data.title !== undefined) updates.title = parsed.data.title;
  if (parsed.data.description !== undefined)
    updates.description = parsed.data.description;
  if (parsed.data.category !== undefined) updates.category = parsed.data.category;
  if (parsed.data.priority !== undefined) updates.priority = parsed.data.priority;
  if (parsed.data.dueAt !== undefined)
    updates.dueAt = parsed.data.dueAt ? new Date(parsed.data.dueAt) : null;
  if (parsed.data.assignedUserId !== undefined)
    updates.assignedUserId = parsed.data.assignedUserId;
  if (parsed.data.status !== undefined) updates.status = parsed.data.status;

  const [updated] = await db
    .update(tasksTable)
    .set(updates)
    .where(
      and(eq(tasksTable.id, id), eq(tasksTable.organizationId, orgId)),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "task_not_found" });
    return;
  }
  res.json(serialize(updated));
});

// ---------------------------------------------------------------------------
// POST /tasks/:id/complete — terminal close, stamps completedAt + flips
// isClosed. Re-completing is idempotent.
// ---------------------------------------------------------------------------
router.post("/tasks/:id/complete", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const completer = req.user;
  if (!completer) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const id = req.params.id;
  const db = getDb();

  const [existing] = await db
    .select({ id: tasksTable.id, status: tasksTable.status })
    .from(tasksTable)
    .where(
      and(eq(tasksTable.id, id), eq(tasksTable.organizationId, orgId)),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "task_not_found" });
    return;
  }
  if (existing.status === "cancelled") {
    res.status(409).json({ error: "task_cancelled" });
    return;
  }
  if (existing.status === "completed") {
    // Idempotent — return current state.
    const [row] = await db
      .select()
      .from(tasksTable)
      .where(
        and(eq(tasksTable.id, id), eq(tasksTable.organizationId, orgId)),
      )
      .limit(1);
    if (!row) throw new Error("Task vanished during idempotent re-complete");
    res.json(serialize(row));
    return;
  }

  const [updated] = await db
    .update(tasksTable)
    .set({
      status: "completed",
      isClosed: closedForStatus("completed"),
      completedAt: new Date(),
      completedByUserId: completer.id,
      updatedAt: new Date(),
    })
    .where(
      and(eq(tasksTable.id, id), eq(tasksTable.organizationId, orgId)),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "task_not_found" });
    return;
  }
  res.json(serialize(updated));
});

// ---------------------------------------------------------------------------
// POST /tasks/:id/cancel — withdraw the task with a reason captured.
// ---------------------------------------------------------------------------
const CancelBody = z.object({ reason: z.string().min(1).max(500) });

router.post("/tasks/:id/cancel", async (req, res) => {
  const orgId = getActiveOrgId(req, res);
  if (!orgId) return;
  const parsed = CancelBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
    return;
  }
  const id = req.params.id;
  const db = getDb();

  const [existing] = await db
    .select({ id: tasksTable.id, status: tasksTable.status })
    .from(tasksTable)
    .where(
      and(eq(tasksTable.id, id), eq(tasksTable.organizationId, orgId)),
    )
    .limit(1);
  if (!existing) {
    res.status(404).json({ error: "task_not_found" });
    return;
  }
  if (existing.status === "completed") {
    res.status(409).json({ error: "task_already_completed" });
    return;
  }
  if (existing.status === "cancelled") {
    res.status(409).json({ error: "already_cancelled" });
    return;
  }

  const [updated] = await db
    .update(tasksTable)
    .set({
      status: "cancelled",
      isClosed: closedForStatus("cancelled"),
      cancellationReason: parsed.data.reason,
      updatedAt: new Date(),
    })
    .where(
      and(eq(tasksTable.id, id), eq(tasksTable.organizationId, orgId)),
    )
    .returning();
  if (!updated) {
    res.status(404).json({ error: "task_not_found" });
    return;
  }
  res.json(serialize(updated));
});

// Avoid unused-import lint when this gets used downstream.
void isNull;

export default router;
