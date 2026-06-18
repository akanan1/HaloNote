### Task 1: Implement full Epic SMART OAuth PKCE flow in `ehr-oauth.ts`

**Objective:**  
Implement the complete Epic SMART OAuth PKCE authorization flow including start, consume, and complete steps in `ehr-oauth.ts`. Add Epic to the provider config, support PKCE state + code verifier storage/encryption, perform JWT Bearer client assertion token exchange, extract practitioner ID and launch context, implement per-user token caching and refresh client, and add comprehensive unit/integration tests covering all success and failure scenarios.

**Files likely involved:**  
- `artifacts/api-server/src/lib/ehr-oauth.ts`  
- `artifacts/api-server/src/lib/token-crypto.ts` (for encryption/decryption)  
- `artifacts/api-server/tests/lib/ehr-oauth.test.ts` (add tests or create if missing)  
- `search codebase for ehrOauthStatesTable` (DB table code for OAuth state; may be in lib/db or schema files)  
- `search codebase for ehrConnectionsTable` (DB table code for stored encrypted tokens)

**Step-by-step implementation plan:**  
1. **Add Epic provider config:**  
   - Add Epic entry to `providerConfig` using env vars: `EPIC_FHIR_BASE_URL`, `EPIC_TOKEN_URL`, `EPIC_CLIENT_ID`, `EPIC_SCOPE` (optional), `EPIC_ALGORITHM`, `EPIC_PRIVATE_KEY`, `EPIC_KEY_ID`.  
   - Validate presence of these env vars on startup and fail fast if missing.

2. **Extend `startOauthFlow` to support Epic:**  
   - Implement PKCE flow for Epic: generate `code_verifier`, `code_challenge` (S256).  
   - Build authorization URL with required SMART OAuth params: `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `aud` (set to Epic FHIR base URL), `code_challenge`, `code_challenge_method=S256`.  
   - Store encrypted `code_verifier` and `state` in `ehrOauthStatesTable` keyed by userId and provider with TTL.

3. **Implement `consumeOauthState` to retrieve and verify Epic OAuth state:**  
   - Validate state parameter in the callback matches stored state.  
   - Decrypt stored PKCE `code_verifier` for token exchange.

4. **Implement `completeOauthFlow` for Epic token exchange:**  
   - Exchange authorization code for tokens via POST to Epic token URL using JWT Bearer client assertion for client authentication:  
     * Build JWT signed with Epic private key and include required claims (`iss`, `sub`, `aud`, `exp`, `jti`, kid in header).  
     * Use `client_assertion` and `client_assertion_type` parameters per OAuth JWT Bearer spec.  
   - Decrypt tokens (access/refresh) and save encrypted in `ehrConnectionsTable`.  
   - Extract practitioner ID and launch context from token response or subsequent FHIR calls.

5. **Add `getEpicClientForUser(userId)` method:**  
   - Retrieve encrypted OAuth tokens for user and decrypt.  
   - Instantiate per-user cached FHIR client with proper token provider that supports refresh tokens via JWT Bearer client auth.  
   - Implement token refresh logic with error handling and token rotation support.

6. **General error handling and edge case coverage:**  
   - Handle missing or expired PKCE states gracefully.  
   - Handle revoked or invalid refresh tokens by prompting re-auth.  
   - Securely encrypt/decrypt all sensitive tokens.  
   - Log without exposing secrets or tokens.

7. **Add thorough unit and integration tests:**  
   - Test `startOauthFlow` Epic flow including PKCE params stored and returned URL correctness.  
   - Test state consumption and validation.  
   - Test complete OAuth flow with mocked Epic token endpoint responses (success + various failures).  
   - Test token refresh lifecycle with mock token expiry and refresh failures.  
   - Test error paths (invalid code, missing state, revoked tokens).  

**Safety constraints:**  
- Do not log sensitive info: never log tokens, private keys, or code verifiers.  
- Fail fast if required env vars are missing or private key parsing fails.  
- Use strong encryption (AES-256-GCM) consistently for tokens and PKCE secrets.  
- Ensure JWT bearer assertions include proper expiry and unique IDs to prevent replay attacks.  
- Validate redirect URLs against whitelist before use.  
- Protect against OAuth state reuse or replay attacks by consuming and deleting stored state atomically.

**Tests required:**  
- Unit tests for all Epic OAuth flow functions in `ehr-oauth.ts` including start, consume, complete steps.  
- Integration tests mocking Epic token endpoint and FHIR server for per-user client token refresh.  
- Error handling tests for invalid code, expired state, revoked refresh tokens.  
- Encryption/decryption correctness tests for stored tokens and PKCE secrets.  
- Security tests verifying no sensitive info is logged in error cases.  

**Acceptance criteria:**  
- Epic OAuth PKCE flow works end-to-end for a user: start -> authorize -> callback -> token exchange -> token storage.  
- Per-user Epic FHIR clients can be instantiated and auto-refresh tokens correctly.  
- All OAuth states and secrets stored encrypted with correct TTL and consumed exactly once.  
- Unit and integration tests cover success and failure cases with >90% coverage for Epic OAuth code.  
- No sensitive data leaks in logs or errors.  
- Robust error handling and clear failure messages without sensitive details.  

**Exact Claude/Cursor prompt:**  
```
You are a developer working on the Halo Note API server EHR integration. Implement Epic provider OAuth PKCE SMART on FHIR flow support in `artifacts/api-server/src/lib/ehr-oauth.ts`:

- Add Epic to `providerConfig` with env vars:
  * EPIC_FHIR_BASE_URL
  * EPIC_TOKEN_URL
  * EPIC_CLIENT_ID
  * EPIC_SCOPE (optional)
  * EPIC_ALGORITHM
  * EPIC_PRIVATE_KEY
  * EPIC_KEY_ID

- Add `startOauthFlow` support for Epic:
  * Generate PKCE code_verifier and S256 code_challenge.
  * Build authorization URL with SMART OAuth params (response_type=code, client_id, redirect_uri, scope, state, aud, code_challenge, code_challenge_method=S256).
  * Store encrypted state and code_verifier in DB tied to user and provider with TTL.

- Implement `consumeOauthState` for Epic to retrieve and verify stored PKCE state.

- Implement `completeOauthFlow` for Epic:
  * Use JWT Bearer client assertion signed with `EPIC_PRIVATE_KEY` to authenticate token request.
  * Exchange code for tokens at Epic token URL.
  * Decrypt and store encrypted tokens per user.
  * Extract practitioner ID and launch context from token or FHIR calls.

- Write `getEpicClientForUser(userId)` to create per-user FHIR client supporting token refresh via JWT Bearer authentication.

- Ensure integration with existing DB schema, token encryption, and error handling.

- Add detailed unit and integration tests covering success and failure of Epic OAuth flows, including token refresh lifecycle and error cases.

Do not log sensitive keys or tokens. Securely store all secrets encrypted. Validate all inputs and handle errors cleanly.
```

---

### Task 2: Refactor and consolidate duplicated EHR client/provider logic into `ehrClientManager.ts`

**Objective:**  
Create a centralized EHR client/provider manager abstraction unifying provider resolution (`athenahealth`, `epic`, `cerner`, `mock`) and client instantiation patterns used across `ehr-oauth.ts`, `ehr-user-client.ts`, `ehr-push.ts`, `ehr-schedule.ts`, `patient-sync.ts`. Remove duplicated resolveProvider logic and disparate client caches. Export a single API to get a client by userId or org config.

**Files likely involved:**  
- `artifacts/api-server/src/lib/ehr-oauth.ts`  
- `artifacts/api-server/src/lib/ehr-user-client.ts`  
- `artifacts/api-server/src/lib/ehr-push.ts`  
- `artifacts/api-server/src/lib/ehr-schedule.ts`  
- `artifacts/api-server/src/lib/patient-sync.ts`  
- Create new file `artifacts/api-server/src/lib/ehrClientManager.ts`  

**Step-by-step implementation plan:**  
1. Extract the shared provider resolution logic from all implicated files into `ehrClientManager.ts`:  
   - Read `EHR_MODE` env var or determine per-user/provider.  
   - Maintain singleton or per-user cached clients per provider.  
   - Provide method `getClientForUser(userId: string): EhrClient` which returns the appropriate provider's FHIR client or mock fallback.

2. Move all client instantiation logic for Athenahealth, Epic, Cerner into this single module:  
   - Create factory methods for each provider's client with configured OAuth token providers and refresh logic.  

3. Refactor `ehr-oauth.ts`, `ehr-user-client.ts`, `ehr-push.ts`, `ehr-schedule.ts`, `patient-sync.ts` to import and use `ehrClientManager.getClientForUser()` exclusively for client access.  
   - Remove redundant provider checks in those files.

4. Add caching and renewal logic at centralized point to avoid multiple refresh token races or token leakage.  

5. Add unit tests for `ehrClientManager.ts`:  
   - Provider resolution logic correctness.  
   - Client factory creates clients for each provider correctly.  
   - Returns mock client if env is mock or config missing.

6. Update imports and exports across all files accordingly.

**Safety constraints:**  
- Ensure no regression in provider client construction or token refresh.  
- Keep OAuth tokens encrypted and only decrypted within clients instantiated here.  
- Avoid introducing concurrency bugs in per-user client caches.

**Tests required:**  
- Unit tests for `ehrClientManager.ts` core logic and provider dispatch.  
- Integration tests verifying calls from former files correctly get expected clients via new manager.  

**Acceptance criteria:**  
- All references to provider resolution and client caching consolidated in one module.  
- No duplicated logic remains in `ehr-oauth.ts`, `ehr-user-client.ts`, `ehr-push.ts`, `ehr-schedule.ts`, or `patient-sync.ts`.  
- Tests cover all branches with mocks for different provider configs.  
- No functional regression in EHR OAuth or FHIR client usage workflows.  

**Exact Claude/Cursor prompt:**  
```
Consolidate duplicated EHR provider resolution and client caching logic found in `ehr-oauth.ts`, `ehr-user-client.ts`, `ehr-push.ts`, `ehr-schedule.ts`, and `patient-sync.ts` into a single helper module `ehrClientManager.ts`.

- Implement `getClientForUser(userId: string)` returning the correct FHIR client instance per configured EHR provider (`athenahealth`, `epic`, `cerner`, or `mock` fallback).
- Move singleton and per-user client creation and OAuth token refresh handling here.
- Refactor all mentioned files to use `ehrClientManager.getClientForUser()` and remove duplicated resolution code.
- Add unit and integration tests for the new manager module ensuring provider resolution and client instantiation correctness.

Ensure all tokens remain encrypted at rest and refresh logic is centralized.
```

---

### Task 3: Add comprehensive unit and integration test coverage for critical API-server modules, focusing on OAuth flows and security-sensitive logic

**Objective:**  
Establish robust test coverage (>90%) for critical backend modules, especially OAuth flows (`ehr-oauth.ts`), patient sync (`patient-sync.ts`), recording pipeline (`recording-pipeline.ts`), and security middlewares (`require-auth.ts`, `require-csrf.ts`). Cover normal flows, edge cases, errors, token refresh, and security hardening.

**Files likely involved:**  
- `artifacts/api-server/src/lib/ehr-oauth.ts`  
- `artifacts/api-server/src/lib/patient-sync.ts`  
- `artifacts/api-server/src/lib/recording-pipeline.ts`  
- `artifacts/api-server/src/middlewares/require-auth.ts`  
- `artifacts/api-server/src/middlewares/require-csrf.ts`  
- Possibly add test files under `artifacts/api-server/tests/lib/` and `artifacts/api-server/tests/middlewares/`  

**Step-by-step implementation plan:**  
1. Create or extend test files with Vitest for above modules:  
   - Write unit tests for all public functions and exported logic.  
   - Use mocking/stubbing for external calls (e.g. Athenahealth, Epic token endpoints, FHIR server).  
   - Test edge cases like invalid state, expired tokens, revoked refresh token error paths.

2. Cover security middlewares thoroughly:  
   - Test authentication guard rejects unauthenticated requests.  
   - Test CSRF middleware blocks invalid/missing tokens and allows double-submit valid requests.

3. Simulate token expiry and refresh scenarios in OAuth tests to validate refresh logic.  
4. Verify error propagation and no sensitive info leaks in error messages.  
5. Write integration tests combining auth and patient sync flows where applicable.

6. Use Vitest coverage tools to verify coverage and add missing tests until >90%.  

**Safety constraints:**  
- Tests must not leak real secrets or tokens.  
- Use secure mocks or test secrets.  
- Do not disable security checks in tests except where explicitly needed for specific scenarios.

**Tests required:**  
- Full unit tests for `ehr-oauth.ts` including Epic once implemented.  
- Unit tests for `patient-sync.ts`: successful sync, failed patient matching.  
- Tests for `recording-pipeline.ts` success and error flows.  
- Middleware tests asserting correct auth and CSRF enforcement.  
- Integration tests covering end-to-end OAuth authorization flows.

**Acceptance criteria:**  
- Tests exist and pass for all critical API-server modules mentioned.  
- Coverage metrics show minimal uncovered lines/functionality.  
- Negative tests confirm errors and security boundaries are enforced.  
- Test suite is stable and integrated in CI pipeline.

**Exact Claude/Cursor prompt:**  
```
Generate comprehensive Vitest unit and integration tests for the Halo Note api-server library modules `ehr-oauth.ts`, `patient-sync.ts`, and `recording-pipeline.ts`. Include coverage of:

- Success, failure, and edge cases for OAuth flows (Athena, Cerner, Epic)
- Token refresh lifecycle and error handling
- Patient syncing success and failure (e.g. missing MRN)
- Recording pipeline normal and error paths
- Security middlewares `require-auth.ts` and `require-csrf.ts`, verifying authentication enforcement and CSRF token validation/failure

Use mocks/stubs for external APIs. Ensure tests assert no sensitive token or secret leakage. Aim for >90% code coverage.
```

---

### Task 4: Harden dev-only routes gating in `dev-routes.ts` to eliminate fragile environment flag risks

**Objective:**  
Replace the current fragile gating of dev-only routes based on `ALLOW_DEV_ROUTES=1` and non-prod `NODE_ENV` with a safer mechanism or remove dev routes entirely to remove risk of auth bypass. Add startup checks preventing enabling dev routes in production environment. Add tests verifying dev routes are disabled in production.

**Files likely involved:**  
- `artifacts/api-server/src/lib/dev-routes.ts`  
- `artifacts/api-server/src/routes/auth.ts` (dev-login routes)  
- Possibly app startup code where dev routes are registered (`app.ts` or `server.ts`)  
- Add or extend integration tests under `tests/integration/dev-routes.test.ts`  

**Step-by-step implementation plan:**  
1. Remove or disable all dev routes like unauthenticated session minting, CSRF-free OAuth starts.  
2. Replace `ALLOW_DEV_ROUTES=1` env flag with a compile-time or build-time flag for local dev only (e.g. via separate config).  
3. Add check on server startup: if `NODE_ENV === 'production'` and dev routes enabled, throw error and do not start.  
4. Add integration tests:  
   - Confirm dev routes are inaccessible when `NODE_ENV === 'production'`.  
   - Confirm dev routes are present when `NODE_ENV` is `development` and proper flag is set.  
5. Document to ops and engineering teams that dev routes must never be enabled in production.

**Safety constraints:**  
- Dev routes must never be accessible in production under any circumstance.  
- Startup fail-fast if config attempts to enable dev routes in production.  
- Tests must verify routing behavior accordingly.

**Tests required:**  
- Integration test asserting dev routes return 404 or 403 in production mode.  
- Integration test asserting dev routes available in development mode only.  
- Possible negative test attempting to enable dev routes in production fails server startup.

**Acceptance criteria:**  
- Dev-only routes cannot be enabled via env flags at runtime in production.  
- Startup fails with clear error if configuration attempts enabling dev routes in production.  
- Tests verifying routing protection are implemented and pass.  

**Exact Claude/Cursor prompt:**  
```
Harden dev-only routes gating in the Halo Note API server by removing the use of `ALLOW_DEV_ROUTES=1` runtime environment flag which risks enabling dev routes in production.

- Remove or disable dev-login, dev-start OAuth routes or protect them with build-time flags only.
- Add startup checks to throw errors if `NODE_ENV=production` but dev routes are enabled.
- Add integration tests ensuring dev routes are inaccessible when running in production environment.
- Document risk and safe usage.

This eliminates the fragile bypass risk from misconfigured environment variables.
```

---

### Bonus Task 5: Add unit and integration tests for Epic OAuth flow after implementation

(If Task 1 is done, this task ensures tests coverage is complete.)

**Objective:**  
Add detailed tests for Epic SMART OAuth PKCE flow covering start, consume, complete steps, token refresh, error handling.

**Files:**  
- `artifacts/api-server/tests/lib/ehr-oauth.test.ts` (or new dedicated epic-specific test file)

**Plan:**  
- Mock Epic token endpoint responses.  
- Test state storage and consumption with encrypted PKCE verifier.  
- Test JWT Bearer client assertion generation correctness (signed JWT payload and headers).  
- Test token refresh paths with success and failure.  
- Test error handling on invalid state, token exchange failure.  

**Safety:**  
- Never log private keys or tokens.  
- Securely clear mocks after test.

**Tests:**  
- Unit tests for each Epic OAuth method.  
- Integration flow test simulating entire OAuth dance.

**Acceptance:**  
- Coverage >90%, all Epic OAuth code branches tested.

**Prompt:**  
```
Add unit and integration tests for the Epic SMART OAuth PKCE flow implemented in `ehr-oauth.ts`:

- Test `startOauthFlow` correctness and PKCE state storage.
- Test `consumeOauthState` validation and retrieval.
- Test `completeOauthFlow` performing JWT Bearer token exchange with mocked Epic token endpoint.
- Test per-user client token refresh lifecycle.
- Cover error handling cases including invalid states and revoked tokens.
- Use Vitest and mocks; ensure no sensitive data logs.

Achieve 90%+ coverage of Epic OAuth code.
```

---

These tasks implement the critical Epic OAuth blocker, consolidate duplication, harden dev route gating, and bolster tests for security and regression protection as prioritized.