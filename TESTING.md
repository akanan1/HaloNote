# Testing

## Unit tests

```
pnpm run test
```

Vitest across every workspace package. No external dependencies — runs
clean on a fresh clone with `pnpm install`.

## Integration tests

Require `TEST_DATABASE_URL` pointing at a **separate** Postgres database
from your dev DB. The harness TRUNCATEs all tables between test files;
pointing it at your dev DB would wipe your data.

```
pnpm run test:integration
```

The harness applies Drizzle migrations against `TEST_DATABASE_URL` on
first run.

### Option A — Docker Postgres (recommended for local dev)

Smallest moving parts, no external accounts. Requires Docker Desktop.

```bash
docker compose -f docker-compose.test.yml up -d
# Add to .env:
#   TEST_DATABASE_URL=postgres://halonote:halonote_test@localhost:5433/halonote_test
pnpm run test:integration
```

The Postgres container listens on `5433` so it doesn't collide with any
dev Postgres on the default port.

To wipe + start fresh:
```bash
docker compose -f docker-compose.test.yml down -v && docker compose -f docker-compose.test.yml up -d
```

### Option B — Separate Supabase project

If you already have Supabase but no Docker:

1. Create a second Supabase project (free tier is fine — this is just
   for tests, no PHI).
2. Copy its connection string (Settings → Database → Connection string).
3. Add to `.env`:
   ```
   TEST_DATABASE_URL=postgres://postgres.{project-id}:{password}@aws-...pooler.supabase.com:5432/postgres
   ```

⚠️  Never point `TEST_DATABASE_URL` at the same DB as `DATABASE_URL` —
the harness has a safety check that errors on identical URLs, but the
check is purely a string-equality guard. A subtly-different URL
(different pooler host, same DB) would slip through and wipe your data.

### Option C — Native local Postgres

If you have Postgres installed natively:

```bash
createdb halonote_test
# Add to .env:
#   TEST_DATABASE_URL=postgres://your_user@localhost:5432/halonote_test
pnpm run test:integration
```

## E2E (Playwright)

```bash
pnpm --filter @workspace/provider-app run test:e2e:install  # first time only
pnpm --filter @workspace/provider-app run test:e2e
```

Auto-spawns api-server + Vite via Playwright's `webServer` config.
Still needs `TEST_DATABASE_URL` per above, since the api-server it
spawns runs against the test DB.

## What the integration test suite covers today

- `auth.integration.test.ts` — login/signup/password reset, TOTP gates,
  rate limiting
- `audit-log.integration.test.ts` — admin-only audit log access,
  middleware coverage
- `appointment-claims.integration.test.ts` — claim creation + transitions
- `auto-push.integration.test.ts` — note auto-push on approve
- `coding.integration.test.ts` — critical-path Coder: generate, edit,
  bulk-approve, edit before approve, push outcome, auto-trigger
- `ehr-oauth-ownership.integration.test.ts` — per-user EHR connection
  scoping
- `notes.integration.test.ts` — full note CRUD + approve + soft-delete +
  amendment chain
- `onboarding-flow.integration.test.ts` — BAA gate, default-org bootstrap
- `password-reset.integration.test.ts` — reset token lifecycle + rate limits
- `audit-cleanup.integration.test.ts` — retention cleanup job
- `audit.integration.test.ts` — middleware behavior on async writes

**Coverage gaps to fill** (next pass):
- `coding-refine.integration.test.ts` — per-code Refine + Refine-all
- `coding-ingest.integration.test.ts` — Athena DocumentReference ingest
- `coding-problem-list.integration.test.ts` — reconcile + accept + reject
- `coding-bulk-push.integration.test.ts` — push concurrency + retry
  idempotency
