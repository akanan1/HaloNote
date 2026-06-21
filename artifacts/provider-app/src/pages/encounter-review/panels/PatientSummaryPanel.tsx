// Patient summary panel: multilingual handout generator. Provider
// picks a language, clicks Generate, then can copy-as-text or invoke
// the browser print dialog. Print styling lives in index.css under
// body.print-mode-summary; this component toggles that class.

import { useState } from "react";
import { FileText, Loader2, Printer, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { generatePatientSummary } from "../api";
import { LANGUAGE_OPTIONS } from "../constants";
import type {
  Encounter,
  Note,
  Patient,
  PatientSummary,
  SummaryLanguage,
} from "../types";

interface Props {
  note: Note | null;
  patient: Patient | null;
  encounter: Encounter | null;
}

export function PatientSummaryPanel({ note, patient, encounter }: Props) {
  // Summary lives in panel state (not persisted) so it clears on
  // remount. Re-running is cheap; v2 will persist + offer PDF / portal
  // export from the same surface.
  const [summary, setSummary] = useState<PatientSummary | null>(null);
  const [busy, setBusy] = useState(false);
  // Selected language. Defaults to English; the provider switches via the
  // dropdown before clicking Generate. Changing language after a generation
  // doesn't auto-regenerate — provider clicks Regenerate to commit.
  const [language, setLanguage] = useState<SummaryLanguage>("en");

  // Don't show the panel until there's a note to summarize. Empty
  // encounter renders cleaner without it.
  if (!note) return null;

  const generate = async () => {
    setBusy(true);
    try {
      const s = await generatePatientSummary(note.id, language);
      setSummary(s);
      toast.success(
        s.source === "ai"
          ? "Patient summary generated"
          : "Patient summary generated (stub)",
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't generate summary",
      );
    } finally {
      setBusy(false);
    }
  };

  const copyAsText = async () => {
    if (!summary) return;
    const text = summaryAsPlainText(summary);
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Couldn't copy");
    }
  };

  // Print flow: toggle a body class the print stylesheet matches against,
  // call window.print(), and clean up on the afterprint event so the
  // class doesn't linger if the user cancels the dialog. The print CSS
  // in index.css hides everything except .print-summary-root so the
  // page renders as a clean handout.
  const print = () => {
    if (!summary) return;
    document.body.classList.add("print-mode-summary");
    const cleanup = () => {
      document.body.classList.remove("print-mode-summary");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    // Slight delay so the class change paints before the print dialog
    // captures the layout. Without this, Chrome occasionally renders
    // the page with the old layout on the first print.
    setTimeout(() => window.print(), 50);
  };

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileText
            className="h-5 w-5 text-(--color-muted-foreground)"
            aria-hidden="true"
          />
          <h2 className="text-lg font-medium">Patient summary</h2>
          {summary ? (
            <span className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
              {summary.source === "ai" ? "AI" : "stub"}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={language}
            onChange={(e) => setLanguage(e.target.value as SummaryLanguage)}
            aria-label="Summary language"
            disabled={busy}
            className="h-8 rounded-md border border-(--color-border) bg-(--color-card) px-2 text-xs"
          >
            {LANGUAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {summary ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => void copyAsText()}>
                Copy
              </Button>
              <Button size="sm" variant="ghost" onClick={print}>
                <Printer className="h-4 w-4" aria-hidden="true" />
                Print
              </Button>
            </>
          ) : null}
          <Button
            size="sm"
            variant={summary ? "outline" : "default"}
            onClick={() => void generate()}
            disabled={busy}
          >
            {busy ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            )}
            {summary ? "Regenerate" : "Generate"}
          </Button>
        </div>
      </div>
      {!summary ? (
        <p className="text-sm text-(--color-muted-foreground)">
          Generate a 6th-grade reading-level handout the patient can take home,
          send via portal, or read in the room before leaving.
        </p>
      ) : (
        <SummaryDisplay
          summary={summary}
          patient={patient}
          encounter={encounter}
        />
      )}
    </Card>
  );
}

function SummaryDisplay({
  summary,
  patient,
  encounter,
}: {
  summary: PatientSummary;
  patient: Patient | null;
  encounter: Encounter | null;
}) {
  // Visit date for the print header. Prefer the encounter's started/
  // completed timestamps, fall back to today so the handout always
  // shows a date even when an encounter has no started_at yet.
  const visitDate = encounter?.completedAt
    ? new Date(encounter.completedAt)
    : encounter?.startedAt
      ? new Date(encounter.startedAt)
      : encounter?.scheduledAt
        ? new Date(encounter.scheduledAt)
        : new Date();
  const visitDateLabel = visitDate.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const patientFullName = patient
    ? `${patient.firstName} ${patient.lastName}`
    : "Patient";

  return (
    // print-summary-root is what the print stylesheet keeps visible —
    // everything else on the page gets display:none under
    // body.print-mode-summary. The screen rendering ignores the
    // print-only header / footer via Tailwind print: variants.
    <article className="print-summary-root space-y-4 rounded-md border border-(--color-border) bg-(--color-card) p-4">
      {/* Print-only handout banner. Hidden on screen, becomes a
          paper-style title block at the top of the printout. */}
      <header className="print-summary-header hidden print:block">
        <h1>Your visit summary</h1>
        <p>
          {patientFullName} · {visitDateLabel}
        </p>
      </header>

      <p className="text-sm leading-relaxed">{summary.overview}</p>

      {summary.diagnoses.length > 0 ? (
        <section className="print-summary-section space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground) print:hidden">
            What we found
          </h3>
          <h2 className="hidden print:block">What we found</h2>
          <ul className="space-y-2">
            {summary.diagnoses.map((d, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium">{d.name}.</span>{" "}
                <span className="text-(--color-muted-foreground) print:text-black">
                  {d.explanation}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {summary.medications.length > 0 ? (
        <section className="print-summary-section space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground) print:hidden">
            Your medicines
          </h3>
          <h2 className="hidden print:block">Your medicines</h2>
          <ul className="space-y-2">
            {summary.medications.map((m, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium">{m.name}</span> — {m.howToTake}
                <p className="text-xs italic text-(--color-muted-foreground) print:text-black">
                  Why: {m.why}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {summary.selfCare.length > 0 ? (
        <section className="print-summary-section space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground) print:hidden">
            How to take care of yourself at home
          </h3>
          <h2 className="hidden print:block">
            How to take care of yourself at home
          </h2>
          <ul className="list-inside list-disc space-y-1 text-sm">
            {summary.selfCare.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {summary.followUp ? (
        <section className="print-summary-section space-y-1">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-(--color-muted-foreground) print:hidden">
            Coming back
          </h3>
          <h2 className="hidden print:block">Coming back</h2>
          <p className="text-sm">
            <span className="font-medium">{summary.followUp.when}.</span>{" "}
            {summary.followUp.why}
          </p>
        </section>
      ) : null}

      {summary.whenToCall.length > 0 ? (
        // print-summary-warning gets a colored box + break-inside:avoid
        // in the print CSS so the warnings stay together on the page.
        <section className="print-summary-warning space-y-2 rounded-md bg-red-50 p-3 ring-1 ring-inset ring-red-200">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-red-900 print:hidden">
            Call us right away if…
          </h3>
          <h2 className="hidden text-red-900 print:block">
            Call us right away if…
          </h2>
          <ul className="list-inside list-disc space-y-1 text-sm text-red-900">
            {summary.whenToCall.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Print-only footer. Identifies the document as auto-generated +
          sign-off line for the provider. Hidden on screen. */}
      <footer className="print-summary-footer hidden print:block">
        <p>
          Generated from your visit notes. If anything is unclear, please call
          our office.
        </p>
      </footer>
    </article>
  );
}

// Plain-text serializer for the copy-to-clipboard button. Mirrors the
// rendered structure so a patient pasting it into a portal message
// (or print preview) sees the same sections in the same order.
function summaryAsPlainText(s: PatientSummary): string {
  const lines: string[] = [s.overview, ""];
  if (s.diagnoses.length > 0) {
    lines.push("WHAT WE FOUND");
    for (const d of s.diagnoses) lines.push(`• ${d.name}. ${d.explanation}`);
    lines.push("");
  }
  if (s.medications.length > 0) {
    lines.push("YOUR MEDICINES");
    for (const m of s.medications) {
      lines.push(`• ${m.name} — ${m.howToTake}`);
      lines.push(`  Why: ${m.why}`);
    }
    lines.push("");
  }
  if (s.selfCare.length > 0) {
    lines.push("HOW TO TAKE CARE OF YOURSELF AT HOME");
    for (const c of s.selfCare) lines.push(`• ${c}`);
    lines.push("");
  }
  if (s.followUp) {
    lines.push("COMING BACK");
    lines.push(`${s.followUp.when}. ${s.followUp.why}`);
    lines.push("");
  }
  if (s.whenToCall.length > 0) {
    lines.push("CALL US RIGHT AWAY IF…");
    for (const w of s.whenToCall) lines.push(`• ${w}`);
  }
  return lines.join("\n").trim();
}
