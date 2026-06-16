import { Check, ShieldAlert, ShieldCheck } from "lucide-react";
import {
  getGetLegalAgreementsQueryKey,
  useGetLegalAgreements,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";

// Read-only acceptance history for the signed-in provider. Surfaces
// what's on file (version + date) and flags any documents where the
// repo version has moved past the user's last acceptance — those rows
// will prompt for re-acceptance on next sign-in.
export function LegalSection() {
  const query = useGetLegalAgreements({
    query: { queryKey: getGetLegalAgreementsQueryKey() },
  });
  const agreements = query.data?.data ?? [];

  return (
    <section className="space-y-4">
      <header className="space-y-1">
        <h2 className="text-lg font-medium">Legal agreements</h2>
        <p className="text-sm text-(--color-muted-foreground)">
          Your acceptance history for the documents that govern your
          use of HaloNote. When a document is updated, you'll be
          prompted to re-accept on your next sign-in.
        </p>
      </header>

      <Card className="overflow-hidden">
        {query.isPending ? (
          <ul
            className="divide-y divide-(--color-border)"
            role="status"
            aria-label="Loading agreements"
          >
            {[0, 1, 2].map((i) => (
              <li key={i} className="space-y-2 px-4 py-4">
                <div className="h-4 w-1/3 animate-pulse rounded bg-(--color-muted)" />
                <div className="h-3 w-2/3 animate-pulse rounded bg-(--color-muted)" />
              </li>
            ))}
          </ul>
        ) : query.isError ? (
          <p
            role="alert"
            className="px-4 py-6 text-sm text-(--color-destructive)"
          >
            Couldn't load your legal acceptance history.
          </p>
        ) : (
          <ul
            className="divide-y divide-(--color-border)"
            aria-label="Legal agreements"
          >
            {agreements.map((a) => (
              <li key={a.type} className="flex items-start gap-3 px-4 py-4">
                <div
                  className={
                    a.accepted
                      ? "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-50 text-emerald-700"
                      : "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-700"
                  }
                  aria-hidden="true"
                >
                  {a.accepted ? (
                    <ShieldCheck className="h-4 w-4" />
                  ) : (
                    <ShieldAlert className="h-4 w-4" />
                  )}
                </div>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="font-medium text-(--color-foreground)">
                      {a.title}
                    </span>
                    <span className="text-xs text-(--color-muted-foreground)">
                      v{a.currentVersion}
                    </span>
                  </div>
                  {a.accepted && a.acceptedAt ? (
                    <p className="inline-flex items-center gap-1 text-sm text-(--color-muted-foreground)">
                      <Check
                        className="h-3.5 w-3.5 text-emerald-600"
                        aria-hidden="true"
                      />
                      Accepted{" "}
                      {new Date(a.acceptedAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </p>
                  ) : (
                    <p className="text-sm text-amber-800">
                      Action required — you'll be asked to accept the
                      current version on your next sign-in.
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </section>
  );
}
