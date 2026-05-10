# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5 (esbuild → CJS-banner-wrapped ESM bundle), pino logging
- DB: PostgreSQL via Drizzle ORM + `pg`
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval generates a react-query client and Zod schemas from `lib/api-spec/openapi.yaml`
- Frontend sandbox: Vite + React 19 + Tailwind 4 (Radix UI + shadcn-style components)

## Commands

Run from the workspace root unless noted.

- `pnpm --filter @workspace/api-server run dev` — build + start API server (requires `PORT`, `DATABASE_URL`)
- `pnpm --filter @workspace/mockup-sandbox run dev` — Vite dev server (requires `PORT`, `BASE_PATH`)
- `pnpm run typecheck` — full typecheck across all packages (`tsc --build` for libs, then per-artifact `tsc --noEmit`)
- `pnpm run build` — typecheck + run every package's `build` script
- `pnpm --filter @workspace/api-spec run codegen` — regenerate the react-query client and Zod schemas after editing `openapi.yaml`; this also reruns `typecheck:libs`
- `pnpm --filter @workspace/db run push` — apply schema changes to the dev DB (drizzle-kit). `push-force` skips prompts.

There is no test runner wired up — the codebase relies on TypeScript + Zod for correctness.

## Workspace layout

The workspace has two roles for packages, enforced by `pnpm-workspace.yaml`:

- `lib/*` — internal libraries consumed via `workspace:*`. Compiled by the root `tsc --build` (project references in `tsconfig.json`). Source is the published entrypoint (`exports` points at `src/index.ts`); these are not pre-built.
- `artifacts/*` — deployable apps. Each owns its own `build` script and bundler config. Not consumed by other packages.
- `scripts/` — one-off TypeScript scripts run via `tsx`.

Packages:

- `lib/db` — Drizzle setup. `db` and `pool` are exported from `src/index.ts`; tables/schemas live under `src/schema/` and must be re-exported from `src/schema/index.ts` (one file per table is the convention shown in the placeholder).
- `lib/api-spec` — OpenAPI source of truth (`openapi.yaml`) + `orval.config.ts`. **Codegen writes into the other two `lib/api-*` packages' `src/generated/` directories**, not into `lib/api-spec` itself.
- `lib/api-zod` — Generated Zod request/response validators + TypeScript types. Used server-side. Do not edit `src/generated/`.
- `lib/api-client-react` — Generated react-query hooks + a hand-written `custom-fetch.ts` that all generated calls go through. Configure base URL / bearer auth via `setBaseUrl()` / `setAuthTokenGetter()` (the latter is for native bundles; web apps should rely on cookies).
- `lib/integrations/ehr` (`@workspace/ehr`) — FHIR R4 + EHR integration scaffold. Vendor-agnostic `FhirClient` (read/search/create/update with `OperationOutcome`-aware `FhirError`), two auth strategies (`OAuth2TokenProvider` for client_credentials w/ Basic auth, `JwtBearerAuthProvider` for SMART backend services w/ `private_key_jwt`), both implementing `TokenProvider`. JWT signing supports RS256/384/512 + ES256/384/512 and accepts a `JwtSigner` callback to delegate to KMS/HSM (private key never leaves the vault). `derToJose`/`joseToDer` in `auth/ecdsa.ts` bridge the DER↔JOSE format mismatch that KMS+ECDSA always hits. `DocumentReferencePusher` builds + POSTs a FHIR `DocumentReference` from a higher-level note input. Providers: `athenahealth` (uses `OAuth2TokenProvider`) and `epic` (uses `JwtBearerAuthProvider`). Subpath exports: `./fhir`, `./auth`, `./document-reference`, `./athenahealth`, `./epic`. No vendor URLs are hardcoded — all required as config.
- `artifacts/api-server` — Express app. `src/app.ts` mounts everything under `/api`; routes are added by importing into `src/routes/index.ts`. Bundled by `build.mjs` to a single `dist/index.mjs` with a CJS-compat banner so CJS-only deps (e.g. express) still work in the ESM output. Pino is bundled via `esbuild-plugin-pino` rather than externalized.
- `artifacts/mockup-sandbox` — Vite app whose only job is to render React component previews. Drop a `.tsx` file under `src/components/mockups/` and visit `/{BASE_PATH}/preview/<path-without-.tsx>`. The `mockupPreviewPlugin` watches that directory and regenerates `src/.generated/mockup-components.ts` (a glob-import map). Files/folders prefixed with `_` are skipped. Default export wins, then `Preview`, then any named export matching the file's basename.

## API contract workflow

The OpenAPI spec is the source of truth. After editing `lib/api-spec/openapi.yaml`:

1. Run `pnpm --filter @workspace/api-spec run codegen`.
2. Server code uses Zod parsers from `@workspace/api-zod` (e.g. `HealthCheckResponse.parse(...)` in `routes/health.ts`).
3. Frontend code consumes generated react-query hooks + types from `@workspace/api-client-react`.

Generated files in `src/generated/` are clobbered on every codegen run — never hand-edit them.

## Conventions and gotchas

- **pnpm only.** The root `preinstall` script deletes `package-lock.json`/`yarn.lock` and refuses non-pnpm installs.
- **`minimumReleaseAge: 1440`** in `pnpm-workspace.yaml` blocks installing packages younger than 24 hours as a supply-chain defense. Do not disable it. To bypass for a specific trusted package, add it to `minimumReleaseAgeExclude`.
- **Dependency versions** for shared frontend deps (react, vite, tailwind, drizzle-orm, zod, etc.) come from the `catalog:` block — bump them there, not in individual `package.json`s. React is pinned to `19.1.0` exactly because Expo requires it.
- **Linux-x64 only.** `pnpm-workspace.yaml` overrides exclude all non-linux-x64 native binaries (esbuild, lightningcss, rollup, tailwindcss-oxide, ngrok). Local dev on macOS/Windows will need to override this temporarily.
- **TypeScript:** workspace uses `"customConditions": ["workspace"]` so packages resolve to their TS sources. `tsc --build` is driven by the root `tsconfig.json` references; add new `lib/*` packages there.
- **`PORT` is required, not defaulted** for both `api-server` and `mockup-sandbox` — they throw on startup if missing.
- **`post-merge.sh`** runs `pnpm install --frozen-lockfile && pnpm --filter db push` automatically after `git merge` (configured via `.replit` `[postMerge]`).

## Pointers

- See `replit.md` for the human-facing project README skeleton (currently mostly placeholder text).
