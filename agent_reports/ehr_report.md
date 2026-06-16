# Current Integration Status

- OAuth flow:
  - Standard SMART OAuth 2.0 PKCE flow implemented for Athenahealth and Cerner (Epic OAuth not wired yet).
  - OAuth state stored server-side with TTL; state consumed and deleted on callback.
  - Athenahealth OAuth config reads required env vars and deduces authorize URL.
  - Cerner SMART EHR-launch flow implemented with issuer and launch token validation.
  - OAuth callback verifies state, user session, exchanges code for token, extracts practitioner ID, refresh token, scopes.
  - Tokens and related info are encrypted and stored in DB keyed by (userId, provider).
  - Refresh token handling via getValidAccessToken to refresh access token transparently when close to expiry.
- Redirect URIs:
  - Redirect URI strictness enforced by env vars and safe returnPath validation on server.
  - OAuth callback uses stored returnPath from OAuth state or "/settings" by default.
  - Cerner launch uses launch URL validation and redirects to login if unauthenticated.
- Scopes:
  - Scope configured per provider is read from env vars or defaults ("openid fhirUser" for Athena).
  - Cerner launch requires `launch` scope, which must be present in the scope string.
- Token Exchange:
  - POST to token URL using correct client_secret (Basic auth) or client_id in body if secret empty (Cerner).
  - Proper error handling with sanitized messages.
- Refresh Token Handling:
  - Handled transparently via `getValidAccessToken` called by UserEhrClient (from ehr-oauth imports).
- Patient Lookup and Mapping:
  - Patient sync works via reading FHIR Patient resource by external ID, mapping name/DOB/MRN.
  - Mapping throws errors if required fields missing.
  - Sync endpoint upserts by MRN to DB.
- Encounter and Provider Mapping:
  - The practitioner ID is extracted from token response from various places including fhirUser claim.
  - Encounter IDs included in launch context for Cerner flows.
- DocumentReference Workflows:
  - DocumentReferences built with proper FHIR fields and pushed using per-user client if available.
  - Allows replacesEhrRef for note replacement.
- Sandbox vs Production:
  - Code has "mock" mode when EHR_MODE not set; returns demo patients and schedules, no real EHR calls.
- SMART on FHIR Compliance:
  - PKCE implemented per RFC 7636 with S256 method.
  - `aud` parameter set appropriately in authorize URL (Athena requires FHIR base URL).
  - Launch parameter passed only in Cerner flows.
  - Token response parsing for launch context done per SMART specs.
- Vendor-specific:
  - Athenahealth client uses OAuth2TokenProvider (client_credentials).
  - Epic client uses JWT Bearer assertion client authentication, reading private key etc.
  - Cerner config wired separately.
  
# Major Blockers

1. **Epic OAuth support is incomplete:**
   - OAuth PKCE flow is not implemented for Epic in `ehr-oauth.ts`.
   - `startOauthFlow` and related methods only handle Athenahealth and Cerner; Epic throws on providerConfig call.
   - `getEpicClientForUser` does not exist; no per-user SMART OAuth client for Epic.
   - This is a blocker for Epic integration and smart OAuth with per-user tokens.

2. **Scope configuration gaps:**
   - Athenahealth scope defaults to "openid fhirUser" but Cerner and Epic scopes vary.
   - Cerner requires `launch` scope when launch token present but no validation or enforcement of requested scopes at start.
   - No dynamic scope modification based on presence of launch token or provider.

3. **Refresh token lifecycle management gaps:**
   - While `getValidAccessToken` refreshes tokens, code does not appear to handle refresh token rotation or revocation errors robustly.
   - No explicit handling of missing or expired refresh tokens.
   - Some comments suggest Athena always returns refresh tokens but they are nullable. No fallback.

4. **Redirect URI validation is minimal:**
   - `safeReturnPath` allows only same-origin paths but no enforcement that stored returnPath matches what is registered in OAuth provider.
   - Potential risk if environment variables for redirect URI and OAuth client registration differ from configured value.

5. **DocumentReference push for Epic and per-user clients incomplete:**
   - In `ehr-push.ts`, per-user client push logic only implemented for Athenahealth (`getAthenahealthClientForUser`).
   - No per-user client push for Epic yet.
   - Fallback to org-level client_credentials mode only.

# Missing Components

- `getEpicClientForUser` method analogous to Athena's per-user client is absent.
- OAuth PKCE flow for Epic missing in ehr-oauth.ts.
- Refresh token revoke/retry/error handling is minimal and should be hardened.
- Comprehensive token scope validation and enforcement (requested vs granted) are missing.
- EHR provider info in connection status is only returned for Athenahealth; Epic status not exposed in `/auth/ehr/status`.
- Note write-back logic exists but only Athenahealth per-user usage is shown.
- No integration tests or documentation references visible for complete Cerner or Epic OAuth flows.
- Missing per-user FHIR client refresh token handling for Epic.
- No explicit environment variable validation for redirect URIs consistency.
- No facility for UI/user feedback on OAuth scope gaps or token refresh failures.

# OAuth Risks

- State expiration and consumption looks correct, but no limit on max concurrent states for abuse.
- No explicit CSRF protection on OAuth start POST beyond state.
- Per-user OAuth connection retrieval limited to Athena; Epic and Cerner incomplete.
- Lack of Epic PKCE flow support means no safe per-user OAuth for Epic.
- Refresh token errors during token refresh not logged or surfaced clearly.
- Redirect URIs only validated for same-origin path, not full correctness for providers.
- Storing refresh tokens in DB but no mechanism for token revocation or re-auth prompts.
- No forced re-auth or session invalidation on token expiry or scope drop.
- No monitoring/logging hooks for OAuth token misuse or expiration errors.
- OAuth callback logs errors but could leak sensitive details if not careful.

# FHIR Workflow Risks

- Patient sync relies heavily on perfect MRN matching; no support for multiple identifiers or ambiguous cases.
- Encounter context is used only for Cerner launch flow; no encounter-aware workflows for other providers.
- DocumentReference push replaces logic only in Athena per-user; no fallback or merge logic for others.
- Schedule queries rely on `practitioner` parameter which might be unsupported or differently named in some EHRs.
- Mock modes may cause discrepancies with real EHR behavior if allowed in production by accident.
- Patient history extraction uses only active problems and meds; no support for inactive or resolved states, which may affect clinical decisions.
- FHIR client rejects non-HTTPS base URLs in production, which is good but needs explicit messaging to operators.
- No explicit caching or throttling of FHIR calls; high volume use might cause rate limiting.
- No validation on DocumentReference payload size, attachments, or special FHIR constraints.
- Error responses from FHIR servers are sanitized but some fields discarded without fallback, reducing diagnostics.

# Recommended Next Steps

1. **Implement Epic SMART OAuth PKCE flow in `ehr-oauth.ts` and support per-user client:**
   - Add Epic providerConfig and startOauthFlow support.
   - Create `getEpicClientForUser` with refresh token handling.
   - Wire Epic OAuth start/callback endpoints.

2. **Enhance scope management and validation:**
   - Ensure requested scopes match required for launch tokens.
   - Validate granted scopes vs requested; fail early or warn in UI.
   - Surface scope errors to users for re-auth.

3. **Harden refresh token error handling and lifecycle:**
   - Detect revoked or exhausted refresh tokens; prompt user to re-auth.
   - Add retries with exponential backoff for transient token refresh failures.
   - Log refresh token lifecycle events for monitoring.

4. **Add more robust redirect URI validation:**
   - Verify configured redirectUri matches OAuth provider registration.
   - Restrict returnPath more strictly or whitelist known safe destinations.
   - Audit environment variables for correctness.

5. **Expand per-user client support to Epic for DocumentReference push and FHIR client usage:**
   - Refactor ehr-push.ts to support Epic per-user clients similarly to Athena.
   - Add fallback and error patterns.
   - Add logging and analytics for push failures.

# Vendor Communication Suggestions

- To Athenahealth:
  ```
  We are using your OAuth2 with PKCE and SMART on FHIR APIs. Our integration uses your token and authorize URLs as configured via environment variables. Are there any recommended scope strings or token endpoint requirements you mandate that we should enforce in the client? We want to confirm the expected behaviors for refresh token rotation and error cases.
  ```
- To Epic support:
  ```
  We currently have the client-credential flow working for Epic via JWT bearer assertions but lack an implementation for per-user SMART OAuth PKCE. Is there a recommended OAuth endpoint URL pattern and required scope set for SMART launch per Epic guidelines? Also, are there client libraries or documentation for implementing per-user token refresh with JWT assertion?
  ```
- To Cerner support:
  ```
  Our Cerner SMART EHR-launch flow uses the launch and iss URL parameters and redirects correctly. Could you confirm best practices for managing launch token lifecycle and refresh token usage in multi-user environments? Any recommendations on scope configurations for different resource access levels?
  ```

# Claude/Cursor Prompt

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
  * Build redirect URL with all SMART required query params: response_type=code, client_id, redirect_uri, scope, state, aud, code_challenge, code_challenge_method=S256.
  * Use provider-specific values for URLs and scope.
  * Generate PKCE code_verifier and code_challenge.
  * Store state and code_verifier along with user and provider in DB.

- Add `consumeOauthState` and `completeOauthFlow` to handle Epic token exchange with correct headers and client assertion using JWT Bearer client authentication as per Epic requirements.

- Extract practitioner ID and launch context in `completeOauthFlow` similarly to Athena and Cerner.

- Write `getEpicClientForUser(userId)` method to retrieve stored tokens and provide a per-user FHIR client with refresh token support using JWTBearerAuthProvider.

Ensure all new code integrates with existing DB schema for `ehrConnectionsTable` and `ehrOauthStatesTable`, encrypts tokens, and does proper error handling.

Add full unit test coverage for Epic OAuth flow and token exchange success and failure cases.
```