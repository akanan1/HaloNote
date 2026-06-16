import { useMemo, useState } from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  Calendar,
  CheckCircle2,
  CircleDashed,
  ListChecks,
  Loader2,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

// ---------------------------------------------------------------------------
// Wire types — hand-typed against the routes/tasks.ts serializer. Will be
// codegen-replaced once OpenAPI catches up to Phase 4.
// ---------------------------------------------------------------------------

type TaskCategory =
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

type TaskStatus = "open" | "in_progress" | "completed" | "cancelled";
type TaskPriority = "low" | "normal" | "high";

interface Task {
  id: string;
  patientId: string;
  encounterId: string | null;
  category: TaskCategory;
  title: string;
  description: string | null;
  dueAt: string | null;
  assignedUserId: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  source: "ai" | "manual";
  rationale: string | null;
  cancellationReason: string | null;
  isClosed: boolean;
  createdAt: string;
  completedAt: string | null;
}

interface ListResponse {
  data: Task[];
}

// ---------------------------------------------------------------------------
// Presentation helpers
// ---------------------------------------------------------------------------

const CATEGORY_LABEL: Record<TaskCategory, string> = {
  call_patient: "Call patient",
  schedule_followup: "Schedule follow-up",
  send_referral: "Send referral",
  prior_auth: "Prior authorization",
  obtain_records: "Obtain records",
  repeat_labs: "Repeat labs",
  nursing_instruction: "Nursing instruction",
  billing_followup: "Billing follow-up",
  patient_instruction: "Patient instruction",
  other: "Other",
};

const PRIORITY_TONE: Record<TaskPriority, string> = {
  high: "ring-red-200 bg-red-50 text-red-900",
  normal: "ring-(--color-border) bg-(--color-muted) text-(--color-foreground)",
  low: "ring-(--color-border) bg-(--color-card) text-(--color-muted-foreground)",
};

function formatDue(iso: string | null): { label: string; tone: string } {
  if (!iso) return { label: "No due date", tone: "text-(--color-muted-foreground)" };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { label: iso, tone: "text-(--color-muted-foreground)" };
  const now = new Date();
  const diffDays = Math.round(
    (d.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
  );
  const dateStr = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year:
      d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
  if (diffDays < 0)
    return { label: `Overdue · ${dateStr}`, tone: "text-(--color-destructive)" };
  if (diffDays === 0) return { label: `Today · ${dateStr}`, tone: "text-amber-700" };
  if (diffDays === 1) return { label: `Tomorrow · ${dateStr}`, tone: "text-amber-700" };
  if (diffDays <= 7) return { label: `In ${diffDays} days · ${dateStr}`, tone: "text-(--color-foreground)" };
  return { label: dateStr, tone: "text-(--color-muted-foreground)" };
}

// ---------------------------------------------------------------------------
// API wrappers — thin customFetch calls with React Query keys.
// ---------------------------------------------------------------------------

const TASKS_KEY = ["tasks", "assigned-to-me"] as const;

async function fetchMyTasks(includeClosed: boolean): Promise<ListResponse> {
  const qs = new URLSearchParams({ assignedUserId: "me" });
  if (includeClosed) qs.set("includeClosed", "true");
  return customFetch<ListResponse>(`/api/tasks?${qs.toString()}`);
}

async function completeTask(id: string): Promise<Task> {
  return customFetch<Task>(`/api/tasks/${id}/complete`, { method: "POST" });
}

async function cancelTask(id: string, reason: string): Promise<Task> {
  return customFetch<Task>(`/api/tasks/${id}/cancel`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}

interface CreateTaskBody {
  patientId: string;
  title: string;
  description?: string;
  category?: TaskCategory;
  priority?: TaskPriority;
  dueAt?: string;
}

async function createTask(body: CreateTaskBody): Promise<Task> {
  return customFetch<Task>(`/api/tasks`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function TasksPage() {
  const qc = useQueryClient();
  const [includeClosed, setIncludeClosed] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const query = useQuery({
    queryKey: [...TASKS_KEY, { includeClosed }],
    queryFn: () => fetchMyTasks(includeClosed),
  });

  const tasks = useMemo(
    () => query.data?.data ?? [],
    [query.data],
  );

  // Cheap "X open, Y overdue" derived from the same list — no second
  // request. Counted from tasks the server already returned filtered
  // to this assignee.
  const counts = useMemo(() => {
    let open = 0;
    let overdue = 0;
    const now = Date.now();
    for (const t of tasks) {
      if (!t.isClosed) open += 1;
      if (!t.isClosed && t.dueAt && new Date(t.dueAt).getTime() < now) overdue += 1;
    }
    return { open, overdue };
  }, [tasks]);

  function refresh() {
    void query.refetch();
  }

  function invalidate() {
    void qc.invalidateQueries({ queryKey: TASKS_KEY });
  }

  async function handleComplete(t: Task) {
    setBusyId(t.id);
    try {
      await completeTask(t.id);
      toast.success("Task completed");
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't complete task");
    } finally {
      setBusyId(null);
    }
  }

  async function handleCancel(t: Task) {
    const reason = window.prompt(
      "Cancel this task — reason (kept for audit):",
      "",
    );
    if (!reason || !reason.trim()) return;
    setBusyId(t.id);
    try {
      await cancelTask(t.id, reason.trim());
      toast.success("Task cancelled");
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't cancel task");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight">Tasks</h1>
          <p className="text-(--color-muted-foreground)">
            {counts.open === 0
              ? "You're all caught up."
              : counts.overdue > 0
                ? `${counts.open} open · `
                : `${counts.open} open`}
            {counts.overdue > 0 ? (
              <span className="font-medium text-(--color-destructive)">
                {counts.overdue} overdue
              </span>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-(--color-muted-foreground)">
            <input
              type="checkbox"
              checked={includeClosed}
              onChange={(e) => setIncludeClosed(e.target.checked)}
            />
            Show closed
          </label>
          <Button
            variant="outline"
            size="sm"
            onClick={refresh}
            disabled={query.isFetching}
            aria-label="Refresh tasks"
          >
            <RefreshCw
              className={`h-4 w-4 ${query.isFetching ? "animate-spin" : ""}`}
              aria-hidden="true"
            />
          </Button>
          <Button size="sm" onClick={() => setCreateOpen((v) => !v)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            New task
          </Button>
        </div>
      </header>

      {createOpen ? (
        <CreateTaskPanel
          onCancel={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            invalidate();
          }}
        />
      ) : null}

      {query.isPending ? (
        <p role="status" className="text-(--color-muted-foreground)">
          Loading tasks…
        </p>
      ) : query.isError ? (
        <p role="alert" className="text-(--color-destructive)">
          Couldn't load tasks.{" "}
          {query.error instanceof Error ? query.error.message : ""}
        </p>
      ) : tasks.length === 0 ? (
        <Card className="p-10 text-center text-(--color-muted-foreground)">
          <ListChecks className="mx-auto mb-2 h-8 w-8" aria-hidden="true" />
          {includeClosed
            ? "No tasks yet — including closed."
            : "Nothing in your queue. Click New task to add one, or generate from an encounter."}
        </Card>
      ) : (
        <ul className="space-y-3" aria-label="My tasks">
          {tasks.map((t) => (
            <TaskRow
              key={t.id}
              task={t}
              busy={busyId === t.id}
              onComplete={() => void handleComplete(t)}
              onCancel={() => void handleCancel(t)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

function TaskRow({
  task,
  busy,
  onComplete,
  onCancel,
}: {
  task: Task;
  busy: boolean;
  onComplete: () => void;
  onCancel: () => void;
}) {
  const due = formatDue(task.dueAt);
  const closed = task.isClosed;
  return (
    <li>
      <Card
        className={`relative overflow-hidden transition-colors ${
          closed ? "opacity-60" : "hover:bg-(--color-muted)/40"
        }`}
      >
        <div className="flex flex-wrap items-start gap-4 px-5 py-4">
          <div className="mt-1">
            {closed ? (
              <CheckCircle2
                className="h-5 w-5 text-emerald-600"
                aria-hidden="true"
              />
            ) : (
              <CircleDashed
                className="h-5 w-5 text-(--color-muted-foreground)"
                aria-hidden="true"
              />
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${PRIORITY_TONE[task.priority]}`}
              >
                {CATEGORY_LABEL[task.category]}
              </span>
              {task.priority === "high" ? (
                <span className="text-xs font-medium uppercase tracking-wide text-red-700">
                  High
                </span>
              ) : null}
              {task.source === "ai" ? (
                <span className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
                  AI-suggested
                </span>
              ) : null}
            </div>
            <div className="text-base font-medium leading-snug">
              {task.title}
            </div>
            {task.description ? (
              <p className="text-sm text-(--color-muted-foreground)">
                {task.description}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className={`inline-flex items-center gap-1 ${due.tone}`}>
                <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
                {due.label}
              </span>
              {closed && task.completedAt ? (
                <span className="text-(--color-muted-foreground)">
                  Completed {formatDue(task.completedAt).label}
                </span>
              ) : null}
              {closed && task.cancellationReason ? (
                <span className="text-(--color-muted-foreground)">
                  Cancelled: {task.cancellationReason}
                </span>
              ) : null}
            </div>
          </div>
          {!closed ? (
            <div className="flex shrink-0 items-center gap-2">
              {busy ? (
                <Loader2
                  className="h-4 w-4 animate-spin text-(--color-muted-foreground)"
                  aria-hidden="true"
                />
              ) : null}
              <Button size="sm" onClick={onComplete} disabled={busy}>
                <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                Done
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={onCancel}
                disabled={busy}
                aria-label="Cancel task"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          ) : null}
        </div>
      </Card>
    </li>
  );
}

// Inline create panel. Patient is required (server-enforced); a future
// polish pass should swap the text input for a patient picker hooked
// into /api/patients.
function CreateTaskPanel({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [patientId, setPatientId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<TaskCategory>("other");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [dueAt, setDueAt] = useState("");

  const create = useMutation({
    mutationFn: (body: CreateTaskBody) => createTask(body),
    onSuccess: () => {
      toast.success("Task created");
      onCreated();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Couldn't create task"),
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!patientId.trim() || !title.trim()) return;
    const body: CreateTaskBody = {
      patientId: patientId.trim(),
      title: title.trim(),
      category,
      priority,
    };
    if (description.trim()) body.description = description.trim();
    // dueAt comes from <input type="date"> — convert to ISO midnight UTC
    // so the server stores a timezone-safe timestamp.
    if (dueAt) body.dueAt = new Date(`${dueAt}T12:00:00Z`).toISOString();
    create.mutate(body);
  }

  return (
    <Card className="space-y-4 p-5">
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="task-patient">Patient ID</Label>
            <Input
              id="task-patient"
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
              placeholder="pt_…"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-title">Title</Label>
            <Input
              id="task-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Call patient with lab results"
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-category">Category</Label>
            <select
              id="task-category"
              value={category}
              onChange={(e) => setCategory(e.target.value as TaskCategory)}
              className="block h-9 w-full rounded-md border border-(--color-border) bg-(--color-card) px-2 text-sm"
            >
              {(Object.keys(CATEGORY_LABEL) as TaskCategory[]).map((c) => (
                <option key={c} value={c}>
                  {CATEGORY_LABEL[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-priority">Priority</Label>
            <select
              id="task-priority"
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority)}
              className="block h-9 w-full rounded-md border border-(--color-border) bg-(--color-card) px-2 text-sm"
            >
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-due">Due date</Label>
            <Input
              id="task-due"
              type="date"
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label htmlFor="task-desc">Description (optional)</Label>
            <Textarea
              id="task-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : null}
            Create task
          </Button>
        </div>
      </form>
    </Card>
  );
}
