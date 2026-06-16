import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Loader2,
  Plus,
  Sparkles,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  acceptLegalAgreements,
  completeOnboarding,
  getGetLegalAgreementsQueryKey,
  useCreateNoteDefault,
  useCreatePhraseMapping,
  useGetLegalAgreements,
  useListNoteDefaultSuggestions,
  useListNoteDefaults,
  useListPhraseMappings,
  getListNoteDefaultsQueryKey,
  getListPhraseMappingsQueryKey,
  type LegalAgreementStatus,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// 3-step first-run wizard. Lives at /onboarding; users land here
// after signup (or first sign-in for anyone whose
// `onboardingCompletedAt` is null). The auth state surfaces the flag
// via `user.onboardingCompleted`; RequireAuth in App.tsx redirects
// anyone without it. Skip / Finish both POST to
// /onboarding/complete so the flag flips and the redirect stops
// firing.
//
// Steps:
//   1. Welcome — orient the provider, set expectations.
//   2. Adopt suggested encounter defaults (ROS, vitals, exam).
//   3. Add a few personal phrase mappings (optional).
// Each step is a discrete state in `step`. We don't validate forward
// progress (users can skip any step), so a provider who's just here
// to dismiss the flow can hit "Skip" up top and land on the schedule.

type Step = 0 | 1 | 2 | 3;

export function OnboardingPage() {
  const { user, refresh } = useAuth();
  const [, navigate] = useLocation();
  // Step 0 (Agreements) is mandatory — `RequireAgreements` (below)
  // pins the page there until every required document is accepted.
  // Once accepted, Welcome → Defaults → Vocabulary proceeds normally.
  const agreementsQuery = useGetLegalAgreements();
  const agreements = agreementsQuery.data?.data ?? [];
  const allAccepted =
    agreements.length > 0 && agreements.every((a) => a.accepted);
  const [step, setStep] = useState<Step>(allAccepted ? 1 : 0);
  const [finishing, setFinishing] = useState(false);

  // Bounce up to step 1 once acceptance lands (covers the case where
  // the user re-accepts an updated version on a return visit).
  useEffect(() => {
    if (allAccepted && step === 0) setStep(1);
  }, [allAccepted, step]);

  async function finish() {
    setFinishing(true);
    try {
      await completeOnboarding();
      // Refresh local auth state so subsequent loads don't re-trigger
      // the redirect. Then navigate home.
      await refresh();
      navigate("/");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't finish onboarding",
      );
    } finally {
      setFinishing(false);
    }
  }

  // Greeting: if the display name leads with "Dr." (or another
  // honorific), use the full name so we don't end up greeting "Dr.".
  // Otherwise pull the first word as a first name.
  const greetingName = (() => {
    const dn = user?.displayName?.trim() ?? "";
    if (!dn) return "there";
    if (/^(dr\.?|mr\.?|mrs\.?|ms\.?|miss|prof\.?)\s/i.test(dn)) return dn;
    const first = dn.split(" ")[0];
    return first || dn;
  })();

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex items-center justify-between">
        <StepIndicator current={step} />
        {/* "Skip" is hidden on Step 0. The BAA is non-negotiable —
            users must accept all three agreements before they can
            move past the gate or even skip the rest. */}
        {step !== 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void finish()}
            disabled={finishing}
          >
            Skip for now
          </Button>
        ) : null}
      </div>

      {step === 0 ? (
        <AgreementsStep
          agreements={agreements}
          isPending={agreementsQuery.isPending}
          onAllAccepted={() => setStep(1)}
        />
      ) : step === 1 ? (
        <WelcomeStep
          greetingName={greetingName}
          onNext={() => setStep(2)}
        />
      ) : step === 2 ? (
        <DefaultsStep
          onBack={() => setStep(1)}
          onNext={() => setStep(3)}
        />
      ) : (
        <PhrasesStep
          onBack={() => setStep(2)}
          onFinish={() => void finish()}
          finishing={finishing}
        />
      )}
    </div>
  );
}

function StepIndicator({ current }: { current: Step }) {
  const steps: Array<{ id: Step; label: string }> = [
    { id: 0, label: "Agreements" },
    { id: 1, label: "Welcome" },
    { id: 2, label: "Defaults" },
    { id: 3, label: "Vocabulary" },
  ];
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="Onboarding steps">
      {steps.map((s, idx) => {
        const done = current > s.id;
        const active = current === s.id;
        return (
          <li key={s.id} className="flex items-center gap-2">
            <span
              className={
                done
                  ? "flex h-6 w-6 items-center justify-center rounded-full bg-(--color-primary) text-(--color-primary-foreground)"
                  : active
                    ? "flex h-6 w-6 items-center justify-center rounded-full bg-(--color-primary) text-(--color-primary-foreground)"
                    : "flex h-6 w-6 items-center justify-center rounded-full bg-(--color-muted) text-(--color-muted-foreground)"
              }
              aria-current={active ? "step" : undefined}
            >
              {done ? (
                <Check className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                s.id
              )}
            </span>
            <span
              className={
                active
                  ? "font-medium text-(--color-foreground)"
                  : "text-(--color-muted-foreground)"
              }
            >
              {s.label}
            </span>
            {idx < steps.length - 1 ? (
              <span
                aria-hidden="true"
                className="h-px w-4 bg-(--color-border) sm:w-6"
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function AgreementsStep({
  agreements,
  isPending,
  onAllAccepted,
}: {
  agreements: LegalAgreementStatus[];
  isPending: boolean;
  onAllAccepted: () => void;
}) {
  const queryClient = useQueryClient();
  // Local checkbox state — checked === "user has read and agrees".
  // Seeded from the server's `accepted` flag so a returning user who
  // already accepted everything (e.g. they reopened onboarding to
  // tweak a different step) doesn't have to click again.
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const a of agreements) init[a.type] = a.accepted;
    return init;
  });
  // When agreements arrive after mount, hydrate the checkbox state.
  useEffect(() => {
    if (agreements.length === 0) return;
    setChecked((prev) => {
      const next = { ...prev };
      for (const a of agreements) {
        if (next[a.type] === undefined) next[a.type] = a.accepted;
      }
      return next;
    });
  }, [agreements]);

  const [submitting, setSubmitting] = useState(false);
  const pending = useMemo(
    () => agreements.filter((a) => !a.accepted),
    [agreements],
  );
  const allChecked =
    agreements.length > 0 &&
    agreements.every((a) => a.accepted || checked[a.type]);

  async function submit() {
    setSubmitting(true);
    try {
      // Only submit the ones the user hasn't already accepted — the
      // server is idempotent but skipping unchanged rows keeps the
      // audit log free of duplicate "re-confirmed" entries.
      const toSubmit = pending.map((a) => ({
        type: a.type,
        version: a.currentVersion,
        contentHash: a.contentHash,
      }));
      if (toSubmit.length > 0) {
        await acceptLegalAgreements({ acceptances: toSubmit });
      }
      void queryClient.invalidateQueries({
        queryKey: getGetLegalAgreementsQueryKey(),
      });
      onAllAccepted();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't record acceptance",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (isPending) {
    return (
      <Card className="space-y-4 p-6 sm:p-8" role="status">
        <div className="h-6 w-2/3 animate-pulse rounded bg-(--color-muted)" />
        <div className="h-4 w-full animate-pulse rounded bg-(--color-muted)" />
        <div className="h-32 w-full animate-pulse rounded bg-(--color-muted)" />
        <div className="h-32 w-full animate-pulse rounded bg-(--color-muted)" />
      </Card>
    );
  }

  return (
    <Card className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">
          Before you start — please review and accept these agreements
        </h1>
        <p className="text-sm text-(--color-muted-foreground)">
          HaloNote can't process patient information until you accept
          the Business Associate Agreement, Terms of Service, and
          Privacy Policy. You can read the full text of each below.
        </p>
      </div>

      <ul className="space-y-4">
        {agreements.map((agreement) => (
          <li key={agreement.type}>
            <AgreementCard
              agreement={agreement}
              checked={Boolean(checked[agreement.type])}
              onToggle={(v) =>
                setChecked((prev) => ({ ...prev, [agreement.type]: v }))
              }
            />
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-(--color-border) pt-4">
        <Button
          size="lg"
          onClick={() => void submit()}
          disabled={!allChecked || submitting}
        >
          {submitting ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          {pending.length === 0
            ? "Continue"
            : `Accept and continue`}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </Card>
  );
}

function AgreementCard({
  agreement,
  checked,
  onToggle,
}: {
  agreement: LegalAgreementStatus;
  checked: boolean;
  onToggle: (value: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-lg border border-(--color-border) bg-(--color-card)">
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-base font-medium text-(--color-foreground)">
            {agreement.title}
            <span className="ml-2 text-xs font-normal text-(--color-muted-foreground)">
              v{agreement.currentVersion}
            </span>
          </h3>
          {agreement.accepted ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200">
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              On file
            </span>
          ) : null}
        </div>
        <p className="text-sm text-(--color-muted-foreground)">
          {agreement.summary}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="-mx-3"
        >
          {expanded ? "Hide full text" : "Read full text"}
        </Button>
        {expanded ? (
          <pre
            className="max-h-72 overflow-y-auto whitespace-pre-wrap rounded-md border border-(--color-border) bg-(--color-muted)/40 p-3 font-sans text-xs leading-relaxed text-(--color-foreground)"
            aria-label={`${agreement.title} full text`}
          >
            {agreement.body}
          </pre>
        ) : null}
      </div>
      <label
        className="flex cursor-pointer items-start gap-3 border-t border-(--color-border) bg-(--color-muted)/40 p-4 text-sm"
        htmlFor={`accept-${agreement.type}`}
      >
        <input
          id={`accept-${agreement.type}`}
          type="checkbox"
          className="mt-0.5 h-4 w-4 rounded border-(--color-border) accent-(--color-primary)"
          checked={checked}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span>
          I have read and agree to the{" "}
          <span className="font-medium">{agreement.title}</span>{" "}
          (version {agreement.currentVersion}).
        </span>
      </label>
    </div>
  );
}

function WelcomeStep({
  greetingName,
  onNext,
}: {
  greetingName: string;
  onNext: () => void;
}) {
  return (
    <Card className="space-y-6 p-6 sm:p-8">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-(--color-primary)/10">
        <Sparkles className="h-6 w-6 text-(--color-primary)" aria-hidden="true" />
      </div>
      <div className="space-y-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome to HaloNote, {greetingName}.
        </h1>
        <p className="text-(--color-muted-foreground)">
          HaloNote is an ambient AI scribe — record a visit, get a
          clinical note. The AI gets better the more you tune it to your
          practice.
        </p>
        <p className="text-(--color-muted-foreground)">
          We'll spend two minutes setting up your personalization so your
          first note already sounds like you wrote it.
        </p>
      </div>
      <ul className="space-y-2 text-sm">
        <li className="flex items-start gap-2">
          <Check
            className="h-4 w-4 shrink-0 translate-y-0.5 text-(--color-primary)"
            aria-hidden="true"
          />
          <span>
            <span className="font-medium">Encounter defaults</span> —
            assumptions baked into every note (ROS, vitals, exam).
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Check
            className="h-4 w-4 shrink-0 translate-y-0.5 text-(--color-primary)"
            aria-hidden="true"
          />
          <span>
            <span className="font-medium">Personal vocabulary</span> —
            when you say one phrase, document a different term.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Check
            className="h-4 w-4 shrink-0 translate-y-0.5 text-(--color-primary)"
            aria-hidden="true"
          />
          <span>
            <span className="font-medium">Writing style</span> — the AI
            learns your voice automatically as you write notes.
          </span>
        </li>
      </ul>
      <div className="flex justify-end">
        <Button size="lg" onClick={onNext}>
          Get started
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </Card>
  );
}

function DefaultsStep({
  onBack,
  onNext,
}: {
  onBack: () => void;
  onNext: () => void;
}) {
  const queryClient = useQueryClient();
  const suggestionsQuery = useListNoteDefaultSuggestions();
  const listQuery = useListNoteDefaults({
    query: { queryKey: getListNoteDefaultsQueryKey() },
  });
  const create = useCreateNoteDefault();

  const suggestions = suggestionsQuery.data?.data ?? [];
  const adopted = listQuery.data?.data ?? [];
  const adoptedLabels = new Set(adopted.map((d) => d.label.toLowerCase()));

  async function adopt(label: string, rule: string) {
    try {
      await create.mutateAsync({ data: { label, rule } });
      toast.success(`Added "${label}"`);
      void queryClient.invalidateQueries({
        queryKey: getListNoteDefaultsQueryKey(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    }
  }

  return (
    <Card className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">
          Pick your encounter defaults
        </h1>
        <p className="text-sm text-(--color-muted-foreground)">
          These are the assumptions the AI bakes into every note. The
          transcript always wins when it contradicts a default — these
          just fill in everything you don't explicitly cover.
        </p>
      </div>

      {suggestionsQuery.isPending ? (
        <ul className="space-y-2" role="status" aria-label="Loading suggestions">
          {[0, 1, 2].map((i) => (
            <li key={i}>
              <Card className="space-y-2 p-4">
                <div className="h-4 w-1/3 animate-pulse rounded bg-(--color-muted)" />
                <div className="h-3 w-3/4 animate-pulse rounded bg-(--color-muted)" />
              </Card>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="space-y-2">
          {suggestions.map((s) => {
            const isAdopted = adoptedLabels.has(s.label.toLowerCase());
            return (
              <li key={s.key}>
                <Card className="flex flex-wrap items-start justify-between gap-3 p-4">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="font-medium text-(--color-foreground)">
                      {s.label}
                    </div>
                    <p className="text-sm text-(--color-muted-foreground)">
                      {s.description ?? s.rule}
                    </p>
                  </div>
                  {isAdopted ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200">
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      Added
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void adopt(s.label, s.rule)}
                      disabled={create.isPending}
                    >
                      <Plus className="h-4 w-4" aria-hidden="true" />
                      Add
                    </Button>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-(--color-muted-foreground)">
        You can add, edit, or remove any of these later under Settings →
        Note defaults.
      </p>

      <div className="flex items-center justify-between gap-3">
        <Button variant="ghost" size="lg" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </Button>
        <Button size="lg" onClick={onNext}>
          Next
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </Card>
  );
}

function PhrasesStep({
  onBack,
  onFinish,
  finishing,
}: {
  onBack: () => void;
  onFinish: () => void;
  finishing: boolean;
}) {
  const queryClient = useQueryClient();
  const listQuery = useListPhraseMappings({
    query: { queryKey: getListPhraseMappingsQueryKey() },
  });
  const create = useCreatePhraseMapping();

  const [spoken, setSpoken] = useState("");
  const [documented, setDocumented] = useState("");

  const mappings = listQuery.data?.data ?? [];

  async function add() {
    const s = spoken.trim();
    const d = documented.trim();
    if (!s || !d) return;
    try {
      await create.mutateAsync({ data: { spoken: s, documented: d } });
      setSpoken("");
      setDocumented("");
      void queryClient.invalidateQueries({
        queryKey: getListPhraseMappingsQueryKey(),
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    }
  }

  return (
    <Card className="space-y-6 p-6 sm:p-8">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">
          Add personal vocabulary
        </h1>
        <p className="text-sm text-(--color-muted-foreground)">
          Optional — add the phrases you say in conversation and the
          terms you want in the documentation. Common examples:{" "}
          <span className="font-mono">tummy ache → abdominal pain</span>,{" "}
          <span className="font-mono">sugar → diabetes mellitus</span>.
        </p>
      </div>

      <div className="space-y-2 rounded-md border border-(--color-border) bg-(--color-muted)/40 p-4">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto_1fr]">
          <div className="space-y-1">
            <Label htmlFor="onb-spoken" className="text-xs">
              When I say
            </Label>
            <Input
              id="onb-spoken"
              value={spoken}
              onChange={(e) => setSpoken(e.target.value)}
              placeholder="tummy ache"
              disabled={create.isPending}
            />
          </div>
          <ArrowRight
            className="hidden self-end pb-2.5 text-(--color-muted-foreground) sm:block"
            aria-hidden="true"
          />
          <div className="space-y-1">
            <Label htmlFor="onb-documented" className="text-xs">
              Document as
            </Label>
            <Input
              id="onb-documented"
              value={documented}
              onChange={(e) => setDocumented(e.target.value)}
              placeholder="abdominal pain"
              disabled={create.isPending}
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={() => void add()}
            disabled={create.isPending || !spoken.trim() || !documented.trim()}
          >
            {create.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Plus className="h-4 w-4" aria-hidden="true" />
            )}
            Add
          </Button>
        </div>
      </div>

      {mappings.length > 0 ? (
        <div className="space-y-2">
          <div className="text-xs font-medium text-(--color-muted-foreground)">
            Added ({mappings.length})
          </div>
          <ul className="divide-y divide-(--color-border) rounded-md border border-(--color-border)">
            {mappings.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-baseline gap-2 px-3 py-2 text-sm"
              >
                <span className="font-medium">{m.spoken}</span>
                <ArrowRight
                  className="h-3.5 w-3.5 text-(--color-muted-foreground)"
                  aria-hidden="true"
                />
                <span className="text-(--color-muted-foreground)">
                  {m.documented}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-xs text-(--color-muted-foreground)">
        You can add more (and edit existing ones) any time under
        Settings → Personal vocabulary.
      </p>

      <div className="flex items-center justify-between gap-3">
        <Button
          variant="ghost"
          size="lg"
          onClick={onBack}
          disabled={finishing}
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back
        </Button>
        <Button size="lg" onClick={onFinish} disabled={finishing}>
          {finishing ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : null}
          Finish setup
          <Check className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </Card>
  );
}

