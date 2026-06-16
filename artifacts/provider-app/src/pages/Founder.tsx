import { useEffect, useState } from "react";
import { Link } from "wouter";
import {
  ArrowLeft,
  Download,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  Users as UsersIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetFounderAnalyticsQueryKey,
  useGetFounderAnalytics,
  uploadLegalVersion,
  type FounderUserRow,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Sparkline, type SparklineDatum } from "@/components/Sparkline";

// Auto-refresh interval. The Founder dashboard is more useful as a
// live wallboard than as a snapshot, but the page is heavy enough
// (multi-aggregate queries) that we don't want to hammer the DB.
// 60 seconds is a good compromise — fast enough to feel live, slow
// enough that two open tabs aren't a load test.
const REFRESH_INTERVAL_MS = 60 * 1000;

// Cross-tenant analytics dashboard for the HaloNote founder team.
// Two halves:
//   - Headline metrics (users, patients, notes, recordings, signups).
//   - Per-user table with activity counts + legal acceptance status.
// Backend gates with `requireFounder` and 404s non-founders — the
// AppLayout nav also hides the tab unless `user.isFounder` is true.
export function FounderPage() {
  const query = useGetFounderAnalytics({
    query: {
      queryKey: getGetFounderAnalyticsQueryKey(),
      refetchInterval: REFRESH_INTERVAL_MS,
    },
  });
  // Local clock that ticks every second so the "Last updated" stamp
  // re-renders. Stops the staleness display from looking frozen
  // between refetches.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  if (query.isPending) {
    return (
      <div className="space-y-6">
        <BackLink />
        <Header lastUpdatedLabel="" onExport={() => {}} canExport={false} />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} className="space-y-2 p-4">
              <div className="h-3 w-1/2 animate-pulse rounded bg-(--color-muted)" />
              <div className="h-8 w-2/3 animate-pulse rounded bg-(--color-muted)" />
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="space-y-6">
        <BackLink />
        <Header lastUpdatedLabel="" onExport={() => {}} canExport={false} />
        <p
          role="alert"
          className="text-sm text-(--color-destructive)"
        >
          Couldn't load analytics.
        </p>
      </div>
    );
  }

  const { totals, dailySeries, compliance, users } = query.data;

  return (
    <div className="space-y-8">
      <BackLink />
      <Header
        lastUpdatedLabel={formatLastUpdated(
          query.dataUpdatedAt,
          now,
          query.isFetching,
        )}
        onExport={() => downloadUsersCsv(users)}
        canExport={users.length > 0}
      />

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted-foreground)">
          Platform totals · last {dailySeries.signups.length} days
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat
            label="Users"
            value={totals.users}
            hint={`${totals.admins} admins`}
            series={dailySeries.signups}
          />
          <Stat label="Patients" value={totals.patients} />
          <Stat
            label="Notes"
            value={totals.notes}
            series={dailySeries.notes}
          />
          <Stat
            label="Recordings"
            value={totals.recordingsTotal}
            hint={`${totals.recordingsDone} done · ${totals.recordingsFailed} failed`}
            series={dailySeries.recordings}
          />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted-foreground)">
          Compliance
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Card className="space-y-1 p-4">
            <div className="text-xs text-(--color-muted-foreground)">
              Onboarding completion
            </div>
            <div className="text-3xl font-semibold tabular-nums">
              {Math.round(compliance.onboardingCompletionRate * 100)}%
            </div>
            <div className="text-xs text-(--color-muted-foreground)">
              {compliance.onboardingCompleted} done · {compliance.onboardingPending} pending
            </div>
          </Card>
          <Card className="space-y-1 p-4">
            <div className="text-xs text-(--color-muted-foreground)">
              Stale BAA
            </div>
            <div className={
              compliance.staleBaaUsers > 0
                ? "text-3xl font-semibold tabular-nums text-(--color-destructive)"
                : "text-3xl font-semibold tabular-nums text-(--color-foreground)"
            }>
              {compliance.staleBaaUsers}
            </div>
            <div className="text-xs text-(--color-muted-foreground)">
              users out of date
            </div>
          </Card>
          <Card className="space-y-1 p-4">
            <div className="text-xs text-(--color-muted-foreground)">
              Stale Terms
            </div>
            <div className="text-3xl font-semibold tabular-nums">
              {compliance.staleTermsUsers}
            </div>
          </Card>
          <Card className="space-y-1 p-4">
            <div className="text-xs text-(--color-muted-foreground)">
              Stale Privacy
            </div>
            <div className="text-3xl font-semibold tabular-nums">
              {compliance.stalePrivacyUsers}
            </div>
          </Card>
        </div>
      </section>

      <PublishLegalVersionsSection />

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted-foreground)">
          Recent growth
        </h2>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Card className="space-y-1 p-4">
            <div className="flex items-center gap-2 text-xs text-(--color-muted-foreground)">
              <TrendingUp className="h-4 w-4" aria-hidden="true" />
              New signups (last 7 days)
            </div>
            <div className="text-3xl font-semibold tabular-nums">
              {totals.signupsLast7Days}
            </div>
          </Card>
          <Card className="space-y-1 p-4">
            <div className="flex items-center gap-2 text-xs text-(--color-muted-foreground)">
              <TrendingUp className="h-4 w-4" aria-hidden="true" />
              New signups (last 30 days)
            </div>
            <div className="text-3xl font-semibold tabular-nums">
              {totals.signupsLast30Days}
            </div>
          </Card>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted-foreground)">
            Users
          </h2>
          <span className="text-xs text-(--color-muted-foreground)">
            <UsersIcon
              className="mr-1 inline-block h-3 w-3"
              aria-hidden="true"
            />
            {users.length} total — newest first
          </span>
        </div>

        {/* Mobile: card per user */}
        <ul className="space-y-2 md:hidden">
          {users.map((u) => (
            <li key={u.id}>
              <UserCard user={u} />
            </li>
          ))}
        </ul>

        {/* Desktop: dense table */}
        <Card className="hidden overflow-hidden md:block">
          <table className="w-full text-sm">
            <thead className="bg-(--color-muted)/50 text-left text-xs uppercase tracking-wide text-(--color-muted-foreground)">
              <tr>
                <th className="px-4 py-2 font-medium">Provider</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 text-right font-medium">Notes</th>
                <th className="px-3 py-2 text-right font-medium">Patients</th>
                <th className="px-3 py-2 text-right font-medium">Recs</th>
                <th className="px-3 py-2 font-medium">Last note</th>
                <th className="px-3 py-2 font-medium">BAA</th>
                <th className="px-3 py-2 font-medium">Terms</th>
                <th className="px-3 py-2 font-medium">Privacy</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-(--color-border)">
              {users.map((u) => (
                <UserRow key={u.id} user={u} />
              ))}
            </tbody>
          </table>
        </Card>
      </section>
    </div>
  );
}

function BackLink() {
  return (
    <div>
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-(--color-muted-foreground) hover:text-(--color-foreground)"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back
      </Link>
    </div>
  );
}

// Founder-only legal-document publishing surface. Lets the team push
// a counsel-finalized BAA/Terms/Privacy without a code deploy. Each
// submit appends a new row to legal_document_overrides, becomes the
// current version for that type, and emails every user with a stale
// acceptance so they see it before their next sign-in.
function PublishLegalVersionsSection() {
  const queryClient = useQueryClient();
  const [docType, setDocType] = useState<"baa" | "terms" | "privacy">("baa");
  const [version, setVersion] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const v = version.trim();
    const b = body.trim();
    if (!v || b.length < 100) {
      toast.error("Version + at least 100 chars of body are required.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await uploadLegalVersion({ type: docType, version: v, body: b });
      toast.success(
        `Published ${docType} v${result.version}. Notified ${result.notifiedUserCount} users.`,
      );
      setVersion("");
      setBody("");
      void queryClient.invalidateQueries({
        queryKey: getGetFounderAnalyticsQueryKey(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't publish");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted-foreground)">
        Publish a new legal document version
      </h2>
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1 text-sm">
            <span className="text-xs text-(--color-muted-foreground)">
              Document
            </span>
            <select
              value={docType}
              onChange={(e) =>
                setDocType(e.target.value as "baa" | "terms" | "privacy")
              }
              disabled={submitting}
              className="h-9 rounded-md border border-(--color-border) bg-(--color-card) px-3 text-sm"
            >
              <option value="baa">Business Associate Agreement</option>
              <option value="terms">Terms of Service</option>
              <option value="privacy">Privacy Policy</option>
            </select>
          </label>
          <label className="flex-1 space-y-1 text-sm">
            <span className="text-xs text-(--color-muted-foreground)">
              Version (e.g. 2.0)
            </span>
            <input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="2.0"
              disabled={submitting}
              className="h-9 w-full rounded-md border border-(--color-border) bg-(--color-card) px-3 text-sm"
            />
          </label>
        </div>
        <label className="space-y-1 text-sm">
          <span className="text-xs text-(--color-muted-foreground)">
            Markdown body (at least 100 characters)
          </span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={10}
            placeholder="Paste the finalized text from counsel…"
            disabled={submitting}
            className="block w-full rounded-md border border-(--color-border) bg-(--color-card) p-3 font-mono text-xs"
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-(--color-muted-foreground)">
            Publishing is append-only. The prior version stays referenced
            by every historical acceptance row.
          </p>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={submitting || !version.trim() || body.trim().length < 100}
          >
            {submitting ? "Publishing…" : "Publish & notify"}
          </Button>
        </div>
      </Card>
    </section>
  );
}

function Header({
  lastUpdatedLabel,
  onExport,
  canExport,
}: {
  lastUpdatedLabel: string;
  onExport: () => void;
  canExport: boolean;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">Founder</h1>
        <p className="text-(--color-muted-foreground)">
          Cross-tenant analytics and legal acceptance tracking. Founder
          access only.
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="text-xs text-(--color-muted-foreground) tabular-nums"
          aria-live="polite"
        >
          {lastUpdatedLabel}
        </span>
        <Button
          variant="outline"
          size="sm"
          onClick={onExport}
          disabled={!canExport}
          aria-label="Download users CSV"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Export CSV
        </Button>
      </div>
    </header>
  );
}

function formatLastUpdated(
  updatedAtMs: number,
  nowMs: number,
  isFetching: boolean,
): string {
  if (isFetching) return "Refreshing…";
  if (!updatedAtMs) return "—";
  const delta = Math.max(0, Math.floor((nowMs - updatedAtMs) / 1000));
  if (delta < 5) return "Updated just now";
  if (delta < 60) return `Updated ${delta}s ago`;
  const minutes = Math.floor(delta / 60);
  return `Updated ${minutes}m ago`;
}

// CSV export — flat, one row per user. Hand-rolled rather than reaching
// for a CSV lib: the schema is fixed, we control every field, and
// quoting / commas / newlines inside `displayName` are the only
// gotchas we need to handle.
function downloadUsersCsv(users: FounderUserRow[]): void {
  const header = [
    "id",
    "email",
    "displayName",
    "role",
    "isFounder",
    "createdAt",
    "lastNoteAt",
    "patientCount",
    "noteCount",
    "recordingCount",
    "baaAccepted",
    "baaAcceptedVersion",
    "baaAcceptedAt",
    "termsAccepted",
    "termsAcceptedVersion",
    "termsAcceptedAt",
    "privacyAccepted",
    "privacyAcceptedVersion",
    "privacyAcceptedAt",
  ];
  const escape = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    if (/[",\n\r]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const rows = users.map((u) => {
    const find = (t: "baa" | "terms" | "privacy") =>
      u.legalAcceptances.find((a) => a.type === t);
    const baa = find("baa");
    const terms = find("terms");
    const privacy = find("privacy");
    return [
      u.id,
      u.email,
      u.displayName,
      u.role,
      u.isFounder ? "true" : "false",
      u.createdAt,
      u.lastNoteAt ?? "",
      u.patientCount,
      u.noteCount,
      u.recordingCount,
      baa?.accepted ? "true" : "false",
      baa?.acceptedVersion ?? "",
      baa?.acceptedAt ?? "",
      terms?.accepted ? "true" : "false",
      terms?.acceptedVersion ?? "",
      terms?.acceptedAt ?? "",
      privacy?.accepted ? "true" : "false",
      privacy?.acceptedVersion ?? "",
      privacy?.acceptedAt ?? "",
    ]
      .map(escape)
      .join(",");
  });
  const csv = [header.join(","), ...rows].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const stamp = new Date().toISOString().slice(0, 10);
  link.download = `halonote-users-${stamp}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function Stat({
  label,
  value,
  hint,
  series,
}: {
  label: string;
  value: number;
  hint?: string;
  series?: SparklineDatum[];
}) {
  return (
    <Card className="space-y-1 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs text-(--color-muted-foreground)">{label}</div>
        {series && series.length > 0 ? (
          <span className="text-(--color-primary)">
            <Sparkline
              data={series}
              width={56}
              height={20}
              ariaLabel={`${label} trend`}
            />
          </span>
        ) : null}
      </div>
      <div className="text-3xl font-semibold tabular-nums">{value}</div>
      {hint ? (
        <div className="text-xs text-(--color-muted-foreground)">{hint}</div>
      ) : null}
    </Card>
  );
}

// Shared types — Orval generates these from the OpenAPI spec but
// they're conveniently structural for the renderers below.
type UserRowProps = {
  user: {
    id: string;
    email: string;
    displayName: string;
    role: string;
    isFounder?: boolean;
    createdAt: string;
    lastNoteAt?: string;
    patientCount: number;
    noteCount: number;
    recordingCount: number;
    legalAcceptances: Array<{
      type: string;
      currentVersion: string;
      accepted: boolean;
      acceptedVersion?: string;
      acceptedAt?: string;
    }>;
  };
};

function UserRow({ user }: UserRowProps) {
  const baa = user.legalAcceptances.find((a) => a.type === "baa");
  const terms = user.legalAcceptances.find((a) => a.type === "terms");
  const privacy = user.legalAcceptances.find((a) => a.type === "privacy");
  return (
    <tr className="cursor-pointer text-(--color-foreground) transition-colors hover:bg-(--color-muted)/50">
      <td className="px-4 py-3">
        <Link
          href={`/founder/users/${user.id}`}
          className="block hover:text-(--color-foreground)"
        >
          <div className="font-medium">{user.displayName}</div>
          <div className="text-xs text-(--color-muted-foreground)">
            {user.email}
          </div>
        </Link>
      </td>
      <td className="px-3 py-3 text-xs">
        {user.role}
        {user.isFounder ? (
          <span className="ml-1 rounded bg-(--color-primary)/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-(--color-primary)">
            founder
          </span>
        ) : null}
      </td>
      <td className="px-3 py-3 text-right tabular-nums">{user.noteCount}</td>
      <td className="px-3 py-3 text-right tabular-nums">
        {user.patientCount}
      </td>
      <td className="px-3 py-3 text-right tabular-nums">
        {user.recordingCount}
      </td>
      <td className="px-3 py-3 text-xs text-(--color-muted-foreground)">
        {user.lastNoteAt ? formatDate(user.lastNoteAt) : "—"}
      </td>
      <LegalCell entry={baa} />
      <LegalCell entry={terms} />
      <LegalCell entry={privacy} />
    </tr>
  );
}

function UserCard({ user }: UserRowProps) {
  return (
    <Link href={`/founder/users/${user.id}`}>
    <Card className="space-y-2 p-4 transition-colors hover:bg-(--color-muted)/40">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{user.displayName}</div>
          <div className="truncate text-xs text-(--color-muted-foreground)">
            {user.email}
          </div>
        </div>
        <span className="text-xs text-(--color-muted-foreground)">
          {user.role}
          {user.isFounder ? " · founder" : ""}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-(--color-muted-foreground)">
        <span>
          <span className="font-medium text-(--color-foreground) tabular-nums">
            {user.noteCount}
          </span>{" "}
          notes
        </span>
        <span>
          <span className="font-medium text-(--color-foreground) tabular-nums">
            {user.patientCount}
          </span>{" "}
          patients
        </span>
        <span>
          <span className="font-medium text-(--color-foreground) tabular-nums">
            {user.recordingCount}
          </span>{" "}
          recordings
        </span>
        {user.lastNoteAt ? (
          <span>Last note {formatDate(user.lastNoteAt)}</span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {user.legalAcceptances.map((a) => (
          <LegalPill key={a.type} entry={a} />
        ))}
      </div>
    </Card>
    </Link>
  );
}

function LegalCell({
  entry,
}: {
  entry: UserRowProps["user"]["legalAcceptances"][number] | undefined;
}) {
  if (!entry) return <td className="px-3 py-3 text-xs">—</td>;
  return (
    <td className="px-3 py-3 text-xs">
      <LegalIndicator entry={entry} />
    </td>
  );
}

function LegalIndicator({
  entry,
}: {
  entry: UserRowProps["user"]["legalAcceptances"][number];
}) {
  if (entry.accepted) {
    return (
      <span className="inline-flex items-center gap-1 text-emerald-700">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
        v{entry.currentVersion}
        {entry.acceptedAt ? (
          <span className="text-(--color-muted-foreground)">
            · {formatDate(entry.acceptedAt)}
          </span>
        ) : null}
      </span>
    );
  }
  if (entry.acceptedVersion) {
    return (
      <span
        className="inline-flex items-center gap-1 text-amber-700"
        title="Accepted an older version — needs to re-accept current"
      >
        <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
        v{entry.acceptedVersion} (stale)
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-(--color-destructive)">
      <ShieldAlert className="h-3.5 w-3.5" aria-hidden="true" />
      Never accepted
    </span>
  );
}

function LegalPill({
  entry,
}: {
  entry: UserRowProps["user"]["legalAcceptances"][number];
}) {
  const tone = entry.accepted
    ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
    : entry.acceptedVersion
      ? "bg-amber-50 text-amber-800 ring-amber-200"
      : "bg-red-50 text-red-800 ring-red-200";
  const label = entry.accepted
    ? entry.type.toUpperCase()
    : entry.acceptedVersion
      ? `${entry.type.toUpperCase()} stale`
      : `${entry.type.toUpperCase()} ✗`;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}
    >
      {label}
    </span>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
