import { useMemo, useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, ExternalLink } from "lucide-react";
import {
  ApiError,
  useListAutoPushedNotes,
  type AutoPushedNoteEntry,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const PAGE_LIMIT = 50;

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

// A date picker yields a local-date `YYYY-MM-DD`; the API expects an
// ISO date-time. Convert at the boundary so the user can express "from
// June 10" without worrying about timezones.
function dateInputToIso(value: string, end: boolean): string | undefined {
  if (!value) return undefined;
  const d = end
    ? new Date(`${value}T23:59:59.999`)
    : new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

interface AppliedFilters {
  from?: string;
  to?: string;
  userId?: string;
}

export function AdminAutoPushAuditPage() {
  // Input state — does NOT trigger a refetch on every keystroke.
  const [fromDate, setFromDate] = useState<string>("");
  const [toDate, setToDate] = useState<string>("");
  const [userIdInput, setUserIdInput] = useState<string>("");

  // Applied filters — drives the query.
  const [applied, setApplied] = useState<AppliedFilters>({});
  // Cursor for the page CURRENTLY being fetched. undefined = first page.
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  // Pages we've already fetched and want to keep visible above the
  // current page. Reset on filter apply.
  const [earlierPages, setEarlierPages] = useState<AutoPushedNoteEntry[]>([]);

  const params = useMemo(
    () => ({
      limit: PAGE_LIMIT,
      ...(applied.from ? { from: applied.from } : {}),
      ...(applied.to ? { to: applied.to } : {}),
      ...(applied.userId ? { userId: applied.userId } : {}),
      ...(cursor ? { cursor } : {}),
    }),
    [applied, cursor],
  );

  const query = useListAutoPushedNotes(params);

  function applyFilters() {
    setApplied({
      ...(fromDate ? { from: dateInputToIso(fromDate, false) } : {}),
      ...(toDate ? { to: dateInputToIso(toDate, true) } : {}),
      ...(userIdInput.trim() ? { userId: userIdInput.trim() } : {}),
    });
    setCursor(undefined);
    setEarlierPages([]);
  }

  function clearFilters() {
    setFromDate("");
    setToDate("");
    setUserIdInput("");
    setApplied({});
    setCursor(undefined);
    setEarlierPages([]);
  }

  function loadMore() {
    const next = query.data?.nextCursor;
    if (!next || !query.data) return;
    // Snapshot the current page into earlierPages, then advance cursor.
    setEarlierPages((prev) => {
      const ids = new Set(prev.map((n) => n.noteId));
      const currentPage = query.data!.data.filter((n) => !ids.has(n.noteId));
      return [...prev, ...currentPage];
    });
    setCursor(next);
  }

  // Displayed list = earlierPages + current page, deduped by noteId.
  const displayed: AutoPushedNoteEntry[] = useMemo(() => {
    const current = query.data?.data ?? [];
    const seen = new Set<string>();
    const out: AutoPushedNoteEntry[] = [];
    for (const row of [...earlierPages, ...current]) {
      if (seen.has(row.noteId)) continue;
      seen.add(row.noteId);
      out.push(row);
    }
    return out;
  }, [earlierPages, query.data]);

  const hasMore = Boolean(query.data?.nextCursor);

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
        <h1 className="text-3xl font-semibold tracking-tight">
          Auto-pushed notes
        </h1>
        <p className="text-(--color-muted-foreground)">
          Notes that shipped to the EHR without provider review (authors with
          <code className="mx-1 rounded bg-(--color-muted) px-1 text-xs">
            autoPushMode=after_transcription
          </code>
          ). Newest first.
        </p>
      </header>

      <Card className="space-y-4 p-4">
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-4">
          <FilterField label="From" htmlFor="auto-from">
            <Input
              id="auto-from"
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </FilterField>
          <FilterField label="To" htmlFor="auto-to">
            <Input
              id="auto-to"
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </FilterField>
          <FilterField label="Author user ID" htmlFor="auto-user-id">
            <Input
              id="auto-user-id"
              type="text"
              placeholder="usr_…"
              value={userIdInput}
              onChange={(e) => setUserIdInput(e.target.value)}
              autoComplete="off"
            />
          </FilterField>
          <div className="flex items-end gap-2">
            <Button onClick={applyFilters} disabled={query.isFetching}>
              Apply
            </Button>
            <Button
              variant="outline"
              onClick={clearFilters}
              disabled={query.isFetching}
            >
              Clear
            </Button>
          </div>
        </div>
      </Card>

      {query.isPending ? (
        <LoadingList />
      ) : query.isError ? (
        <ErrorMessage error={query.error} />
      ) : displayed.length === 0 ? (
        <Card className="p-10 text-center text-(--color-muted-foreground)">
          No auto-pushed notes in this range.
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden">
            {/* Mobile: card list */}
            <ul
              className="divide-y divide-(--color-border) md:hidden"
              aria-label="Auto-pushed notes"
            >
              {displayed.map((entry) => (
                <MobileRow key={entry.noteId} entry={entry} />
              ))}
            </ul>

            {/* Desktop: table */}
            <table className="hidden w-full text-sm md:table">
              <thead className="bg-(--color-muted) text-left text-(--color-muted-foreground)">
                <tr>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 font-medium">Provider</th>
                  <th className="px-4 py-3 font-medium">Patient</th>
                  <th className="px-4 py-3 font-medium">EHR ref</th>
                  <th className="px-4 py-3 font-medium">Error</th>
                  <th className="px-4 py-3 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {displayed.map((entry) => (
                  <DesktopRow key={entry.noteId} entry={entry} />
                ))}
              </tbody>
            </table>
          </Card>

          {hasMore ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                onClick={loadMore}
                disabled={query.isFetching}
              >
                {query.isFetching ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

function FilterField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="block space-y-1">
      <span className="text-xs font-medium text-(--color-muted-foreground)">
        {label}
      </span>
      {children}
    </label>
  );
}

function MobileRow({ entry }: { entry: AutoPushedNoteEntry }) {
  return (
    <li className="space-y-1.5 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <span className="text-xs text-(--color-muted-foreground)">
          {formatTimestamp(entry.createdAt)}
        </span>
        <Link
          href={`/patients/${entry.patientId}/notes/${entry.noteId}`}
          className="inline-flex items-center gap-1 text-xs text-(--color-primary) hover:underline"
        >
          Open <ExternalLink className="h-3 w-3" />
        </Link>
      </div>
      <div className="text-sm">
        {entry.authorDisplayName ?? (
          <span className="text-(--color-muted-foreground)">(unknown)</span>
        )}
      </div>
      <div className="font-mono text-xs text-(--color-muted-foreground)">
        patient: {entry.patientId}
      </div>
      <div className="font-mono text-xs text-(--color-muted-foreground)">
        ref: {entry.ehrDocumentRef ?? "—"}
      </div>
      {entry.ehrError ? (
        <div className="text-xs text-(--color-destructive)">
          {entry.ehrError}
        </div>
      ) : null}
    </li>
  );
}

function DesktopRow({ entry }: { entry: AutoPushedNoteEntry }) {
  return (
    <tr className="border-t border-(--color-border)">
      <td className="px-4 py-3 text-(--color-muted-foreground) whitespace-nowrap">
        {formatTimestamp(entry.createdAt)}
      </td>
      <td className="px-4 py-3">
        {entry.authorDisplayName ?? (
          <span className="text-(--color-muted-foreground)">(unknown)</span>
        )}
      </td>
      <td className="px-4 py-3 font-mono text-xs">{entry.patientId}</td>
      <td className="px-4 py-3 font-mono text-xs">
        {entry.ehrDocumentRef ?? (
          <span className="text-(--color-muted-foreground)">—</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-(--color-destructive)">
        {entry.ehrError ?? (
          <span className="text-(--color-muted-foreground)">—</span>
        )}
      </td>
      <td className="px-4 py-3">
        <Link
          href={`/patients/${entry.patientId}/notes/${entry.noteId}`}
          className="inline-flex items-center gap-1 text-(--color-primary) hover:underline"
        >
          Open <ExternalLink className="h-3 w-3" />
        </Link>
      </td>
    </tr>
  );
}

function LoadingList() {
  return (
    <Card
      className="overflow-hidden"
      role="status"
      aria-label="Loading auto-pushed notes"
    >
      <ul className="divide-y divide-(--color-border)">
        {[0, 1, 2, 3, 4].map((i) => (
          <li key={i} className="flex items-center gap-3 px-4 py-3">
            <div className="h-3 w-24 animate-pulse rounded bg-(--color-muted)" />
            <div className="h-3 flex-1 animate-pulse rounded bg-(--color-muted)" />
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ErrorMessage({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 403) {
    return (
      <Card className="p-10 text-center">
        <h2 className="text-lg font-medium">Admins only</h2>
        <p className="mt-2 text-sm text-(--color-muted-foreground)">
          Your account doesn't have permission to view this audit surface.
        </p>
      </Card>
    );
  }
  return (
    <p className="text-(--color-destructive)">
      Couldn't load auto-pushed notes.{" "}
      {error instanceof Error ? error.message : ""}
    </p>
  );
}
