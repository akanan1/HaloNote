# HaloNote — Project Knowledge for Claude.ai

Paste this whole document into a Claude.ai Project's knowledge so every chat in
that project starts with the same context.

## Who I am

Abdullah Kanan — founder/sole engineer on HaloNoteApp. Email
`abdullah@halonote.app`. Working across the full stack: API (Express 5 +
Drizzle/Postgres), provider SPA (Vite + React 19), EHR integration library
(`lib/integrations/ehr`), and a mockup-sandbox. Commits are authored as
"Abdullah" with Claude as co-author — pair-coding with Claude Code is the
norm.

## Repository

Path: `C:\Users\Abdul\Documents\HaloNoteApp` (Windows). pnpm workspaces.
Single `main` branch on GitHub at `github.com/akanan1/HaloNote`.

The repo's `CLAUDE.md` is the authoritative architecture overview — keep it
current. The README is user-facing.

## Stack

- **Node 24 + TypeScript 5.9** strict (`noUncheckedIndexedAccess`,
  `strictFunctionTypes`, etc).
- **API:** Express 5, bundled with esbuild + CJS-banner-wrapped ESM,
  pino logging with PHI redaction, helmet, cookie-parser,
  express-rate-limit.
- **DB:** PostgreSQL via Drizzle ORM + `pg`, drizzle-kit migrations.
  Hosted on Supabase.
- **Auth:** scrypt password hashing, session cookies + CSRF double-submit,
  role-based admin/member, optional TOTP 2FA, rate-limited login.
- **Validation:** Zod (`zod/v4`), `drizzle-zod`.
- **API codegen:** Orval generates a react-query client + Zod schemas from
  `lib/api-spec/openapi.yaml`. Generated files in `src/generated/` are
  clobbered every codegen run — never hand-edit them.
- **Frontend (provider-app):** Vite 7 + React 19 + Tailwind 4 + wouter +
  TanStack Query + sonner + react-hook-form. Responsive (mobile 44px
  touch targets).
- **EHR lib (`@workspace/ehr`):** vendor-agnostic FhirClient,
  OAuth2TokenProvider (client_credentials, Basic auth) and
  JwtBearerAuthProvider (SMART backend services, private_key_jwt with KMS
  signer callback for ECDSA), DocumentReferencePusher,
  athenahealth + epic provider adapters.
- **Tests:** vitest unit + integration (supertest, Postgres service
  container), Playwright E2E, React Testing Library + jsdom.
- **Container:** multi-stage Dockerfile, non-root UID 10001, healthcheck
  via native fetch.
- **CI:** GitHub Actions — typecheck, unit, integration (Postgres service
  container), E2E, Docker build smoke.

## Workspace layout

- `lib/*` — internal libraries, consumed via `workspace:*`. Source is the
  published entrypoint via `customConditions: ["workspace"]`. Compiled by
  root `tsc --build`.
- `artifacts/*` — deployable apps. Each owns its own bundler. Not consumed
  by other packages.
- `scripts/` — one-off TypeScript scripts via `tsx`.

Key packages:
- `lib/db` — Drizzle schemas + `db` / `pool` exports.
- `lib/api-spec` — OpenAPI source of truth + `orval.config.ts`. Codegen
  writes into `lib/api-zod/src/generated/` and
  `lib/api-client-react/src/generated/`.
- `lib/integrations/ehr` — see "EHR lib" above.
- `artifacts/api-server` — Express app. Mounts under `/api`. Bundled via
  `build.mjs`. Serves the built SPA when `SPA_DIST_PATH` is set
  (single-container deploy). Runs Drizzle migrate on boot via
  `src/lib/run-migrations.ts`.
- `artifacts/provider-app` — Vite + React 19 SPA. Routes via wouter in
  `src/App.tsx`. Auth state in `src/lib/auth.tsx`. Shadcn-style components
  in `src/components/ui/`. E2E specs in `e2e/`.
- `artifacts/mockup-sandbox` — Drop-`.tsx`-and-render-it sandbox.
  `mockupPreviewPlugin` watches `src/components/mockups/` and regenerates
  a glob-import map. Files starting with `_` skipped.

## Conventions / gotchas

- pnpm only. Root `preinstall` deletes other lockfiles and refuses
  non-pnpm installs.
- `minimumReleaseAge: 1440` on the pnpm workspace blocks installing
  packages younger than 24h (supply-chain defense). Don't disable;
  bypass per-package via `minimumReleaseAgeExclude`.
- Shared frontend dep versions live in `catalog:` (root
  `pnpm-workspace.yaml`). React pinned to `19.1.0` exactly (Expo
  requirement).
- `shellEmulator: true` so `VAR=val cmd && cmd2` works on Windows.
- `PORT` required and not defaulted in both api-server and mockup-sandbox.
- `.env` is per-app: api-server loads it via
  `node --env-file=../../.env`; mockup-sandbox via
  `process.loadEnvFile()` in vite.config.
- `post-merge.sh` runs `pnpm install --frozen-lockfile && pnpm migrate`
  after every `git merge`. Wired via `.githooks/post-merge` +
  `core.hooksPath`. Re-set per clone.
- Integration tests run sequentially (`fileParallelism: false`) — TRUNCATE
  between files would race fire-and-forget audit-log INSERTs against the
  users FK. Middleware exposes `pendingAuditWrites()` /
  `waitForPendingAudits()`.
- Drizzle wraps pg errors. `err.code === "23505"` doesn't always catch —
  use `isUniqueViolation(err)` helper (checks `err.cause` too).
- PHI in logs: pino redacts `password`, `passwordHash`, request `body`,
  FHIR `content.text`/`description`, patient demographics (`firstName`,
  `lastName`, `dateOfBirth`, `mrn`), OAuth secrets. Don't bypass the
  logger.

## Auth + security

- Session cookies: HTTP-only, SameSite=Lax, Secure in production. Sessions
  table in DB.
- CSRF: double-submit, `XSRF-TOKEN` cookie + `X-CSRF-Token` header.
  Middleware in `src/middlewares/csrf.ts`.
- Rate limiting: Postgres-backed (`rate_limit_buckets` table). Currently
  on `/auth/login`.
- Role gating: `requireAdmin` middleware. Admin-only:
  `GET /audit-log`, `GET /users`, `PATCH /users/:id`.
- Audit log: every authenticated request logged async with `userId`,
  `action`, `resourceType`, `resourceId`, `metadata`. Retention cleanup
  runs in-process; the multi-replica advisory-lock variant is the
  recommended scale-out pattern.

## Athena integration — current state

Three apps registered on `developer.api.athena.io`:
1. **Halo Note (PRODUCTION)** — 3-legged, real customer-facing.
2. **Halo Note - preview** — 3-legged, `client_id 0oa12i0p43bIkbBdF298`.
   What `.env`'s `ATHENA_CLIENT_ID` points at. Used for the SMART OAuth
   authorization_code flow.
3. **Halo Note - sandbox** — 2-legged, `client_id 0oa12lfotuxkc0h1T298`.
   For smoke-testing FhirClient against real Preview data via
   client_credentials. Has Patient, Practitioner, Encounter,
   DocumentReference scopes (Read + Search) granted in the portal's
   Scopes tab.

**Two parallel athenahealth API stacks, both branded "athenahealth":**
- **Cloud / athenaOne** — what HaloNote targets. Portal:
  `developer.api.athena.io`. Identity: Okta at `identity.athenahealth.com`.
  FHIR base: `api.preview.platform.athenahealth.com/fhir/r4`.
- **Practice / Flow** (ex-Centricity) — portal `mydata.athenahealth.com`,
  Azure AD auth, FHIR base `ap25sandbox.fhirapi.athenahealth.com/<dbname>APIServer`.
  Not what we integrate with.

**Apps are 2-legged XOR 3-legged at creation.** A 3-legged app gets
`access_denied / Policy evaluation failed` if you try
`grant_type=client_credentials` regardless of scope. That's why we
registered a separate 2-legged sandbox app.

**Scope syntax (SMART V2)** — `.r` (read alone) gets
`forbidden / Invalid scope` on `?name=` queries even when granted. Use
`.rs` (read+search) or `.s`. The script + endpoint request `.rs`.

**Test data** lives in Preview Practice 195900. Seven documented
patients: `a-195900.E-60178` through `E-60184` (Donna, Eleana/Ella,
Frankie, Anna, Rebecca/Becky, Gary, Dorrie Sandboxtest / Sandbox-Test).
All map to `Practitioner/a-195900.Provider-23`. Practice context goes in
as `?ah-practice=Organization/a-1.Practice-195900`.

## Open blockers

1. **3-legged sandbox provider credentials** — the only thing missing to
   end-to-end test the OAuth handshake real customers will use. Athena
   doesn't self-serve. Path: email `athenaInterop@athenahealth.com`
   requesting preview-sandbox provider creds for client_id
   `0oa12i0p43bIkbBdF298`.
2. **`DocumentReference.write` scopes** — `.write` isn't auto-approved.
   Whole point of the app is pushing notes back to athena. Ask Athena
   support how to get write in preview + path to production.
3. **Network IPv6** — Supabase's DB host is IPv6-only (AAAA record, no A).
   Some networks block IPv6 → api-server fails on boot during migrations.
   Workaround: use Supabase's IPv4-compatible pooler URL in `DATABASE_URL`.

## Recent commits

- `935e615` — *Athena Preview sandbox: 2-legged smoke path + dev seams.*
  Lands a parallel 2-legged sandbox app + CLI smoke test
  (`pnpm --filter @workspace/scripts run athena-sandbox-smoke`) + dev
  endpoint `GET /api/dev/sandbox-patients` + SPA page `/dev/sandbox`.
  Also adds two NODE_ENV-guarded auth seams: `GET /api/auth/dev-login`
  (skip the React form) and `GET /api/auth/ehr/:provider/dev-start`
  (start 3-legged OAuth via URL nav).
- `198b2af` — *Dev routes: require ALLOW_DEV_ROUTES=1 in addition to
  non-prod NODE_ENV.* Strengthens the gate so the dev seams stay dormant
  unless explicitly opted in, even on misconfigured non-prod environments.
  One-time warn log at startup names the routes exposed.

Both pushed to `origin/main`.

## Operating tips for working with me on this project

- Default to forward motion. Make local, reversible changes (edit .env,
  write code, start/stop dev servers, run scripts) without pausing for
  confirmation.
- Pause for: shared/external systems that can't be undone, tasks only I
  can do (third-party portal logins), genuine ambiguity where guessing
  wrong wastes more time than asking.
- When you write code: no defensive `try/catch` for impossible paths, no
  comments explaining what well-named code already does, no premature
  abstraction. Three similar lines beats a half-baked helper. Bug fixes
  don't need surrounding cleanup.
- When you make architectural calls in the codebase, follow the
  conventions already in `CLAUDE.md`.
- Push to `main` directly is fine (this is a solo repo, no PR gating).
- Read the recent git log before assuming what the codebase looks like —
  it moves fast.
