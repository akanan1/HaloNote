import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  Loader2,
  Mail,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import {
  getGetFounderUserDetailQueryKey,
  requireUserReaccept,
  useGetFounderUserDetail,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Sparkline } from "@/components/Sparkline";

interface Props {
  userId: string;
}

// Drill-down for a single user from the Founder dashboard. Two
// sections:
//   1. Header summary — name, email, role/founder, activity rollups.
//   2. Full acceptance trail — every row of `legal_acceptances` for
//      this user, newest first, with version + content hash + IP +
//      user agent. This is the page the founder shares with their
//      compliance auditor.
export function FounderUserDetailPage({ userId }: Props) {
  const queryClient = useQueryClient();
  const query = useGetFounderUserDetail(userId);
  const [reaccepting, setReaccepting] = useState(false);

  async function handleForceReaccept(displayName: string) {
    if (
      !window.confirm(
        `Force ${displayName} to re-accept the legal agreements on their next sign-in? The existing acceptance history stays on file.`,
      )
    ) {
      return;
    }
    setReaccepting(true);
    try {
      await requireUserReaccept(userId);
      void queryClient.invalidateQueries({
        queryKey: getGetFounderUserDetailQueryKey(userId),
      });
      toast.success("Re-acceptance required on next sign-in.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't apply");
    } finally {
      setReaccepting(false);
    }
  }

  if (query.isPending) {
    return (
      <div className="space-y-6">
        <BackLink />
        <Card className="space-y-2 p-6">
          <div className="h-6 w-1/2 animate-pulse rounded bg-(--color-muted)" />
          <div className="h-4 w-1/3 animate-pulse rounded bg-(--color-muted)" />
        </Card>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="space-y-6">
        <BackLink />
        <p
          role="alert"
          className="text-sm text-(--color-destructive)"
        >
          Couldn't load user detail.
        </p>
      </div>
    );
  }

  const { user, acceptances, dailySeries } = query.data;

  return (
    <div className="space-y-8">
      <BackLink />

      <Card className="relative overflow-hidden p-6">
        <span
          aria-hidden="true"
          className="absolute inset-y-0 left-0 w-1 bg-(--color-primary)"
        />
        <div className="space-y-3 pl-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">
                {user.displayName}
              </h1>
              <p className="inline-flex items-center gap-1.5 text-sm text-(--color-muted-foreground)">
                <Mail className="h-3.5 w-3.5" aria-hidden="true" />
                {user.email}
              </p>
            </div>
            <div className="text-xs">
              {user.role}
              {user.isFounder ? (
                <span className="ml-1 rounded bg-(--color-primary)/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-(--color-primary)">
                  founder
                </span>
              ) : null}
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <Stat label="Notes" value={user.noteCount} />
            <Stat label="Patients" value={user.patientCount} />
            <Stat label="Recordings" value={user.recordingCount} />
            <Stat
              label="Signed up"
              value={formatDate(user.createdAt)}
              raw
            />
            {user.lastNoteAt ? (
              <Stat
                label="Last note"
                value={formatDate(user.lastNoteAt)}
                raw
              />
            ) : null}
          </dl>
        </div>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted-foreground)">
          Activity · last {dailySeries.notes.length} days
        </h2>
        <div className="grid grid-cols-3 gap-3">
          <SeriesCard label="Notes" series={dailySeries.notes} />
          <SeriesCard label="Recordings" series={dailySeries.recordings} />
          <SeriesCard label="Patients" series={dailySeries.patients} />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted-foreground)">
            Current acceptance status
          </h2>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void handleForceReaccept(user.displayName)}
            disabled={reaccepting}
            className="text-(--color-destructive)"
          >
            {reaccepting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <ShieldX className="h-4 w-4" aria-hidden="true" />
            )}
            Force re-accept
          </Button>
        </div>
        <Card className="overflow-hidden">
          <ul className="divide-y divide-(--color-border)">
            {user.legalAcceptances.map((entry) => (
              <li
                key={entry.type}
                className="flex items-start gap-3 px-4 py-4"
              >
                <div
                  className={
                    entry.accepted
                      ? "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700"
                      : entry.acceptedVersion
                        ? "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-700"
                        : "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-700"
                  }
                  aria-hidden="true"
                >
                  {entry.accepted ? (
                    <ShieldCheck className="h-4 w-4" />
                  ) : (
                    <ShieldAlert className="h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium uppercase tracking-wide">
                      {entry.type}
                    </span>
                    <span className="text-xs text-(--color-muted-foreground)">
                      Current v{entry.currentVersion}
                    </span>
                  </div>
                  {entry.accepted ? (
                    <p className="text-sm text-(--color-muted-foreground)">
                      Accepted v{entry.currentVersion} on{" "}
                      {formatDateTime(entry.acceptedAt!)}
                    </p>
                  ) : entry.acceptedVersion ? (
                    <p className="text-sm text-amber-800">
                      Last accepted v{entry.acceptedVersion} —{" "}
                      needs to re-accept v{entry.currentVersion}
                    </p>
                  ) : (
                    <p className="text-sm text-(--color-destructive)">
                      Never accepted any version
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-(--color-muted-foreground)">
          Full acceptance history ({acceptances.length})
        </h2>
        {acceptances.length === 0 ? (
          <Card className="p-6 text-center text-sm text-(--color-muted-foreground)">
            No acceptances on file. This user hasn't completed
            onboarding yet.
          </Card>
        ) : (
          <Card className="overflow-hidden">
            <ul
              className="divide-y divide-(--color-border)"
              aria-label="Acceptance history"
            >
              {acceptances.map((a, i) => (
                <li key={`${a.type}-${i}`} className="space-y-1 px-4 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="space-x-2 text-sm">
                      <span className="font-medium uppercase tracking-wide">
                        {a.type}
                      </span>
                      <span className="text-(--color-muted-foreground)">
                        v{a.version}
                      </span>
                    </div>
                    <span className="font-mono text-xs text-(--color-muted-foreground)">
                      {formatDateTime(a.acceptedAt)}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[11px] text-(--color-muted-foreground)">
                    {a.ipAddress ? <span>IP: {a.ipAddress}</span> : null}
                    {a.userAgent ? (
                      <span className="truncate">
                        UA: {a.userAgent.slice(0, 80)}
                      </span>
                    ) : null}
                    <span title={a.contentHash}>
                      hash: {a.contentHash.slice(0, 16)}…
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}

function SeriesCard({
  label,
  series,
}: {
  label: string;
  series: Array<{ date: string; count: number }>;
}) {
  const total = series.reduce((acc, d) => acc + d.count, 0);
  return (
    <Card className="space-y-1 p-3">
      <div className="text-xs text-(--color-muted-foreground)">{label}</div>
      <div className="text-2xl font-semibold tabular-nums">{total}</div>
      <div className="text-(--color-primary)">
        <Sparkline
          data={series}
          width={140}
          height={28}
          ariaLabel={`${label} trend`}
        />
      </div>
    </Card>
  );
}

function Stat({
  label,
  value,
  raw,
}: {
  label: string;
  value: string | number;
  raw?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs text-(--color-muted-foreground)">{label}</dt>
      <dd
        className={
          raw
            ? "text-sm font-medium text-(--color-foreground)"
            : "text-xl font-semibold tabular-nums text-(--color-foreground)"
        }
      >
        {value}
      </dd>
    </div>
  );
}

function BackLink() {
  return (
    <div>
      <Link
        href="/founder"
        className="inline-flex items-center gap-1.5 text-sm text-(--color-muted-foreground) hover:text-(--color-foreground)"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back to Founder
      </Link>
    </div>
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

function formatDateTime(iso: string): string {
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
