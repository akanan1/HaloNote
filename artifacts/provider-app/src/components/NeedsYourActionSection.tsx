import { useMemo } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  ChevronRight,
  FileText,
  ListChecks,
} from "lucide-react";
import {
  getListNotesQueryKey,
  useListNotes,
  type Note,
} from "@workspace/api-client-react";
import { customFetch } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";

// ---------------------------------------------------------------------------
// Wire types for the tasks bucket (hand-mirrored; tasks routes aren't in
// OpenAPI yet — Phase 10 swap covers encounters only).
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

interface Task {
  id: string;
  patientId: string;
  encounterId: string | null;
  category: TaskCategory;
  title: string;
  description: string | null;
  dueAt: string | null;
  priority: "low" | "normal" | "high";
  status: "open" | "in_progress" | "completed" | "cancelled";
  isClosed: boolean;
}

interface TaskListResponse {
  data: Task[];
}

const CATEGORY_LABEL: Record<TaskCategory, string> = {
  call_patient: "Call patient",
  schedule_followup: "Schedule follow-up",
  send_referral: "Send referral",
  prior_auth: "Prior auth",
  obtain_records: "Obtain records",
  repeat_labs: "Repeat labs",
  nursing_instruction: "Nursing instruction",
  billing_followup: "Billing follow-up",
  patient_instruction: "Patient instruction",
  other: "Other",
};

async function fetchMyOpenTasks(): Promise<TaskListResponse> {
  return customFetch<TaskListResponse>(
    "/api/tasks?assignedUserId=me&includeClosed=false",
  );
}

// Inputs to the date-sort math. Local-time start-of-tomorrow is more
// useful than UTC midnight here — providers care about "due today"
// in their own time zone.
function startOfTomorrow(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d;
}

// ---------------------------------------------------------------------------
// Section component
// ---------------------------------------------------------------------------

export function NeedsYourActionSection() {
  // Drafts authored by me, newest first. Limited to a small handful so
  // the widget stays scannable; the link below jumps to a deeper view
  // (Patients list filtered by recent activity) if the count is large.
  const draftsParams = {
    status: "draft" as const,
    authorId: "me" as const,
    limit: 5,
  };
  const draftsQuery = useListNotes(draftsParams, {
    query: { queryKey: getListNotesQueryKey(draftsParams) },
  });

  const tasksQuery = useQuery({
    queryKey: ["my-open-tasks"],
    queryFn: () => fetchMyOpenTasks(),
  });

  const drafts: Note[] = useMemo(
    () => draftsQuery.data?.data ?? [],
    [draftsQuery.data],
  );
  const tasks = useMemo(
    () => tasksQuery.data?.data ?? [],
    [tasksQuery.data],
  );

  const tomorrow = startOfTomorrow();
  const now = Date.now();

  const overdue = useMemo(
    () =>
      tasks
        .filter(
          (t) => t.dueAt && new Date(t.dueAt).getTime() < now,
        )
        .slice(0, 3),
    [tasks, now],
  );

  const dueToday = useMemo(
    () =>
      tasks
        .filter((t) => {
          if (!t.dueAt) return false;
          const due = new Date(t.dueAt).getTime();
          return due >= now && due < tomorrow.getTime();
        })
        .slice(0, 3),
    [tasks, now, tomorrow],
  );

  const totalActionItems = drafts.length + overdue.length + dueToday.length;

  // Hide the widget on a clean inbox. Today should stay scannable; an
  // "everything is great" panel takes up real estate without helping.
  if (
    !draftsQuery.isPending &&
    !tasksQuery.isPending &&
    totalActionItems === 0
  ) {
    return null;
  }

  return (
    <section
      className="space-y-3"
      aria-labelledby="needs-action-heading"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2
          id="needs-action-heading"
          className="text-lg font-medium text-(--color-foreground)"
        >
          Needs your action
        </h2>
        {totalActionItems > 0 ? (
          <p className="text-sm text-(--color-muted-foreground)">
            {drafts.length > 0
              ? `${drafts.length} draft${drafts.length === 1 ? "" : "s"}`
              : null}
            {drafts.length > 0 && (overdue.length > 0 || dueToday.length > 0)
              ? " · "
              : ""}
            {overdue.length > 0 ? (
              <span className="font-medium text-(--color-destructive)">
                {overdue.length} overdue
              </span>
            ) : null}
            {overdue.length > 0 && dueToday.length > 0 ? " · " : ""}
            {dueToday.length > 0
              ? `${dueToday.length} due today`
              : null}
          </p>
        ) : null}
      </div>

      {draftsQuery.isPending || tasksQuery.isPending ? (
        <p className="text-sm text-(--color-muted-foreground)">
          Loading your work…
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          <DraftsCard drafts={drafts} />
          <OverdueCard tasks={overdue} />
          <DueTodayCard tasks={dueToday} />
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Bucket cards
// ---------------------------------------------------------------------------

function BucketCard({
  icon: Icon,
  iconClassName,
  label,
  count,
  emptyMessage,
  children,
}: {
  icon: React.ElementType;
  iconClassName: string;
  label: string;
  count: number;
  emptyMessage: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="space-y-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className={`h-4 w-4 ${iconClassName}`} aria-hidden="true" />
          <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground)">
            {label}
          </h3>
        </div>
        <span className="text-sm font-medium text-(--color-foreground) tabular-nums">
          {count}
        </span>
      </div>
      {count === 0 ? (
        <p className="text-xs text-(--color-muted-foreground)">
          {emptyMessage}
        </p>
      ) : (
        <ul className="space-y-1.5">{children}</ul>
      )}
    </Card>
  );
}

function DraftsCard({ drafts }: { drafts: Note[] }) {
  return (
    <BucketCard
      icon={FileText}
      iconClassName="text-amber-600"
      label="Notes to sign"
      count={drafts.length}
      emptyMessage="No drafts of yours waiting."
    >
      {drafts.slice(0, 3).map((n) => (
        <li key={n.id}>
          <Link
            href={`/patients/${n.patientId}/notes/${n.id}`}
            className="flex items-start gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-(--color-muted)/40"
          >
            <ChevronRight
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-(--color-muted-foreground)"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-(--color-foreground)">
                {firstLine(n.body)}
              </p>
              <p className="text-xs text-(--color-muted-foreground)">
                {n.updatedAt
                  ? new Date(n.updatedAt).toLocaleString(undefined, {
                      weekday: "short",
                      hour: "numeric",
                      minute: "2-digit",
                    })
                  : ""}
              </p>
            </div>
          </Link>
        </li>
      ))}
    </BucketCard>
  );
}

function OverdueCard({ tasks }: { tasks: Task[] }) {
  return (
    <BucketCard
      icon={AlertCircle}
      iconClassName="text-(--color-destructive)"
      label="Overdue tasks"
      count={tasks.length}
      emptyMessage="Nothing overdue."
    >
      {tasks.map((t) => (
        <li key={t.id}>
          <TaskLink task={t} accent="text-(--color-destructive)" />
        </li>
      ))}
    </BucketCard>
  );
}

function DueTodayCard({ tasks }: { tasks: Task[] }) {
  return (
    <BucketCard
      icon={Calendar}
      iconClassName="text-amber-600"
      label="Due today"
      count={tasks.length}
      emptyMessage="Clear for today."
    >
      {tasks.map((t) => (
        <li key={t.id}>
          <TaskLink task={t} accent="text-amber-700" />
        </li>
      ))}
    </BucketCard>
  );
}

// Shared row renderer. /tasks shows the full queue; the link goes there
// rather than to a deep-link on each task so the provider can triage
// the surrounding context (other tasks for this patient, etc.).
function TaskLink({ task, accent }: { task: Task; accent: string }) {
  return (
    <Link
      href="/tasks"
      className="flex items-start gap-2 rounded-md px-1.5 py-1 text-xs hover:bg-(--color-muted)/40"
    >
      <ListChecks
        className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${accent}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-(--color-foreground)">
          {task.title}
        </p>
        <p className="text-xs text-(--color-muted-foreground)">
          {CATEGORY_LABEL[task.category]}
          {task.dueAt
            ? ` · ${new Date(task.dueAt).toLocaleString(undefined, {
                hour: "numeric",
                minute: "2-digit",
              })}`
            : ""}
        </p>
      </div>
    </Link>
  );
}

function firstLine(body: string): string {
  const i = body.indexOf("\n");
  const line = i === -1 ? body : body.slice(0, i);
  return line.trim() || "(empty draft)";
}

// Re-export keeps the import list one-line in Today.tsx without an
// index file.
export { CheckCircle2 };
