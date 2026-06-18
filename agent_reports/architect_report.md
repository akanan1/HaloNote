Top 5 Issues in Halo Note API-server codebase:

---

### 1. Messy File Structure & Lack of Clear Layering
**Why it matters:**  
Severe sprawl and inconsistent separation make the codebase harder to maintain, reason about, and extend. For example, very domain-specific logic (FHIR/EHR client wrappers, OAuth, patient syncing) and infra-level concerns (recording pipeline, token crypto) live alongside route handlers and middlewares without a clear architectural layering. This increases cognitive load and risks inadvertent coupling.

**Exact files/areas:**  
- `artifacts/api-server/src/lib/` (all libs mixed with domain + infrastructure)  
- `routes/` folder has no sub-domains or clear boundaries.

**Recommended fix:**  
- Apply a modular, layered approach:  
  - Domain (ehr, patients, notes) split from infra (auth, email, csrf, recording-storage)  
  - Separate client adapters from business logic  
  - Folder structure like `domain/...`, `adapters/...`, `infra/...`, `routes/...`  
- Enforce consistent naming & clear single responsibility per module.

**Claude/Cursor prompt to fix:**  
> Refactor the `artifacts/api-server/src/lib` folder into a layered, modular structure distinguishing domain logic, infrastructure, and adapters. Extract EHR and FHIR client logic into `domain/ehr/`, extract low-level crypto/storage/logger into `infra/`, and separate route handlers clearly. Update imports and exports accordingly.

---

### 2. Incomplete Testing Coverage & Missing Test Evidence
**Why it matters:**  
No test files or test results provided in the snippet. Critical logic like OAuth flows, patient syncing, recording pipeline, and rate limiting should be well covered. Risk of regression and bugs rises sharply without tests, especially in security-sensitive areas like auth and EHR integration.

**Exact files/areas:**  
- No test files visible.  
- `package.json` scripts indicate `vitest` is used, but no tests shown.  
- Complex logic in libs like `ehr-oauth.ts`, `patient-sync.ts`, and `recording-pipeline.ts` especially needs tests.

**Recommended fix:**  
- Add unit and integration tests covering:  
  - OAuth state handling, token exchange edge cases  
  - Patient sync success and failure scenarios  
  - Recording pipeline happy and error paths  
  - Rate limiter increments/decrements  
  - Security middlewares: requireAuth, requireCsrf  
- Use mocking/stubbing for external API calls (Athena, Epic, Deepgram).

**Claude/Cursor prompt to fix:**  
> Generate comprehensive Vitest unit and integration tests for the api-server library modules especially `ehr-oauth.ts`, `patient-sync.ts`, and `recording-pipeline.ts` including success, failure, and edge cases. Also test middleware auth flows and rate limiters. Use mocks for external calls.

---

### 3. Duplicated Logic in EHR Client Handling & Provider Resolution
**Why it matters:**  
Multiple files (`ehr-oauth.ts`, `ehr-user-client.ts`, `ehr-push.ts`, `ehr-schedule.ts`, `patient-sync.ts`) duplicate the same pattern of resolving provider from `EHR_MODE` env and fetching clients, with overlapping fallbacks and provider strings (`"athenahealth" | "epic" | "mock"`). This duplication risks inconsistent behavior, bug diverging, and maintenance overhead.

**Exact files/areas:**  
- `ehr-oauth.ts`, `ehr-user-client.ts`, `ehr-push.ts`, `ehr-schedule.ts`, `patient-sync.ts` all replicate very similar `resolveProvider` logic.  
- Multiple singleton clients for Athenahealth and Epic scattered.

**Recommended fix:**  
- Centralize the provider resolution and client caching in a single module (e.g. `ehrClientManager.ts`).  
- Export a unified interface for getting a provider client by userId or org-level config, with consistent fallback rules.  
- Refactor usage in all libs to call into this single source.

**Claude/Cursor prompt to fix:**  
> Consolidate duplicated EHR provider resolution and client caching into a single helper module that exports a unified API for getting a provider client by user ID or org config. Refactor `ehr-oauth.ts`, `ehr-user-client.ts`, `ehr-push.ts`, `ehr-schedule.ts`, and `patient-sync.ts` to use this.

---

### 4. Backend/Frontend Mismatch in SPA_DIST_PATH Handling & Env Usage
**Why it matters:**  
The backend serves the SPA when `SPA_DIST_PATH` is set, resolving a static path that changes between local dev and production Docker (`./public`, `/app/public`). The environment controls are fragile and partially undocumented. Also, the build and runtime env variables mismatch: e.g. Dockerfile sets `SPA_DIST_PATH=/app/public`, but `.env.example` states `/` must be used for local dev. This leads to confusion and potential broken static asset serving.

**Exact files/areas:**  
- `artifacts/api-server/src/app.ts` SPA serving logic  
- Dockerfile env setup  
- `.env.example` `BASE_PATH` vs `SPA_DIST_PATH` unclear

**Recommended fix:**  
- Clearly document and unify the environment variables for public SPA path in dev vs prod.  
- Avoid conditional serving logic based on presence of a directory; explicitly configure static serving mode.  
- Possibly separate the frontend server or ensure build/deploy tooling sets env uniformly.

**Claude/Cursor prompt to fix:**  
> Clarify and unify SPA static asset serving environment variables and deployment setup. Ensure `SPA_DIST_PATH` is always set explicitly and consistently between local dev and Docker image, with clear docs. Refactor conditional static serving in app.ts to fail loudly on misconfiguration.

---

### 5. Risky Shortcut: Development-Only Routes Enabled by Environment Flags
**Why it matters:**  
The `devRoutesEnabled()` function enables dangerous dev-only routes like unauthenticated session minting, bypassing auth, and CSRF-free OAuth start based on `ALLOW_DEV_ROUTES=1` and non-production `NODE_ENV`. This presents a substantial risk: if mistakenly set to 1 in production, the entire auth can be bypassed. Although the code throws on boot with `NODE_ENV=production` + `ALLOW_DEV_ROUTES=1` to fail fast, it's still a fragile pattern risking human error or incorrect env vars in deploys.

**Exact files/areas:**  
- `artifacts/api-server/src/lib/dev-routes.ts`  
- `routes/auth.ts` (dev-login)  
- Env: `.env.example`, Dockerfile note

**Recommended fix:**  
- Remove or heavily restrict dev-only routes; only enable with a more secure gating mechanism (e.g. separate build profiles or physical config toggle).  
- Add integration tests enforcing that dev routes do not mount in production under any condition.  
- Document the serious risk clearly for ops teams.

**Claude/Cursor prompt to fix:**  
> Harden the dev-only routes gating by removing the `ALLOW_DEV_ROUTES=1` pattern. Instead, control dev route inclusion via build-time flags or separate deploy presets. Add integration tests to verify dev routes cannot be enabled in production. Document risk and remediation for operators.

---

# Summary
The codebase is well-instrumented but has architectural smells, scattered duplication, fragile env-based gating of risky dev routes, and lacks evidence of real tests. Fixing the above 5 prioritized issues will make Halo Note more maintainable, secure, and robust for production use.

If you want, I can generate code modification suggestions or test skeletons for these areas.