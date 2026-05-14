import { useState } from "react";
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
import { ApiError, useListAuditLog } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function statusTone(status: unknown): "ok" | "client-error" | "server-error" | "neutral" {
  if (typeof status !== "number") return "neutral";
  if (status >= 500) return "server-error";
  if (status >= 400) return "client-error";
  if (status >= 200 && status < 400) return "ok";
  return "neutral";
}

const ACTION_FILTERS = [
  "list_patients",
  "create_patient",
  "list_notes",
  "view_note",
  "create_note",
  "update_note",
  "send_note_to_ehr",
  "list_audit-logs",
];

const RESOURCE_FILTERS = ["patient", "note", "audit-log"];

export function AuditLogPage() {
  const [actionFilter, setActionFilter] = useState<string | undefined>();
  const [resourceFilter, setResourceFilter] = useState<string | undefined>();

  const query = useListAuditLog({
    limit: 100,
    ...(actionFilter ? { action: actionFilter } : {}),
    ...(resourceFilter ? { resourceType: resourceFilter } : {}),
  });

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-(--color-muted-foreground) hover:text-(--color-foreground)"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to patients
        </Link>
      </div>

      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Audit log</h1>
        <p className="text-(--color-muted-foreground)">
          Every authenticated read and write to clinical data. Newest first.
        </p>
      </header>

      <section className="space-y-3">
        <FilterRow
          label="Action"
          value={actionFilter}
          options={ACTION_FILTERS}
          onChange={setActionFilter}
        />
        <FilterRow
          label="Resource"
          value={resourceFilter}
          options={RESOURCE_FILTERS}
          onChange={setResourceFilter}
        />
      </section>

      {query.isPending ? (
        <p className="text-(--color-muted-foreground)">Loading…</p>
      ) : query.isError ? (
        <ErrorMessage error={query.error} />
      ) : query.data.data.length === 0 ? (
        <Card className="p-10 text-center text-(--color-muted-foreground)">
          No matching audit entries.
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {/* Mobile: card-per-entry list. A 5-column table clipped to the
              viewport edge hides "Resource" and "Status" entirely on a
              phone — the two most important fields for an audit log. */}
          <ul
            className="divide-y divide-(--color-border) md:hidden"
            aria-label="Audit entries"
          >
            {query.data.data.map((entry) => {
              const status = (entry.metadata as { status?: unknown } | null)
                ?.status;
              const method = (entry.metadata as { method?: unknown } | null)
                ?.method;
              return (
                <li key={entry.id} className="space-y-1.5 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-xs text-(--color-muted-foreground)">
                      {formatTimestamp(entry.at)}
                    </span>
                    <StatusBadge
                      tone={statusTone(status)}
                      method={typeof method === "string" ? method : ""}
                      status={typeof status === "number" ? status : undefined}
                    />
                  </div>
                  <div className="font-mono text-xs">{entry.action}</div>
                  <div className="text-sm text-(--color-muted-foreground)">
                    {entry.userDisplayName ?? "(system)"} · {entry.resourceType}
                    {entry.resourceId ? (
                      <span className="ml-1 font-mono text-xs text-(--color-foreground)">
                        / {entry.resourceId}
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>

          {/* Desktop: original table */}
          <table className="hidden w-full text-sm md:table">
            <thead className="bg-(--color-muted) text-left text-(--color-muted-foreground)">
              <tr>
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 font-medium">Who</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Resource</th>
                <th className="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {query.data.data.map((entry) => {
                const status = (entry.metadata as { status?: unknown } | null)
                  ?.status;
                const method = (entry.metadata as { method?: unknown } | null)
                  ?.method;
                return (
                  <tr
                    key={entry.id}
                    className="border-t border-(--color-border)"
                  >
                    <td className="px-4 py-3 text-(--color-muted-foreground) whitespace-nowrap">
                      {formatTimestamp(entry.at)}
                    </td>
                    <td className="px-4 py-3">
                      {entry.userDisplayName ?? (
                        <span className="text-(--color-muted-foreground)">
                          (system)
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {entry.action}
                    </td>
                    <td className="px-4 py-3 text-(--color-muted-foreground)">
                      {entry.resourceType}
                      {entry.resourceId ? (
                        <span className="ml-1 font-mono text-xs text-(--color-foreground)">
                          / {entry.resourceId}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        tone={statusTone(status)}
                        method={typeof method === "string" ? method : ""}
                        status={typeof status === "number" ? status : undefined}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function ErrorMessage({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 403) {
    return (
      <Card className="p-10 text-center">
        <h2 className="text-lg font-medium">Admins only</h2>
        <p className="mt-2 text-sm text-(--color-muted-foreground)">
          Your account doesn't have permission to view the audit log.
        </p>
      </Card>
    );
  }
  return (
    <p className="text-(--color-destructive)">
      Couldn't load audit log.{" "}
      {error instanceof Error ? error.message : ""}
    </p>
  );
}

function FilterRow({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | undefined;
  options: ReadonlyArray<string>;
  onChange: (next: string | undefined) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-(--color-muted-foreground)">{label}:</span>
      <Button
        variant={value === undefined ? "default" : "outline"}
        size="sm"
        onClick={() => onChange(undefined)}
      >
        All
      </Button>
      {options.map((opt) => (
        <Button
          key={opt}
          variant={value === opt ? "default" : "outline"}
          size="sm"
          onClick={() => onChange(opt)}
        >
          {opt}
        </Button>
      ))}
    </div>
  );
}

function StatusBadge({
  tone,
  method,
  status,
}: {
  tone: "ok" | "client-error" | "server-error" | "neutral";
  method: string;
  status: number | undefined;
}) {
  const styles: Record<typeof tone, string> = {
    ok: "bg-emerald-50 text-emerald-800 ring-emerald-200",
    "client-error": "bg-amber-50 text-amber-800 ring-amber-200",
    "server-error": "bg-red-50 text-red-800 ring-red-200",
    neutral:
      "bg-(--color-muted) text-(--color-muted-foreground) ring-(--color-border)",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset",
        styles[tone],
      )}
    >
      {method && status !== undefined ? `${method} ${status}` : "—"}
    </span>
  );
}
