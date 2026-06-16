# Critical Security Risks
- No security-critical issues found in presented code related to PHI leakage, unsafe logging, exposed environment variables, insecure token handling, weak authentication, missing authorization, or insecure file storage.
- Authentication uses strong password hashing (scrypt), session tokens are securely random, and sessions have TTL.
- OAuth tokens are encrypted at rest using AES-256-GCM (token-crypto.ts).
- 2FA via TOTP enforced for admin accounts in login route.
- CSRF protection uses double-submit cookie pattern with timing-safe compares.
- Rate limiting on login, signup, and password reset attempts by IP and email.
- Audit logging middleware attempts fire-and-forget writes including userId and resource metadata.
- EHR OAuth flows properly bind state to user and protect callbacks.
- No usage of process.env keys directly in logs (logger.ts redact paths include EHR_TOKEN_ENC_KEY).
- No userId tampering allowed in EHR OAuth deletion or status routes.
- Password reset tokens hashed, single-use, expire in 1 hour.
- No evidence of sensitive environment variables being exposed.
- No plaintext OAuth token storage or logging.
- Supabase RLS and file storage not shown; cannot assess those.

# Medium Risks
- Audit log middleware is fire-and-forget and non-persistent failures only logged; no backpressure or retry mechanism could cause audit gaps under DB outages.
- Dev-only dev-login and ehr dev-start routes gated only by NODE_ENV and ALLOW_DEV_ROUTES may risk inadvertent exposure if env is misconfigured.
- Login and signup rate limits are decoupled; too loose may allow slow enumeration or brute force distributed attacks.
- CSRF relies solely on double-submit cookie pattern and origin policy; no server-side CSRF tokens.
- TOTP secret provisioning endpoint stores secret unverified until verified; a race or attack may cause stale unused secrets in DB.
- No explicit HTTP Strict Transport Security (HSTS) headers noted.
- No mention of content security policy or other browser protections for frontend served endpoints.
- No explicit session invalidation or rotation on password reset or 2FA disable.
- No password strength/complexity enforcement visible.

# Low Risks
- The OAuth PKCE verifier is stored in DB in cleartext (ehr-oauth.ts) to validate state; this is expected but still sensitive.
- The session cookie is named "halonote_session" and has standard SameSite=lax; consider stricter same-site or secure flags if relevant.
- Redaction in logger may not cover newly added paths if code changes do not update it.
- The soft fail on audit log write could hide persistent tampering or data modification events.
- Rate limits configured with fixed values; could benefit from adaptive or dynamic limits.

# HIPAA Concerns
- PHI is adequately protected from logs by aggressive redaction policy (logger.ts).
- EHR OAuth tokens encrypted at rest and not stored in plaintext.
- User authentication is strong with scrypt password hashing and mandatory 2FA for admins.
- Audit logging implemented for user actions with relevant metadata for compliance; though durability not fully guaranteed.
- Password reset tokens hashed and single-use, expiring after 1 hour.
- No plaintext secrets or PHI exposed in errors or logs.
- OAuth flow properly verifies state and user IDs preventing token misbinding.
- No inconsistent authorization or unauthenticated data exposure found.
- No clear mention of access controls on stored PHI notes or audio, but code review not covering that area.

# Recommended Fixes
1. **Audit log reliability**: Implement retry/backpressure or a durable write queue for audit logs to ensure audit trail integrity under DB failures.
2. **Dev route protection**: Add explicit server config validation on startup to disallow enabling dev-login or ehr dev-start routes in production accidentally.
3. **Session management**: Invalidate all existing sessions on password reset and 2FA disable to prevent session hijacking.
4. **Password policies**: Enforce password complexity and minimum length on signup and reset routes.
5. **CSRF protections**: Consider adding server-side CSRF tokens or SameSite=strict cookies to guard further against CSRF risks.
6. **HTTP security headers**: Add HSTS, CSP, X-Frame-Options headers to enhance browser security.
7. **Rate limiting**: Monitor rate limit effectiveness and adjust caps dynamically to prevent enumeration or brute force attacks.
8. **Logging review**: Regularly review and update logger redaction paths to ensure no new PHI or secrets can be leaked.
9. **Secrets handling**: Rotate `EHR_TOKEN_ENC_KEY` securely via environment and key rotation procedures; perform secure key destruction.

# Claude/Cursor Prompt
```
You are the Security and HIPAA Agent auditing Halo Note API code. Review authentication, OAuth token handling, encryption, access control, logging, rate limiting, and audit logging for PHI leakage, token safety, authorization, and HIPAA risks. Analyze these exact files:

- src/lib/auth.ts
- src/lib/token-crypto.ts
- src/routes/auth.ts
- src/routes/ehr-oauth.ts
- src/lib/logger.ts
- src/middlewares/require-auth.ts
- src/middlewares/require-admin.ts
- src/middlewares/audit.ts
- src/middlewares/require-csrf.ts

Assess password and session security, OAuth flows with PKCE, token encryption, TOTP enforcement for admins, logging redaction, CSRF defenses, and audit logging durability.

Report:

- Critical security risks by file and why they matter
- Medium and low risks by file
- HIPAA compliance concerns
- Exact fixes with file and code snippets if needed

Don't invent files. Focus strictly on Halo Note's code and risk posture.
```