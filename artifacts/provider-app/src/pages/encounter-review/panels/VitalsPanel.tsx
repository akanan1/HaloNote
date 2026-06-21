// Vitals panel: AI-extracts structured vital signs from the note body
// and renders them as a grid with per-tile prior-visit comparison.
// Owns: extraction state, the vital-trends query (prior values), and
// the helpers that pick the most recent prior value per kind.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { extractVitals, fetchVitalTrends } from "../api";
import { CONFIDENCE_DOT } from "../constants";
import type {
  Note,
  VitalConfidence,
  VitalTrendRow,
  VitalsResponse,
} from "../types";

interface Props {
  note: Note | null;
  patientId: string;
}

export function VitalsPanel({ note, patientId }: Props) {
  const [vitals, setVitals] = useState<VitalsResponse | null>(null);
  const [busy, setBusy] = useState(false);

  // Pull prior persisted vitals for this patient so each tile can show
  // a "from 138/86 last visit" sublabel. Excludes the current note so
  // re-extracting doesn't compare a tile against itself. Falls back
  // silently to no comparison if the request fails — the panel still
  // works without trends.
  const trendsQuery = useQuery({
    queryKey: ["vital-trends", patientId, note?.id ?? null],
    queryFn: () => fetchVitalTrends(patientId, note?.id ?? ""),
    enabled: !!note,
    staleTime: 60_000,
  });

  if (!note) return null;

  const extract = async () => {
    setBusy(true);
    try {
      const v = await extractVitals(note.id);
      setVitals(v);
      const count = countExtractedVitals(v);
      if (count === 0) {
        toast.message(
          v.source === "ai"
            ? "No vitals documented in this note."
            : "AI is offline; stub returned no vitals.",
        );
      } else {
        toast.success(`Extracted ${count} vital${count === 1 ? "" : "s"}`);
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Couldn't extract vitals",
      );
    } finally {
      setBusy(false);
    }
  };

  const extractedCount = vitals ? countExtractedVitals(vitals) : 0;
  const priorByKind = derivePriorByKind(trendsQuery.data?.data ?? []);

  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Activity
            className="h-5 w-5 text-(--color-muted-foreground)"
            aria-hidden="true"
          />
          <h2 className="text-lg font-medium">Vitals</h2>
          {vitals ? (
            <span className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
              {vitals.source === "ai" ? "AI" : "stub"}
              {extractedCount > 0
                ? ` · ${extractedCount} value${extractedCount === 1 ? "" : "s"}`
                : ""}
            </span>
          ) : null}
        </div>
        <Button
          size="sm"
          variant={vitals ? "outline" : "default"}
          onClick={() => void extract()}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          )}
          {vitals ? "Re-extract" : "Extract vitals"}
        </Button>
      </div>
      {!vitals ? (
        <p className="text-sm text-(--color-muted-foreground)">
          Click to extract structured vital signs (BP, HR, temp, SpO₂…) from
          the note. Each value shows the verbatim source phrase so you can
          fact-check the extraction.
        </p>
      ) : extractedCount === 0 ? (
        <p className="rounded-md bg-(--color-muted)/30 px-3 py-2 text-sm text-(--color-muted-foreground)">
          {vitals.source === "ai"
            ? "No vitals were documented in this note."
            : "AI extractor is offline (ANTHROPIC_API_KEY not configured). No vitals returned."}
        </p>
      ) : (
        <VitalsGrid vitals={vitals} prior={priorByKind} />
      )}
    </Card>
  );
}

// One vital "kind" worth of prior-visit context: the formatted value
// (e.g. "138/86") + a friendly relative date ("last visit, 3 wks ago").
// The grid hands one of these to each tile that has a match.
interface PriorVital {
  display: string;
  when: string;
}

type PriorByKind = Partial<
  Record<
    | "bp"
    | "heartRate"
    | "respiratoryRate"
    | "temperatureF"
    | "spo2Percent"
    | "weightLbs"
    | "heightIn"
    | "bmi"
    | "pain",
    PriorVital
  >
>;

// Walk the trend rows newest-first and grab the first non-empty value
// for each vital kind. Different vitals may come from different prior
// visits — e.g. BP from 3 weeks ago but weight from 6 months ago — and
// each tile labels its own date so the provider isn't misled.
function derivePriorByKind(rows: VitalTrendRow[]): PriorByKind {
  const out: PriorByKind = {};
  for (const row of rows) {
    const v = row.extractedVitals;
    if (!v) continue;
    const when = formatRelativeDate(row.noteCreatedAt);
    if (!out.bp && v.bp) {
      out.bp = { display: `${v.bp.systolic}/${v.bp.diastolic}`, when };
    }
    if (!out.heartRate && v.heartRate) {
      out.heartRate = { display: String(v.heartRate.value), when };
    }
    if (!out.respiratoryRate && v.respiratoryRate) {
      out.respiratoryRate = { display: String(v.respiratoryRate.value), when };
    }
    if (!out.temperatureF && v.temperatureF) {
      out.temperatureF = { display: String(v.temperatureF.value), when };
    }
    if (!out.spo2Percent && v.spo2Percent) {
      out.spo2Percent = { display: String(v.spo2Percent.value), when };
    }
    if (!out.weightLbs && v.weightLbs) {
      out.weightLbs = { display: String(v.weightLbs.value), when };
    }
    if (!out.heightIn && v.heightIn) {
      out.heightIn = { display: String(v.heightIn.value), when };
    }
    if (!out.bmi && v.bmi) {
      out.bmi = { display: String(v.bmi.value), when };
    }
    if (!out.pain && v.pain && v.pain.score != null) {
      out.pain = { display: `${v.pain.score}/10`, when };
    }
  }
  return out;
}

// Human-readable "X ago" for tile sublabels. Kept inline rather than
// pulling in date-fns just for this one helper. The tile's title
// attribute will still carry the absolute date if the provider hovers.
function formatRelativeDate(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const days = Math.max(0, Math.round((now - then) / 86_400_000));
  if (days === 0) return "earlier today";
  if (days === 1) return "1 day ago";
  if (days < 14) return `${days} days ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 8) return `${weeks} wks ago`;
  const months = Math.round(days / 30);
  if (months < 18) return `${months} mo ago`;
  const years = Math.round(days / 365);
  return `${years} yr${years === 1 ? "" : "s"} ago`;
}

function countExtractedVitals(v: VitalsResponse): number {
  let n = 0;
  if (v.bp) n++;
  if (v.heartRate) n++;
  if (v.respiratoryRate) n++;
  if (v.temperatureF) n++;
  if (v.spo2Percent) n++;
  if (v.weightLbs) n++;
  if (v.heightIn) n++;
  if (v.bmi) n++;
  if (v.pain) n++;
  n += v.other.length;
  return n;
}

function VitalsGrid({
  vitals,
  prior,
}: {
  vitals: VitalsResponse;
  prior: PriorByKind;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      {vitals.bp ? (
        <VitalTile
          label="BP"
          value={`${vitals.bp.systolic}/${vitals.bp.diastolic}`}
          unit="mmHg"
          source={vitals.bp.source}
          confidence={vitals.bp.confidence}
          extra={vitals.bp.position ?? undefined}
          prior={prior.bp}
        />
      ) : null}
      {vitals.heartRate ? (
        <VitalTile
          label="HR"
          value={String(vitals.heartRate.value)}
          unit="bpm"
          source={vitals.heartRate.source}
          confidence={vitals.heartRate.confidence}
          prior={prior.heartRate}
        />
      ) : null}
      {vitals.respiratoryRate ? (
        <VitalTile
          label="RR"
          value={String(vitals.respiratoryRate.value)}
          unit="bpm"
          source={vitals.respiratoryRate.source}
          confidence={vitals.respiratoryRate.confidence}
          prior={prior.respiratoryRate}
        />
      ) : null}
      {vitals.temperatureF ? (
        <VitalTile
          label="Temp"
          value={String(vitals.temperatureF.value)}
          unit="°F"
          source={vitals.temperatureF.source}
          confidence={vitals.temperatureF.confidence}
          prior={prior.temperatureF}
        />
      ) : null}
      {vitals.spo2Percent ? (
        <VitalTile
          label="SpO₂"
          value={`${vitals.spo2Percent.value}`}
          unit="%"
          source={vitals.spo2Percent.source}
          confidence={vitals.spo2Percent.confidence}
          prior={prior.spo2Percent}
        />
      ) : null}
      {vitals.weightLbs ? (
        <VitalTile
          label="Weight"
          value={String(vitals.weightLbs.value)}
          unit="lbs"
          source={vitals.weightLbs.source}
          confidence={vitals.weightLbs.confidence}
          prior={prior.weightLbs}
        />
      ) : null}
      {vitals.heightIn ? (
        <VitalTile
          label="Height"
          value={String(vitals.heightIn.value)}
          unit="in"
          source={vitals.heightIn.source}
          confidence={vitals.heightIn.confidence}
          prior={prior.heightIn}
        />
      ) : null}
      {vitals.bmi ? (
        <VitalTile
          label="BMI"
          value={String(vitals.bmi.value)}
          unit=""
          source={vitals.bmi.source}
          confidence={vitals.bmi.confidence}
          prior={prior.bmi}
        />
      ) : null}
      {vitals.pain ? (
        <VitalTile
          label="Pain"
          value={vitals.pain.score != null ? `${vitals.pain.score}/10` : "—"}
          unit=""
          source={vitals.pain.source}
          confidence={vitals.pain.confidence}
          prior={prior.pain}
        />
      ) : null}
      {vitals.other.map((o, i) => (
        <VitalTile
          key={`${o.label}-${i}`}
          label={o.label}
          value={o.valueText}
          unit=""
          source={o.source}
          confidence="medium"
        />
      ))}
    </div>
  );
}

// Single vital "tile". Tabular numbers + confidence dot + verbatim
// source line below. title attribute carries the full source so a long
// quote isn't truncated invisibly.
function VitalTile({
  label,
  value,
  unit,
  source,
  confidence,
  extra,
  prior,
}: {
  label: string;
  value: string;
  unit: string;
  source: string;
  confidence: VitalConfidence;
  extra?: string;
  prior?: PriorVital;
}) {
  return (
    <div className="rounded-md border border-(--color-border) bg-(--color-card) p-3">
      <div className="flex items-start justify-between gap-1">
        <p className="text-xs uppercase tracking-wide text-(--color-muted-foreground)">
          {label}
        </p>
        <span
          aria-label={`Confidence: ${confidence}`}
          title={`Confidence: ${confidence}`}
          className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${CONFIDENCE_DOT[confidence]}`}
        />
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <p className="text-xl font-semibold tabular-nums">{value}</p>
        {unit ? (
          <p className="text-xs text-(--color-muted-foreground)">{unit}</p>
        ) : null}
      </div>
      {extra ? (
        <p className="text-xs text-(--color-muted-foreground)">{extra}</p>
      ) : null}
      {prior ? (
        <p
          className="mt-0.5 text-xs text-(--color-muted-foreground)"
          title={`Prior recorded value: ${prior.display} (${prior.when})`}
        >
          <span className="tabular-nums">{prior.display}</span>{" "}
          <span className="opacity-70">· {prior.when}</span>
        </p>
      ) : null}
      <p
        className="mt-1 truncate text-xs italic text-(--color-muted-foreground)"
        title={source}
      >
        &ldquo;{source}&rdquo;
      </p>
    </div>
  );
}
