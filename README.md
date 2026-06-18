# HaloNote

A clinical note-taking app for healthcare providers. Notes are authored
in HaloNote and pushed to the patient's EHR (Athena, Epic) as FHIR
`DocumentReference` resources.

## Quick start

```bash
pnpm install
cp .env.example .env          # fill in DATABASE_URL at minimum
pnpm --filter @workspace/db run migrate
pnpm --filter @workspace/api-server run dev   # API on :PORT
pnpm --filter @workspace/provider-app run dev # Vite on :5173
```

Demo users seed automatically in non-production mode:

- `alice@halonote.example` — admin, password `hunter2`
- `bob@halonote.example` — member, password `hunter2`

Admin accounts must have TOTP enrolled (`auth.ts` refuses admin login
without it). Alice is pre-enrolled with a deterministic dev-only secret
so local sign-in works out of the box:

- **Dev TOTP secret (alice):** `JBSWY3DPEHPK3PXP`
- `otpauth://totp/HaloNote:alice@halonote.example?secret=JBSWY3DPEHPK3PXP&issuer=HaloNote`
- Or from the shell: `oathtool --totp -b JBSWY3DPEHPK3PXP`

This is the canonical RFC 4226 test vector — not real secret material —
and is gated behind `NODE_ENV !== "production"` in the seeder.

## Commands

- `pnpm run typecheck` — strict TS across every package
- `pnpm run test` — unit tests (vitest)
- `pnpm run test:integration` — api-server integration tests (needs `TEST_DATABASE_URL`)
- `pnpm --filter @workspace/provider-app run test:e2e` — Playwright E2E
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API client + Zod schemas after editing `openapi.yaml`
- `pnpm --filter @workspace/db run generate --name <slug>` — create a new Drizzle migration
- `pnpm --filter @workspace/db run migrate` — apply pending migrations

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9 (strict)
- API: Express 5, pino, helmet, express-rate-limit (Postgres-backed)
- DB: PostgreSQL + Drizzle ORM + drizzle-kit migrations
- Auth: scrypt password hashing, session cookies + CSRF double-submit, optional TOTP 2FA
- Frontend: Vite 7 + React 19 + Tailwind 4 + wouter + TanStack Query + sonner
- Codegen: Orval (OpenAPI → react-query hooks + Zod schemas)
- EHR: FHIR R4 — `@workspace/ehr` ships Athena (OAuth2 client_credentials) and Epic (SMART backend services JWT bearer) clients
- Tests: vitest (unit + integration with supertest), Playwright (E2E), React Testing Library
- CI: GitHub Actions (typecheck, unit, integration w/ Postgres service, E2E, Docker build)

## Features

- Patients (create, list, single-patient view)
- Notes (create, list, single-note view, amendments via FHIR `relatesTo: replaces`)
- EHR push (mock by default; real provider when `EHR_MODE=athenahealth|epic`)
- Auth: signup, login, signout, forgot/reset password (Resend or log-only sink)
- CSRF protection, login rate limiting, audit log
- Admin-only routes: audit log view, user management (promote/demote)
- PHI-aware logging (pino redact paths cover credentials, FHIR content, patient demographics)

## Deployment

A multi-stage `Dockerfile` builds both api-server and provider-app into
a single image. The api-server serves the SPA when `SPA_DIST_PATH` is
set, and runs Drizzle migrations on boot.

Required env in production:

- `DATABASE_URL` — Postgres connection string (Supabase works)
- `PORT` — port to bind
- `SESSION_SECRET` — 32+ random bytes
- `PUBLIC_APP_URL` — used in password-reset emails

Optional:

- `EHR_MODE` — `athenahealth` | `epic` | unset (mock)
- `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`
- `SENTRY_DSN` — error tracking (no-op when unset)

CI runs on every push to `main` and every PR. The integration job
spins up a Postgres service container and runs Drizzle migrations
before the test phase.

## Workspace layout

- `lib/db` — Drizzle schema + migrations
- `lib/api-spec` — OpenAPI source of truth (`openapi.yaml`) + Orval config
- `lib/api-zod` — generated Zod parsers (server side)
- `lib/api-client-react` — generated react-query hooks (client side)
- `lib/integrations/ehr` — FHIR R4 client, Athena + Epic providers
- `artifacts/api-server` — Express app, bundled to a single `dist/index.mjs` via esbuild
- `artifacts/provider-app` — Vite + React 19 SPA
- `artifacts/mockup-sandbox` — component preview playground
- `scripts/` — one-off TypeScript scripts run via `tsx`

## Conventions

- **pnpm only.** Root `preinstall` deletes `package-lock.json`/`yarn.lock`.
- **`minimumReleaseAge: 1440`** blocks installing packages younger than 24h as a supply-chain defense.
- **Catalog versions.** Shared frontend deps (react, vite, tailwind, drizzle-orm, zod) come from the `catalog:` block in `pnpm-workspace.yaml`.
- **Strict TS.** `strictFunctionTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, `noImplicitOverride` are all on.
- **OpenAPI is the contract.** Edit `lib/api-spec/openapi.yaml`, run codegen, then both sides pick up the changes. Never hand-edit `src/generated/`.
- **`post-merge.sh`** runs `pnpm install --frozen-lockfile && pnpm --filter @workspace/db run migrate` after `git merge`, wired via `.githooks/`. Set `git config core.hooksPath .githooks` per clone.

## Gotchas

- `PORT` is required, not defaulted. Both api-server and mockup-sandbox throw on startup if missing.
- `.env` loading is per-app: api-server uses `node --env-file=../../.env`; Vite apps call `process.loadEnvFile()` from their config.
- Integration tests run sequentially (`fileParallelism: false`) because TRUNCATE-between-tests races audit-log fire-and-forget INSERTs otherwise.
- Drizzle wraps pg errors — check `err.code` _and_ `err.cause?.code` when matching `23505` etc. Helper `isUniqueViolation` in api-server.
