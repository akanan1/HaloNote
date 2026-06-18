# Biggest Product Problems

1. **No direct evidence of UI/UX workflows in codebase**: The provided codebase is predominantly backend, tests, and some frontend config/packages; no direct frontend UI code or detailed user flows are provided to evaluate confusing workflows, onboarding, or note review flows clearly.
2. **Weak EHR integration UX**: Though Athena, Epic, Cerner integrations exist, all real EHR pushes default to mocks unless keys/env vars are set (see `.env.example` and tests). Real push failures or incomplete contracts could frustrate physicians expecting seamless EHR workflows.
3. **Note review flows minimal**: Notes integration tests show basic create/edit/delete and sending to EHR, but no indications of versioning, inline editing feedback, or rich review UX.
4. **Onboarding is backend-only**: Signup flows are covered in tests but no mention of in-app onboarding tips/guides for busy physicians.
5. **Multi-factor auth mandatory for admins only** might cause friction in environments that prefer uniform security or simpler processes.
6. **Audit log usability limited**: Audit logs exist and are protected/admin-only, but no UI details about filtering/pagination UX to evaluate frustrations or complexity.
7. **Appointment-Note links stored in localStorage**: This client-side persistence may cause confusing sync issues on multiple devices or between team members.

# UX Friction Points

- **Lack of onboarding or initial guidance**: No artifact indicates onboarding tips, quick-start guides, or tooltips for new users.
- **Possibly confusing combined vs separate A&P note templates**: Template detection relies on voice cues, with fallback to null. Physicians used to explicit sections could be confused if notes are parsed inconsistently (see `note-templates.test.ts` and `note-export.test.ts`).
- **Multi-step auth/login with TOTP may interrupt quick access**: Required 2FA for admins, but no mention of graceful fallback or reminders.
- **Note amendment flow requires explicitly passing replacesNoteId**: Workflow might confuse physicians expecting version histories or inline edit chains seamlessly visible.
- **Soft-deletion vs hard deletion of notes could confuse users**: Deleted notes stay visible with changed status which might clutter interfaces without clear UX.
- **FHIR EHR OAuth flows likely require separate manual environment configuration**: The complexity of environment variables (see `.env.example`) will cause friction for administrators and users if integration is not seamless.
- **Reset password emails fallback to logging, not sending by default**: Risk of onboarding friction if email sending is not properly configured (`lib/email.test.ts`).

# Critical Bugs or Failures

- No explicit runtime bugs are visible in tests or build configs.
- The audit log relies on advisory locks and transactional deletion, which can briefly return null if locked—possible rare failures or delays in audit cleanup (see `audit-cleanup.integration.test.ts`).
- EHR OAuth token encryption errors throw on missing keys; this is good fail-fast behavior but means misconfiguration is brittle.
- CSRF protection already rejects unsafe requests without tokens, but missing or mismatched tokens cause 403, a common friction point.
- Tests show correct ownership boundaries preventing user data leakage in EHR OAuth (`ehr-oauth-ownership.integration.test.ts`) and note access, suggesting no immediate critical bugs.
- The app throws errors if misconfigured environment variables occur, e.g., dev routes enabled in production (`dev-routes.test.ts`).

# Features Missing Before Real Deployment

- **Full frontend UX code and flows to verify note creation/editing**, patient detail navigation, workflow efficiencies, and onboarding.
- **Robust patient and note search/filtering UI** for clinical efficiency.
- **Version control or history UI for notes**, given amendments supported via replacesNoteId.
- **Real-time collaboration or sync support** to prevent localStorage breakage in multi-device scenarios.
- **Comprehensive error messages and retry flows for EHR pushes in UI**, currently only backend evidence.
- **User-friendly multi-factor auth enrollment/recovery flows** beyond the API.
- **Help/documentation within the app** for onboarding skeptical physicians.
- **Performance optimizations in UI for loading large note lists or audit logs**.
- **Notification or alert system for EHR push success/failure**.
- **Mobile responsiveness or app support**, no evidence here.

# What Would Make Users Quit

- **Slow or unreliable EHR integration causing duplicated or lost notes**.
- **Confusing navigation between patients, notes, and audits** with no clear primary workflow.
- **Frustrating required login 2FA for all or most users, without simple options**.
- **Lack of note review or editing tools physicians expect** (no evidence of comment, highlight, or version features).
- **No clear onboarding or help—physicians overwhelmed by cryptic errors or lack of guidance leave quickly**.
- **Friction around note amendments: no chaining or clear transition leads to mistakes**.
- **Audit log is admin-only and probably hidden from physicians, limiting oversight or individualized feedback**.
- **Soft deletes clutter notes without obvious quick recovery or permanent deletion**.
- **Email needs to be configured exactly right or password resets silently fail**.

# Highest ROI Improvements

1. **Develop and test full frontend workflows for note creation, editing, and EHR push**: Focus on UI simplicity, clear buttons, and step-saving (see missing frontend details).
2. **Add in-app onboarding/tutorials for new physicians/clinic admins** to reduce setup friction.
3. **Simplify EHR integration UI** and surface better detail/errors in push flows.
4. **Improve note review flows** with better note versioning visibility and inline editing highlights.
5. **Add multi-device sync for appointment-note claims to avoid stale localStorage issues**.
6. **Ensure email flow configuration is user-friendly and correctly documented to prevent no-reset-email headaches**.
7. **Expose audit log experiences with filtering and summaries tailored for admins and supervisors**.
8. **Improve login UX with clear 2FA steps and optional reminders**.
9. **Add performance and pagination hints in patients and notes list views**.

# Claude/Cursor Prompt

```
Analyze the provided Halo Note backend and test codebase plus partial frontend setup with emphasis on practical physician and clinic administrator workflows. Identify explicit confusing workflows, onboarding gaps, UX friction, note review flow issues, and EHR integration weaknesses from the code and tests. Do not speculate beyond evidence in code or tests. Focus on speed, simplicity, reliability, trust, and workflow efficiency of real usage. Output a brutally frank list of critical product problems, UX friction points, critical bugs or gaps, MVP missing features prior to real deployment, user quit triggers, and highest ROI improvements tailored to Halo Note. Where possible, reference exact test or source files for evidence or lack thereof.
```