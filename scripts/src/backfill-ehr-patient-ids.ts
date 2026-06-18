// Phase 34 backfill: populate `patients.ehr_patient_id` for rows that
// pre-date Phase 33 (when the column was added). Without this column,
// the recording pipeline silently skips the prior-chart-note fetch in
// artifacts/api-server/src/lib/recording-pipeline.ts — every existing
// patient is invisible to the new feature.
//
// Approach: page through `patients`, skip rows already populated, and
// for each remaining row look the patient up in Athena by MRN
// (`Patient?identifier=MR|<mrn>`). Persist the EHR-side Patient.id with
// an UPDATE.
//
// Run (dev / dry-run):
//   pnpm --filter @workspace/scripts run backfill-ehr-patient-ids -- --dry-run
//
// Run (scoped to one org, capped batch):
//   pnpm --filter @workspace/scripts run backfill-ehr-patient-ids -- \
//     --org=org_abc123 --limit=50
//
// Run (full backfill, writes):
//   pnpm --filter @workspace/scripts run backfill-ehr-patient-ids
//
// ─── HIPAA / PHI rules ────────────────────────────────────────────────
// Per the pino redact policy in artifacts/api-server/src/lib/logger.ts,
// we never log MRN, name, or DOB. Per-row signal uses the local
// patient.id only (a non-PHI surrogate). Upstream FHIR error bodies are
// not echoed — only HTTP status / error name. Counts and outcomes are
// safe to log freely.
//
// ─── Mock mode ────────────────────────────────────────────────────────
// When EHR_MODE is unset (the default for local dev), there is no real
// Athena to query. We synthesize `ehr_patient_id = patient.id` so dev
// seeds still flow through the Phase 33 code path deterministically.
// This matches the pattern already used in
// artifacts/api-server/src/lib/patient-sync.ts (mock branch).
// ──────────────────────────────────────────────────────────────────────

import {
  FhirError,
  type Bundle,
  type Patient as FhirPatient,
} from "@workspace/ehr";
import { createAthenahealthClient } from "@workspace/ehr/athenahealth";
import pg from "pg";

interface Args {
  dryRun: boolean;
  orgId: string | undefined;
  limit: number | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  let dryRun = false;
  let orgId: string | undefined;
  let limit: number | undefined;
  for (const arg of argv) {
    if (arg === "--") {
      // pnpm forwards a literal `--` separator when invoked as
      // `pnpm run <script> -- --flag`. Treat it as a no-op so the
      // documented invocation actually works.
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg.startsWith("--org=")) {
      const v = arg.slice("--org=".length).trim();
      if (v) orgId = v;
    } else if (arg.startsWith("--limit=")) {
      const raw = arg.slice("--limit=".length).trim();
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--limit must be a positive integer (got "${raw}")`);
      }
      limit = n;
    } else if (arg === "--help" || arg === "-h") {
      printUsageAndExit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { dryRun, orgId, limit };
}

function printUsageAndExit(code: number): never {
  console.log(
    [
      "Usage: backfill-ehr-patient-ids [--dry-run] [--org=<orgId>] [--limit=<n>]",
      "",
      "  --dry-run      Don't write; just log what would change.",
      "  --org=<orgId>  Restrict the backfill to a single organization.",
      "  --limit=<n>    Process at most n eligible rows (cautious staging).",
    ].join("\n"),
  );
  process.exit(code);
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

function resolveProvider(): "athenahealth" | "mock" {
  // Epic + Cerner backfill paths aren't in scope for Phase 34 — every
  // pilot customer using a non-Athena EHR onboarded after the
  // ehr_patient_id column existed, so there are no rows to backfill.
  // If/when that changes, add a branch here.
  const mode = process.env["EHR_MODE"]?.trim().toLowerCase();
  if (mode === "athenahealth") return "athenahealth";
  return "mock";
}

const BATCH_SIZE = 100;

interface PatientRow {
  id: string;
  organization_id: string;
  mrn: string;
}

interface Counters {
  scanned: number;
  alreadySet: number; // (counted in SQL, but tracked here for clarity)
  succeeded: number;
  notFound: number;
  errored: number;
  skippedLimit: number;
}

// Pull the next page of patients still missing ehr_patient_id. Uses
// keyset pagination on the primary key so concurrent writes (e.g. a
// fresh /patients/sync mid-run) don't shift the offset under us.
async function fetchBatch(
  client: pg.Client,
  args: Args,
  afterId: string | null,
  batchSize: number,
): Promise<PatientRow[]> {
  const conditions: string[] = ["ehr_patient_id IS NULL"];
  const params: unknown[] = [];
  if (args.orgId) {
    params.push(args.orgId);
    conditions.push(`organization_id = $${params.length}`);
  }
  if (afterId) {
    params.push(afterId);
    conditions.push(`id > $${params.length}`);
  }
  params.push(batchSize);
  const limitParam = `$${params.length}`;
  const sql =
    `SELECT id, organization_id, mrn FROM patients ` +
    `WHERE ${conditions.join(" AND ")} ` +
    `ORDER BY id ASC LIMIT ${limitParam}`;
  const result = await client.query<PatientRow>(sql, params);
  return result.rows;
}

type LookupOutcome =
  | { kind: "found"; ehrPatientId: string }
  | { kind: "not-found" }
  | { kind: "error"; reason: string };

interface Lookup {
  (mrn: string): Promise<LookupOutcome>;
}

// Build an Athena-backed lookup. Uses the 2-legged client_credentials
// flow via getAthenahealthClient()-equivalent config — this is a batch
// op, no per-user SMART context is available or needed.
function buildAthenaLookup(): Lookup {
  const client = createAthenahealthClient({
    fhirBaseUrl: required("ATHENA_FHIR_BASE_URL"),
    tokenUrl: required("ATHENA_TOKEN_URL"),
    clientId: required("ATHENA_CLIENT_ID"),
    clientSecret: required("ATHENA_CLIENT_SECRET"),
    scope: process.env["ATHENA_SCOPE"],
  });
  return async (mrn) => {
    try {
      // FHIR identifier token search: `MR|<mrn>` constrains to the
      // MR-coded slot, which is what Athena uses for the practice MRN.
      // The leading `MR|` keeps us from matching a row whose only
      // identifier of value `<mrn>` is, say, an SSN or driver's-license
      // number — a wrong-patient risk we must not ship.
      const bundle = await client.fhir.search<FhirPatient>("Patient", {
        identifier: `MR|${mrn}`,
      });
      const candidates = collectPatientIds(bundle);
      if (candidates.length === 0) return { kind: "not-found" };
      if (candidates.length > 1) {
        // Ambiguous match — don't guess. The MRN is supposed to be
        // unique within a practice; if Athena returns multiple it's
        // either a duplicate-chart issue on their side or a cross-
        // practice search that needs ah-practice scoping the caller
        // hasn't supplied. Either way, escalate to a human.
        return {
          kind: "error",
          reason: `ambiguous: ${candidates.length} matches`,
        };
      }
      const id = candidates[0];
      if (!id) return { kind: "not-found" };
      return { kind: "found", ehrPatientId: id };
    } catch (err) {
      if (err instanceof FhirError) {
        if (err.status === 404) return { kind: "not-found" };
        return { kind: "error", reason: `FhirError status=${err.status}` };
      }
      const name = err instanceof Error ? err.name : typeof err;
      return { kind: "error", reason: String(name) };
    }
  };
}

function collectPatientIds(bundle: Bundle<FhirPatient>): string[] {
  const ids: string[] = [];
  for (const entry of bundle.entry ?? []) {
    const p = entry.resource;
    if (p?.resourceType !== "Patient") continue;
    if (p.id) ids.push(p.id);
  }
  return ids;
}

// Mock lookup: deterministic, no network. The synthesized id is the
// local patient.id, mirroring the mock branch in patient-sync.ts.
function buildMockLookup(): Lookup {
  return async (_mrn: string) => {
    // Caller passes us the local id via closure trick? Simpler: signal
    // "use the row id" by returning a sentinel. We do that by returning
    // a not-found here and special-casing mock mode in main(). That
    // keeps the Lookup contract honest (lookup is by MRN only).
    return { kind: "not-found" };
  };
}

async function updateRow(
  client: pg.Client,
  rowId: string,
  ehrPatientId: string,
): Promise<void> {
  await client.query(
    `UPDATE patients SET ehr_patient_id = $1 WHERE id = $2 AND ehr_patient_id IS NULL`,
    [ehrPatientId, rowId],
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = resolveProvider();

  const databaseUrl = required("DATABASE_URL");
  const pgClient = new pg.Client({ connectionString: databaseUrl });
  await pgClient.connect();

  const counters: Counters = {
    scanned: 0,
    alreadySet: 0,
    succeeded: 0,
    notFound: 0,
    errored: 0,
    skippedLimit: 0,
  };

  // In mock mode we don't construct an Athena client at all (the env
  // may not even be set in dev). The mock lookup is unused; we short-
  // circuit in the loop below.
  const lookup: Lookup =
    provider === "athenahealth" ? buildAthenaLookup() : buildMockLookup();

  console.log(
    `[backfill] provider=${provider} dryRun=${args.dryRun}` +
      ` org=${args.orgId ?? "<all>"} limit=${args.limit ?? "<none>"}`,
  );

  try {
    let cursor: string | null = null;
    // Keyset pagination; loop until a page comes back short or we hit
    // the user-supplied --limit.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const remaining =
        args.limit !== undefined
          ? Math.max(0, args.limit - counters.scanned)
          : BATCH_SIZE;
      if (args.limit !== undefined && remaining === 0) break;
      const pageSize = Math.min(BATCH_SIZE, remaining);
      const rows = await fetchBatch(pgClient, args, cursor, pageSize);
      if (rows.length === 0) break;

      for (const row of rows) {
        counters.scanned += 1;
        // Decide what id to write.
        let outcome: LookupOutcome;
        if (provider === "mock") {
          // Deterministic dev seeding: reuse the local id.
          outcome = { kind: "found", ehrPatientId: row.id };
        } else {
          outcome = await lookup(row.mrn);
        }

        if (outcome.kind === "found") {
          if (args.dryRun) {
            console.log(
              `[backfill] would-update id=${row.id} (provider=${provider})`,
            );
          } else {
            await updateRow(pgClient, row.id, outcome.ehrPatientId);
            console.log(`[backfill] updated id=${row.id}`);
          }
          counters.succeeded += 1;
        } else if (outcome.kind === "not-found") {
          console.log(`[backfill] not-found id=${row.id}`);
          counters.notFound += 1;
        } else {
          console.log(`[backfill] error id=${row.id} reason=${outcome.reason}`);
          counters.errored += 1;
        }
      }

      // Advance cursor past the last row of this page. We page on `id`
      // ASC and the WHERE clause already excludes rows we've just
      // populated, so successful updates naturally drop out of the
      // next page without needing to re-anchor the cursor.
      const last = rows[rows.length - 1];
      if (!last) break;
      cursor = last.id;

      if (rows.length < pageSize) break;
    }
  } finally {
    await pgClient.end();
  }

  console.log("");
  console.log("[backfill] summary:");
  console.log(`  scanned    : ${counters.scanned}`);
  console.log(`  succeeded  : ${counters.succeeded}${args.dryRun ? " (dry-run, no writes)" : ""}`);
  console.log(`  not-found  : ${counters.notFound}`);
  console.log(`  errored    : ${counters.errored}`);
}

main().catch((err: unknown) => {
  const msg =
    err instanceof Error
      ? `${err.name}: ${err.message}`
      : `non-Error thrown (typeof=${typeof err})`;
  // Never `console.error(err)` directly — FhirError-like upstream errors
  // can carry PHI in rawBody/outcome. Stick to the safe shape.
  console.error(`[backfill] fatal: ${msg}`);
  process.exit(1);
});
