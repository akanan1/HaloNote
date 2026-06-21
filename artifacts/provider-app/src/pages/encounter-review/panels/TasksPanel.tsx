// Tasks panel: AI-generated follow-up tasks for this encounter with
// open/closed grouping and per-row complete action. Single mutation
// (generateTasksForEncounter) plus a per-row completeTaskApi call.

import { useState } from "react";
import { Link } from "wouter";
import { useMutation } from "@tanstack/react-query";
import {
  CheckCircle2,
  CircleDashed,
  ListChecks,
  Loader2,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { completeTaskApi, generateTasksForEncounter } from "../api";
import { TASK_CATEGORY_LABEL } from "../constants";
import type { Task } from "../types";

interface Props {
  encounterId: string;
  tasks: Task[] | null;
  loading: boolean;
  onChanged: () => void;
}

export function TasksPanel({ encounterId, tasks, loading, onChanged }: Props) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const generateMut = useMutation({
    mutationFn: () => generateTasksForEncounter(encounterId),
    onSuccess: (res) => {
      toast.success(
        res.source === "ai"
          ? `Generated ${res.data.length} tasks`
          : `Generated ${res.data.length} tasks (stub)`,
      );
      onChanged();
    },
    onError: (err) =>
      toast.error(err instanceof Error ? err.message : "Generate failed"),
  });

  async function handleComplete(t: Task) {
    setBusyId(t.id);
    try {
      await completeTaskApi(t.id);
      toast.success("Task completed");
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't complete");
    } finally {
      setBusyId(null);
    }
  }

  const list = tasks ?? [];
  const open = list.filter((t) => !t.isClosed);
  const closed = list.filter((t) => t.isClosed);

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ListChecks
            className="h-5 w-5 text-(--color-muted-foreground)"
            aria-hidden="true"
          />
          <h2 className="text-lg font-medium">Follow-up tasks</h2>
          {tasks ? (
            <span className="text-sm text-(--color-muted-foreground)">
              {open.length} open
              {closed.length > 0 ? ` · ${closed.length} closed` : ""}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/tasks"
            className="text-sm text-(--color-muted-foreground) hover:text-(--color-foreground)"
          >
            All tasks →
          </Link>
          <Button
            size="sm"
            variant={list.length > 0 ? "outline" : "default"}
            onClick={() => generateMut.mutate()}
            disabled={generateMut.isPending}
          >
            {generateMut.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            )}
            {list.length > 0 ? "Generate more" : "Generate tasks"}
          </Button>
        </div>
      </div>
      {loading ? (
        <p className="text-sm text-(--color-muted-foreground)">Loading tasks…</p>
      ) : list.length === 0 ? (
        <p className="text-sm text-(--color-muted-foreground)">
          No tasks for this encounter yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {[...open, ...closed].map((t) => (
            <EncounterTaskRow
              key={t.id}
              task={t}
              busy={busyId === t.id}
              onComplete={() => void handleComplete(t)}
            />
          ))}
        </ul>
      )}
    </Card>
  );
}

function EncounterTaskRow({
  task,
  busy,
  onComplete,
}: {
  task: Task;
  busy: boolean;
  onComplete: () => void;
}) {
  const closed = task.isClosed;
  return (
    <li>
      <div
        className={`flex items-start gap-3 rounded-md border border-(--color-border) p-3 ${
          closed ? "opacity-60" : ""
        }`}
      >
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
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="inline-flex rounded-full bg-(--color-muted) px-2 py-0.5 text-xs font-medium ring-1 ring-inset ring-(--color-border)">
              {TASK_CATEGORY_LABEL[task.category]}
            </span>
            {task.priority === "high" ? (
              <span className="text-xs font-medium uppercase text-red-700">
                High
              </span>
            ) : null}
            {task.source === "ai" ? (
              <span className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
                AI
              </span>
            ) : null}
            <span className="text-sm font-medium">{task.title}</span>
          </div>
          {task.description ? (
            <p className="text-xs text-(--color-muted-foreground)">
              {task.description}
            </p>
          ) : null}
          {task.dueAt ? (
            <p className="text-xs text-(--color-muted-foreground)">
              Due {new Date(task.dueAt).toLocaleDateString()}
            </p>
          ) : null}
        </div>
        {!closed ? (
          <Button size="sm" onClick={onComplete} disabled={busy}>
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            )}
            Done
          </Button>
        ) : null}
      </div>
    </li>
  );
}
