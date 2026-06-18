# Release plan — phases 1-33

Status of the local repo at the time of this audit: **35 phase commits sit between `main` and `feature/phase-33-athena-chart-notes`, none of them merged to `main` or pushed to `origin` past phase 18.** This document maps the wave so a merge / staged rollout can be planned without me re-reading every commit.

## Scope

- 35 commits total: phase 0c + phase 1 → phase 33, plus one test-mock fix (`f6de2e7`)
- Touches the entire HaloNote feature surface: encounters, billing, orders, tasks, multi-tenant, all AI features, EHR push for notes/orders/billing, streaming transcription, schedule polling, patient memory
- 351 files changed, mostly hand-written; substantial codegen output under `lib/api-zod/src/generated/` and `lib/api-client-react/src/generated/`
- 8 new migrations (0029 → 0036); see migrations section below

## What's already verified

- Full typecheck passes on the integration tip (`pnpm run typecheck`)
- Provider-app unit tests: 120/120 green
- api-server unit tests: 138/139 green — the 1 failure is `ehr-introspect.test.ts > throws OauthExchangeError on non-2xx without echoing body`, which is **pre-existing** (last changed in the snapshot commit before phase 1) and unrelated to the wave
- Integration tests (`pnpm run test:integration`) not run locally because `TEST_DATABASE_URL` isn't set — these need to run in CI before merge

## Highest-risk item — migration 0031

`lib/db/migrations/0031_switch_to_auto_push_mode.sql` replaces the boolean `auto_push_to_ehr` (added in 0029) with a text enum `auto_push_mode`. The migration:

```sql
ALTER TABLE "users" ADD COLUMN "auto_push_mode" text DEFAULT 'off' NOT NULL;
UPDATE "users" SET "auto_push_mode" = CASE WHEN "auto_push_to_ehr" THEN 'after_approve' ELSE 'off' END;
ALTER TABLE "users" DROP COLUMN "auto_push_to_ehr";
```

The three statements are separated by drizzle's `--> statement-breakpoint` markers, meaning **each runs in its own transaction**. There is a window between statements 2 and 3 where:

- App code still reading `auto_push_to_ehr` would see the value pre-change
- App code writing `auto_push_to_ehr = true` after step 2 but before step 3 would lose the write when the column drops

This is the standard "rename a column" anti-pattern done in one deploy. For a one-pilot-doctor practice the window is small (the migration runs in well under a second) but the bug shape is real. **Recommended mitigation**: split the migration across two deploys —

- Deploy A: 0031 with only the ADD + UPDATE statements; new code reads from both columns but writes to the new one
- Deploy B: 0031b with only the DROP statement, after Deploy A is stable in prod for a few hours

If a one-shot deploy is acceptable, run the migration during a brief maintenance window where no writes are happening. Phase 21 only shipped today (this session), so the realistic blast radius is small — the pilot doctor's row almost certainly has `auto_push_to_ehr=false` so the UPDATE is a no-op and there's no real data to lose.

## Other migrations (clean adds, low risk)

| Migration | Adds | Notes |
|---|---|---|
| 0029 | `users.auto_push_to_ehr` boolean | superseded by 0031 |
| 0030 | `users.silence_auto_stop_sec` integer | default 0, no behavior change |
| 0032 | `notes.auto_pushed_without_review` boolean | default false |
| 0033 | `provider_verbal_cues` table + `recording_jobs.live_transcript` text | new table |
| 0034 | `approved_orders.ehr_document_ref/ehr_error`, same on `approved_billing_codes` | clean adds |
| 0035 | `users.auto_push_orders/auto_push_medications` booleans | default false |
| 0036 | `patients.ehr_patient_id` text nullable | no backfill needed |

## Suggested merge order

Phases stack linearly — phase N branches off phase N-1 — so merging the integration tip into main is equivalent to applying the full wave in commit order. There's no value in merging each branch separately.

Recommended approach:

1. **Push every unpushed local branch to origin first** (15 branches, phases 19-33). This is purely a backup operation — these branches exist only on this laptop right now.
2. **Open a PR from `feature/phase-33-athena-chart-notes` to `main`** with this document as the description.
3. **Get code review on the wave by phase**, not by file — most phases are self-contained and reviewing them as logical units is much easier than reading 351 files of diff.
4. **Run integration tests in CI** with `TEST_DATABASE_URL` populated. The wave touches every route file at least once; the existing test suite covers the multi-tenant boundaries + audit log + auth flow.
5. **Stage migration 0031 carefully** per the mitigation above.
6. **Merge to main, deploy to a staging environment first**, watch for the pilot doctor's row migrating cleanly, then promote to prod.

## Risk callouts for the next deploy

These came up during the session and didn't get their own follow-up phases:

1. **Phase 23 auto-push-after-transcription** ships unreviewed AI-generated notes to the chart with a banner on the note page but **no admin-side audit view**. If a model drift incident happens, querying "which notes auto-shipped without review by user X today" requires hand-written SQL. Worth a small admin dashboard before this feature gets aggressive use.
2. **Phase 24-27 live LLM passes** stream transcript snapshots to Claude every 5 final lines per active visit. There is **no per-user rate limit and no cost ceiling**. A wedged client could rack up calls during one long visit. Recommend a simple rate gate + a Sentry-style cost alert.
3. **Phase 26/27 live billing + nudges** also bypass the audit log middleware — those calls fire from inside the streaming WebSocket bridge, which runs separately from Express. No `audit_log` row records what transcript was sent to Claude or what was returned. For HIPAA defensibility this is a gap.
4. **Phase 23/32 auto-push paths** require the local EHR client to be configured. In mock mode (the default) they "succeed" but post nothing. In prod with `EHR_MODE` unset, the same code path runs; the only thing protecting prod from silent mock-only auto-pushes is a per-deploy review of the env. Worth a startup check.
5. **Phase 33 `patients.ehr_patient_id`** is NULL for every existing row. Until a backfill runs, the chart-note pull does nothing for production patients — the feature ships but is dormant.

## What's NOT in this wave

Items that came up in the session but aren't shipped:

- **CDS warnings** (drug allergy / interaction) — the only patient-safety item from the original analytics multi-select that was never built. Recommended as the *single* next feature phase before any more conveniences.
- **Real-mode Athena/Epic wiring for order + billing push** — Phase 29 ships mock-mode push only; the real FHIR `MedicationRequest` / `ServiceRequest` / `Claim` POSTs are stubbed with a 501 in `ehr-push-order.ts` and `ehr-push-billing.ts`.
- **EncounterReview client migration** — Phase 28 backfilled the OpenAPI spec but didn't migrate the page from hand-rolled `customFetch` calls to the regenerated react-query hooks.
- **Backfill script for `patients.ehr_patient_id`** — Phase 33 added the column but didn't populate it for the existing roster.
