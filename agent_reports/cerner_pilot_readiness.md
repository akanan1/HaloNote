# Cerner Pilot Readiness — Static Audit

Scope: pre-pilot, resident-user workflow. Static analysis only. References Athena
only when its pattern reveals a Cerner gap. Recent mobile/sandbox-dev work taken
as ground truth.

---

## 1. Cerner SMART launch reliability

**Current state**

- Launch entrypoint: `artifacts/api-server/src/routes/ehr-oauth.ts:120-162`
  (`GET /auth/ehr/cerner/launch`). Validates `iss` against
  `CERNER_FHIR_BASE_URL` (`cerner-launch.ts:90-96`), validates `launch` token
  shape (`cerner-launch.ts:104-106`), starts OAuth flow with `launch=` passed
  through, 303 to authorize URL.
- Config: `cerner-launch.ts:52-69`. Required env: `CERNER_FHIR_BASE_URL`,
  `CERNER_AUTHORIZE_URL`, `CERNER_TOKEN_URL`, `CERNER_CLIENT_ID`,
  `CERNER_REDIRECT_URI`. `CERNER_CLIENT_SECRET` optional (public client).
- Default scopes: `openid fhirUser launch user/Patient.read user/Encounter.read
  offline_access` (`cerner-launch.ts:64-66`).
- PKCE: S256, 48-byte verifier (`ehr-oauth.ts:87-91`). State row TTL = 10 min
  (`ehr-oauth.ts:102`).
- Authorize URL builder adds `aud=fhirBaseUrl` plus `launch=` when present
  (`ehr-oauth.ts:140-151`).
- Token exchange detects public-client mode (empty `clientSecret`) and puts
  `client_id` in the form body instead of Basic auth
  (`ehr-oauth.ts:271-279`). Matches SMART for public clients.
- Unauthenticated launch path: 303 to `/login?next=<launch-url>`
  (`ehr-oauth.ts:142-148`); the SPA validates `next` via `safeNext`
  (`safe-redirect.ts:30-50`) and re-POSTs back to the launch URL after sign-in.
- Callback `/auth/ehr/callback` (`ehr-oauth.ts:175-286`) exchanges code,
  validates session-vs-state user match, on success upserts patient + redirects
  to NewNote.

**Risks**

- `[BLOCKER]` **Session cookie is `SameSite=Lax`** (`routes/auth.ts:49-55`).
  Cerner PowerChart embeds SMART apps in an iframe in many deployments. The
  initial GET to `/auth/ehr/cerner/launch` happens inside that iframe. A
  same-site Lax cookie ships on top-level GETs but is dropped on
  cross-site iframe navigations. If the resident's PowerChart launches
  HaloNote in an iframe, `req.user` will be null at the launch route → the
  server 303s to `/login?next=...`, but the login itself happens cross-site
  inside the iframe — Lax also blocks that. Result: silent infinite redirect
  to `/login` from inside Cerner, no clear error to the resident. If launched
  in a NEW WINDOW (top-level), this is fine. Confirm with operator whether
  Cerner is configured for new-window vs iframe; if iframe, need
  `SameSite=None; Secure` on the session cookie.
- `[SERIOUS]` **Error visibility is poor.** Callback failures `redirectToSettings`
  with raw codes (`user_mismatch`, `state_expired`, `exchange_failed`,
  `launch_patient_sync_failed`, `bad_issuer`, `cerner_not_configured`,
  `bad_launch_token`) — see `routes/ehr-oauth.ts:175-285`. The Settings page
  (`EhrConnectionSection.tsx:38-61`) just toasts `"Couldn't connect: ${errorCode}"`
  verbatim. A resident sees `"Couldn't connect: launch_patient_sync_failed"` with
  no remediation. Worse: the Settings page UI only renders Athena status — the
  Cerner error toast appears, but the user has nowhere to retry from the Halo
  UI (re-launching from inside Cerner is the only path).
- `[SERIOUS]` **`bad_issuer` and `cerner_not_configured` return 400/503 JSON**
  (`routes/ehr-oauth.ts:125-141`) instead of redirecting to a friendly page.
  Resident sees a raw JSON blob in their browser when env is misconfigured or
  Cerner sends an unexpected iss.
- `[MINOR]` `isCernerConfigured` requires `CERNER_AUTHORIZE_URL` / `CERNER_TOKEN_URL`
  but does not derive them from a SMART well-known discovery
  (`cerner-launch.ts:74-82`). If Cerner rotates endpoints on the sandbox tenant,
  the env must be updated by hand. Pilot-acceptable, but document the env list.
- `[MINOR]` State TTL is 10 min (`ehr-oauth.ts:102`) — fine for a normal flow
  but tight if the resident pauses on the Cerner consent screen to read it.
- `[MINOR]` `state_not_found` and `state_expired` collapse to the same effect
  from the resident's view (cryptic toast). At minimum, message them
  separately.

---

## 2. Patient context correctness

**Current state**

- Token-response parsing: `ehr-oauth.ts:373-384`. Pulls `patient` and `encounter`
  claims off the SMART token response, strips an optional `Patient/` /
  `Encounter/` prefix.
- Callback `/auth/ehr/callback` (`routes/ehr-oauth.ts:227-261`): for
  `provider === "cerner"` AND `launchContext.patient` present, calls
  `upsertCernerPatientFromLaunch` (`cerner-launch.ts:121-175`), which:
  - Does a one-shot FHIR `Patient/<id>` read with the just-minted access token.
  - Maps via `mapFhirPatient`.
  - Looks up by **MRN**, updates demographics if found, else inserts a new
    `pt_*` row.
  - Returns the internal patient id.
- Redirect: `buildLaunchReturnPath` → `/patients/<internalId>/notes/new?ehrId=<external>&encounterId=<...>&fromLaunch=1`
  (`cerner-launch.ts:187-197`).
- NewNote reads `ehrId` (`pages/NewNote.tsx:68-72, 103, 342-344`) and hands it
  to `<PatientContextPanel ehrPatientId={ehrPatientId} />`.

**Risks**

- `[BLOCKER]` **Wrong patient under MRN collision.** Patient upsert keys on MRN
  (`cerner-launch.ts:140-164`). If two patients share an MRN value across
  realms (HaloNote was previously seeded with `MRN-<externalId>` mocked rows by
  `patient-sync.ts:80`, AND another resident at the same tenant has previously
  used Athena flows or the demo seed), the Cerner launch will overwrite
  demographics on the existing row and return its `pt_*` id. The resident
  lands on a HaloNote patient page that points at the right name/DOB/MRN, but
  any **note history** already attached to that `pt_*` is from the prior
  patient. Worse: subsequent push-to-EHR for the just-typed note uses the
  Athena-side `Patient/<patient.id>` resource reference
  (`ehr-push.ts:60`) — which is the HALOnote internal id (`pt_xxx`), not the
  Cerner FHIR Patient id. The DocumentReference would be malformed for any
  upstream that doesn't accept arbitrary ids (Cerner write-back is out of
  scope per spec, so this is latent — but if you flip to non-mock,
  patient cross-contamination is real).
- `[SERIOUS]` **Missing `patient` claim falls through silently.** The callback
  only takes the Cerner-launch fast-path when `result.launchContext.patient`
  is truthy (`routes/ehr-oauth.ts:227-231`). If Cerner sends a token response
  with no `patient` claim (e.g. resident launched a "user-level" app context
  in PowerChart by mistake, or scope didn't include `launch/patient`), the
  fall-through lands on `/settings?ehrConnected=1&provider=cerner` — Settings
  has no Cerner block, so the resident sees a "Connected to cerner" toast
  and is on a page that pretends they're connected to Athena. There's no
  affordance to start a note in this state.
- `[SERIOUS]` **`PatientContextPanel` is hardwired to Athena.** It calls
  `GET /patients/:id/history` (`components/PatientContextPanel.tsx:19-28`),
  which goes through `getPatientHistory` (`lib/ehr-history.ts:66-83`). The
  per-user client path is `getAthenahealthClientForUser` only — it returns
  null for Cerner-connected users, then falls back to `resolveProvider()`
  (mock / athena / epic via `EHR_MODE`). For a resident on a Cerner launch,
  the chart panel will show:
  - mock data if `EHR_MODE` unset, or
  - Athena org-creds against the wrong tenant if `EHR_MODE=athenahealth`.
  The panel will display problems/meds/allergies that are NOT the Cerner
  patient's — a clinical-safety blocker if not caught. Recommend either: (a)
  hide the panel for `fromLaunch=1` flows, or (b) add a Cerner branch to
  `getPatientHistory`.

---

## 3. Encounter context correctness

**Current state**

- Encounter id is parsed from the token response (`ehr-oauth.ts:373-384`).
- It is included in `launchContext.encounter` and passed to
  `buildLaunchReturnPath` (`routes/ehr-oauth.ts:242`,
  `cerner-launch.ts:194`).
- The redirect URL is `/patients/<id>/notes/new?ehrId=...&encounterId=...&fromLaunch=1`.
- Frontend reads `ehrId` and `replaces`, but **does NOT read `encounterId`**.
  See `pages/NewNote.tsx:62-72` and full text search confirming `encounter`
  appears nowhere in `artifacts/provider-app/src` outside an unrelated comment.

**Risks**

- `[SERIOUS]` **Encounter context is silently dropped.** The id is on the URL
  but never read, never persisted on the note row, never on the
  DocumentReference (`lib/ehr-push.ts:59-72` — no `context.encounter` field).
  For Cerner residents this means: the note is not linked to the launching
  encounter inside HaloNote at all. The comment in `cerner-launch.ts:182-183`
  explicitly notes "persisting it onto the note row is a follow-up". It is
  still a follow-up.
- `[MINOR]` Schema (`lib/db/schema`, not re-read) presumably has no
  `encounterId` column on `notes`. Add a string column and read it in NewNote
  if the encounter link matters for the pilot.

---

## 4. Note autosave reliability

**Current state**

- `artifacts/provider-app/src/lib/use-note-autosave.ts:1-152`.
- Debounce: 1500ms (`use-note-autosave.ts:42`).
- First save = POST; subsequent saves PATCH the same row (`:81-98`).
- `lastSavedBodyRef` skips no-op saves (`:73`).
- `inFlightRef` coalesces concurrent flushes (`:76`).
- `flush()` cancels the debounce timer and persists immediately; called from
  Save draft / Save & send (`NewNote.tsx:248, 263`).
- Errors set `status="error"` and surface "Couldn't autosave" copy
  (`NewNote.tsx:574-583`).
- No `beforeunload` / `pagehide` / `visibilitychange` handler — confirmed by
  full-text search.

**Risks**

- `[BLOCKER]` **Last 1.5s of edits can be silently lost.** If the resident
  closes the tab, navigates back, or the OS kills the mobile Safari tab
  during the debounce window, the unsaved characters are gone. No
  `beforeunload` flush, no `visibilitychange`-triggered flush, no local-storage
  buffer. For residents typing under time pressure, this WILL happen and they
  WILL not know which words were lost.
- `[SERIOUS]` **Network loss is invisible.** On a failed PATCH the indicator
  flips to `"Couldn't autosave"` (`NewNote.tsx:574-583`) but the body in
  state is untouched. Subsequent edits keep retriggering the debounce; on
  network recovery the next debounce tick will save the full latest body
  (since `lastSavedBodyRef` is unchanged from before the failures). Net
  effect: works as long as the resident waits and re-types something to
  retrigger. If the resident hits "Save and Send" while offline, they get
  `setSendState({phase: "error", message: "Save failed."})` and no path to
  retry except clicking the button again — fine, but no auto-retry.
- `[SERIOUS]` **Session expiry mid-edit is cryptic.** Server returns 401
  `{error:"unauthenticated"}` (`middlewares/require-auth.ts:14-22`). The
  client has no global 401 interceptor — confirmed: no `getCurrentUser` /
  auto-redirect-to-login wiring beyond the initial mount (`lib/auth.tsx`).
  The autosave hook surfaces the error literally — toast says
  `"401: Unauthorized"` or similar from the generated `ApiError`. Resident
  has to manually navigate to /login; on return, the note body in state is
  gone (no draft restore). Compounds with the no-`beforeunload` gap.
- `[MINOR]` **Conflict handling on stale base.** `updateNote` is a plain
  PATCH — no `If-Match` / version check (verified: `lib/use-note-autosave.ts:84-87`
  sends `{ body }` only). If the resident has two tabs open on the same
  note, last-write-wins. Unlikely in clinic but worth noting.
- `[MINOR]` Empty bodies never persist (`:71-72`). When a resident types and
  then deletes everything, the saved row keeps the last non-empty body. Fine.
- `[MINOR]` Autosave is disabled during send (`NewNote.tsx:150-152`) — correct.

---

## 5. Export / copy / PDF workflow reliability

**Current state**

- `lib/note-export.ts` (pure utilities, no network).
- `parseNoteSections` heuristically detects S/O/A/P / A&P / Patient
  Instructions headers (`note-export.ts:14-89`).
- `copyTextToClipboard` uses `navigator.clipboard.writeText`, returns
  `false` on failure, no legacy fallback (`note-export.ts:225-239`).
- PDF = `window.print()` with `document.title` swap for filename
  (`pages/Note.tsx:696-720`).
- Print-only header in DOM (`Note.tsx:308-336`); CSS-only.
- Export menu disables sections that weren't detected
  (`Note.tsx:740-787`).
- Body rendered as `<p>` with `whitespace-pre-wrap break-words` (`Note.tsx:472-474`)
  — preserves newlines, escapes HTML via React.

**Risks**

- `[SERIOUS]` **Clipboard silent fail on mobile Safari.** `navigator.clipboard.writeText`
  requires a transient user activation AND HTTPS. The toast does cover the
  failure case ("Clipboard unavailable — try Print or PDF instead",
  `Note.tsx:691`) which is decent. But: on iOS Safari with Reduce Motion
  off and the dropdown's animation still happening, the activation
  sometimes lapses before the write resolves. Test on a real iPhone.
- `[SERIOUS]` **`window.print()` does not exist in some PowerChart
  iframes.** If the resident opens a finished note inside a Cerner iframe
  context, the print dialog may not pop / may print only the iframe
  contents (browser quirk). Pilot: instruct residents to open the note
  in its own tab before Print/PDF.
- `[MINOR]` **`buildPdfFilename` strips Unicode** (`note-export.ts:200-213`).
  Non-Latin patient surnames collapse to "patient". Cosmetic.
- `[MINOR]` `formatHeader` always includes the patient name / DOB / provider
  if available (`note-export.ts:101-111`). The print header (`Note.tsx:308-336`)
  intentionally omits DOB. The "Copy full note" text path (clipboard) WILL
  include DOB if the caller passes `dateOfBirth` — currently `ExportMenu`
  does NOT pass DOB (`Note.tsx:674-683`), so this is fine for now, but
  someone could regress it.
- `[MINOR]` **Combined `A/P` heading regex** (`note-export.ts:26-27`) matches
  `A/P:` but NOT a bare `A&P` without colon, NOR `Plan:` followed directly
  by `Assessment:`. A resident using shorthand may see "No A&P section
  detected" even when the note has content. Fix the regex if residents
  complain.
- `[MINOR]` Empty notes: `formatFullForCopy` produces just the header +
  empty body (`note-export.ts:114-119`). UI doesn't prevent copy on empty —
  but the body itself shows `Loading note…` until loaded, so the button
  isn't clickable. Fine in practice.
- `[MINOR]` Code blocks / structured sections preserved (`whitespace-pre-wrap`),
  but the parser treats lines starting with `Plan:` (e.g. resident pastes a
  drug-plan section starting with `Plan: continue current regimen`) as a
  section header instead of content. The header consumes the line. Caused by
  the `^[\t ]*plan[\t ]*:[\t ]*$` regex anchoring on end-of-line — actually
  this requires the line to END after the colon, so the false positive is
  avoided. Good.

---

## 6. Schedule workflow usability

**Current state**

- Server: `lib/ehr-schedule.ts:95-122` — `getSchedule` prefers
  `getAthenahealthClientForUser`, falls back to `EHR_MODE` provider, then
  mock.
- Route: `routes/schedule.ts:8-47`. Requires `user.ehrPractitionerId` (set
  by Athena OAuth `upsertConnection` at `ehr-oauth.ts:453-459`). Returns
  409 `ehr_not_linked` when missing.
- Frontend: `pages/Today.tsx`. Polls every 90s (`Today.tsx:47`). Empty
  state: `Today.tsx:391-397`. 409 → "Connect your EHR to see your
  schedule" card (`Today.tsx:258-281`). 502 → red "Couldn't load schedule"
  text (`Today.tsx:384-390`).

**Risks**

- `[BLOCKER]` **Cerner users see mock data on Today.** `getSchedule` only
  checks for an Athena per-user client (`ehr-schedule.ts:108-113`). A
  Cerner-connected resident with no Athena connection falls through to
  `EHR_MODE` mock unless `EHR_MODE=athenahealth` is set, in which case
  they get the org-level Athena schedule (wrong tenant — clinical safety
  hazard). On a fresh Cerner launch the resident does NOT typically use
  /Today (they enter via launch), but if they navigate to it from the
  bottom tab bar they'll see one of: (a) mock fake appointments, or (b)
  the wrong patient names. Either is bad first-impression material.
- `[SERIOUS]` `ehrPractitionerId` is populated by the Cerner OAuth path
  too — `ehr-oauth.ts:453-459` mirrors it onto users.ehrPractitionerId
  regardless of provider. So Cerner residents WILL get past the 409
  gate (`schedule.ts:14-18`) and reach the mock-or-Athena fallback above.
  Confirm: should /schedule/today simply 409 for Cerner-only users until
  Cerner schedule is wired? Currently it doesn't.
- `[SERIOUS]` **No "demo data" banner when Cerner-launched.** The Today
  banner reads `connStatus.data?.athenahealth?.connected`
  (`Today.tsx:160-162, 369-377`). A Cerner-only resident sees connected =
  false (because no Athena row), so they get the demo-data banner —
  fine, telling them it's mock. But if the operator sets
  `EHR_MODE=athenahealth` for the Cerner pilot deployment, the banner
  hides (because the appointments aren't from mock anymore) while the
  data is still wrong (wrong EHR tenant).
- `[MINOR]` Empty schedule renders cleanly (`Today.tsx:391-397`). Good.
- `[MINOR]` Refresh button works even when polling is paused
  (`Today.tsx:303-319`). Good.

---

## 7. Session persistence

**Current state**

- Session cookie: `halonote_session`, 7-day TTL, `httpOnly` true,
  `sameSite: "lax"`, `secure: isProd` (`routes/auth.ts:47-55`,
  `lib/auth.ts:36-37`).
- Server-side session: `sessionsTable` row keyed by random 32-byte id;
  TTL enforced on `lookupSession`.
- On mount, AuthProvider calls `getCurrentUser` (`/auth/me`) — sets
  `user=null` on 401 (`lib/auth.tsx:37-52`). No periodic re-check.
- No frontend session-refresh logic; cookie carries directly.

**Risks**

- `[BLOCKER]` **Cerner iframe + SameSite=Lax.** Already called out in §1.
  If launches happen inside a PowerChart iframe, the session cookie
  won't ship, the OAuth `state` row's user-binding won't match, and
  callbacks will fail with `state_not_found` → `user_mismatch`. Mitigation:
  switch session cookie to `SameSite=None; Secure` in pilot env, OR
  require Cerner to launch in a new window (operator-side fix). Verify
  with the deploying tenant.
- `[SERIOUS]` **No 401 → re-auth interceptor.** If the 7-day session
  expires mid-clinic-day, any API call returns 401, the corresponding
  TanStack-Query call surfaces an `ApiError`, and the user sees a
  cryptic error in whatever component triggered it. No automatic
  redirect to `/login`. For a resident who's been on the same browser
  tab for 8+ hours, this is realistic.
- `[MINOR]` Network blip: session cookie persists, so request retries
  succeed once connectivity returns. TanStack Query default retry policy
  applies. Acceptable for now.
- `[MINOR]` Disconnect endpoint exists for Athena/Cerner server-side
  (`routes/ehr-oauth.ts:296-313`), but the **Cerner provider isn't in
  the zod enum** (`lib/api-zod/src/generated/api.ts:858-880` —
  `provider: zod.enum(["athenahealth", "epic"])`). The SPA cannot call
  disconnect for Cerner; tokens persist until DB intervention.

---

## 8. Token refresh behavior

**Current state**

- `getValidAccessToken` (`lib/ehr-oauth.ts:503-550`).
- Refresh skew: 30s (`:496`).
- If `expiresAt - 30s > Date.now()`, return decrypted access token.
- Otherwise: if `refreshToken` null → throw `OauthExchangeError("no_refresh_token", 401)`.
- Else: POST `grant_type=refresh_token` to provider token URL via
  `postTokenEndpoint`. On success, encrypt + persist new access (and
  rotated refresh if returned) + new `expiresAt`.
- On failure: `postTokenEndpoint` throws `OauthExchangeError(...)` with
  upstream status (`:303-307`).

**Risks**

- `[SERIOUS]` **Refresh failure surfaces as raw 502 / 401 to the user.**
  If Cerner revokes the refresh token (admin action, scope change, or
  90-day refresh-token expiry typical of Cerner), the next per-user FHIR
  call (history fetch, schedule fetch, push-to-EHR) returns 502
  `ehr_unavailable` or 401, depending on the call path. The resident
  has no in-app prompt to re-launch from Cerner. They will toast-error
  through the day until somebody tells them to relaunch.
- `[SERIOUS]` **`clampExpiresIn` lower bound is 300s** (`:396-405`). If
  Cerner returns `expires_in: 60` for any reason, we cap up to 300 (so
  `expiresAt` is set 300s in the future) — we'll happily use a token
  past its actual expiry, then get a 401 from FHIR. Lower the clamp
  floor to 1s, or trust `expires_in` literally.
- `[MINOR]` Refresh is single-threaded per request (`getValidAccessToken`
  is called inside the FhirClient's `getToken` fn each fetch — multiple
  concurrent FHIR calls will each refresh once). Idempotent on Cerner
  since refresh_token may rotate; this is fine because each refresh's
  rotation is persisted, but TWO simultaneous refreshes COULD race and
  one's rotation could overwrite the other's stored token, breaking
  future refresh. In the Cerner-pilot single-resident path this is
  unlikely to bite — the schedule polls every 90s and history is fetched
  rarely. Mark for follow-up.
- `[MINOR]` Refresh path does NOT bump `practitionerId` if Cerner changes
  it (`:538-547`). Unlikely to matter mid-session.

---

## 9. Mobile workflow continuity

**Current state**

- Sticky bottom action bar uses
  `bottom-[calc(env(safe-area-inset-bottom)+3.5rem)] md:bottom-0` to clear
  the AppLayout tab bar on mobile (`NewNote.tsx:505-511`,
  `Note.tsx:438-444`).
- Bottom tab bar: `inset-x-0 bottom-0` with
  `pb-[env(safe-area-inset-bottom)]` (`AppLayout.tsx:164-167`).
- Recording UI: separate `RecordingPanel` component; not reviewed in
  depth for this pilot scope.
- Speech recognition: `useSpeechRecognition` hook; flagged as
  "Experimental — not HIPAA-grade" inline.
- No service worker, no offline cache (confirmed by absence of
  `serviceWorker` references).

**Risks**

- `[SERIOUS]` **Backgrounded mobile Safari may evict the autosave debounce
  timer.** When the OS pauses the JS runtime (lock screen, app switch,
  low-memory eviction), the 1500ms `setTimeout` does not fire reliably on
  iOS Safari. No `visibilitychange` flush exists. Pairs with the §4 blocker:
  resident types, locks phone, opens phone 10 min later → last 1.5s of
  edits never persisted. (Most edits ARE saved because each prior debounce
  fired before the lock; only the trailing edge is at risk. Still real.)
- `[SERIOUS]` **SMART launch from a mobile Cerner client is undefined.**
  Cerner's mobile PowerChart launches SMART apps via the device's
  default browser. On iOS that's Safari opening in a new tab — should
  work; on Android/Chrome via WebView (e.g. inside the Cerner app's
  in-app browser), session cookies are isolated to the WebView, so a
  resident who's already logged in via the regular Chrome browser will
  appear "not signed in" and bounce through `/login`. Test on a real
  mobile workflow with the operator before pilot.
- `[MINOR]` Speech recognition uses the browser Web Speech API
  (`use-speech-recognition.ts`, not re-read). On iOS Safari this routes
  through Apple's cloud transcription — the inline disclaimer is correct,
  but pilot residents should know not to rely on it for PHI-bearing
  dictation. Already disclaimed in UI (`NewNote.tsx:457-460`).
- `[MINOR]` PDF "Save as PDF" depends on the OS share sheet on iOS Safari.
  Test the flow once on a real iPhone before the pilot — `window.print`
  triggers the print preview, and the user has to manually pick "Save to
  Files" or "AirPrint → Save as PDF". `buildPdfFilename`'s title trick
  (`Note.tsx:706-720`) only takes effect on desktop.
- `[MINOR]` `disabled` set on textarea during `isBusy` (`NewNote.tsx:471`)
  pulls focus to the parent on iOS, which can cause the soft keyboard to
  dismiss mid-save. Visual jitter only.

---

# Live Validation Checklist

Walk through manually before any resident touches the app. Each item < 5
min, pass/fail.

1. **Cerner env present.** Server logs show no `CERNER_* is required`
   warning on startup. **PASS** if `GET /api/auth/ehr/cerner/launch?iss=foo`
   does NOT return `{"error":"cerner_not_configured"}` (returns
   `bad_issuer` instead). **FAIL** if 503.
2. **iss allow-list works.** `GET /api/auth/ehr/cerner/launch?iss=https://attacker.example/r4&launch=x`
   returns 400 `bad_issuer`. **PASS** = 400. **FAIL** = redirect.
3. **Launch token shape check.** `GET /api/auth/ehr/cerner/launch?iss=<correct>&launch=` (empty)
   returns 400 `bad_launch_token`. **PASS** = 400.
4. **Cookie SameSite for iframe.** Open browser devtools → Application →
   Cookies → halonote_session: SameSite column should be `None` (if
   targeting iframe-launched Cerner) or `Lax` (if new-window). Confirm
   matches the operator's intended Cerner app config.
   **FAIL** = Lax with iframe-launched config.
5. **Unauthenticated launch redirects to login.** In a clean
   incognito window, hit the launch URL with valid iss/launch from the
   Cerner sandbox; expect 303 → `/login?next=<encoded launch URL>`. After
   sign-in, expect another redirect to authorize URL, then back to
   `/patients/<id>/notes/new?...&fromLaunch=1`. **PASS** = lands on
   NewNote with the resident's chosen patient name visible.
6. **Wrong-user mid-flow guard.** Start a Cerner launch as user A. Before
   accepting the consent, sign out, sign in as user B, then complete the
   Cerner consent. **PASS** = redirect to /settings with
   `?error=user_mismatch`. **FAIL** = tokens bound to wrong user.
7. **Patient identity sanity.** After a successful Cerner launch, on
   NewNote: the patient block must show the SAME first name / last name /
   MRN as Cerner's launch context patient. Spot-check against PowerChart.
   **FAIL** = wrong patient.
8. **Chart context fidelity.** With the PatientContextPanel visible: the
   problems / meds / allergies shown match what PowerChart shows for the
   launch patient. **EXPECT FAIL** based on §2 risk — until
   `getPatientHistory` has a Cerner branch, this panel is showing
   mock/wrong-tenant data. Hide it or fix it before pilot.
9. **Autosave round-trip.** Type 3 characters into NewNote, wait 2
   seconds, observe "Saved Xs ago" indicator. Close tab. Reopen
   `/patients/<id>` → click the draft. Body matches. **PASS** = full text
   present. **FAIL** = trailing characters missing.
10. **Network-loss autosave.** Open NewNote, type, then in devtools set
    Network → Offline. Type more. Indicator should show "Couldn't
    autosave". Re-enable network, type one more character. Indicator
    returns to "Saving" then "Saved Xs ago". **PASS** = body persists in
    full.
11. **Save & Send happy path.** Click "Save & send to EHR" on a non-empty
    note. Status flips Saving → Sending → "Sent to EHR (provider — mock?)".
    Toast confirms. For Cerner pilot: confirm `mock: true` (since Cerner
    write-back is not wired and `EHR_MODE` should not be `athenahealth`
    for a Cerner-tenant deploy).
12. **Copy full note.** On a finished note, Export → Copy full note.
    Paste into a text editor. Header + body intact. **PASS**.
13. **Print / Save as PDF.** Export → Save as PDF. Print dialog opens
    with filename pre-filled to `halo-note-<patient>-<date>`. **PASS** =
    filename correct. On iPhone: AirPrint dialog opens; pinch + Save to
    Files works.
14. **Token expiry simulation.** In DB, manually update the resident's
    cerner row `expires_at` to `NOW() - INTERVAL '1 minute'`. Trigger a
    history fetch via the chart panel. Expect: server transparently
    refreshes, fetch succeeds. **PASS** = panel data loads. **FAIL** =
    error toast.
15. **Refresh-token revoke simulation.** In DB, set `refresh_token`
    column to a garbage string for the resident's cerner row, AND set
    `expires_at` in the past. Reload page. **PASS** = clear "please
    reconnect" prompt (or whatever you wire as the §1 SERIOUS fix).
    **FAIL** = generic 502/401 error with no remediation copy.
16. **Session expiry.** In DB, set the resident's session
    `expires_at` to past. Try to autosave. **PASS** = client redirects to
    /login. **FAIL** = silent error indicator that requires manual
    navigation (matches the §7 SERIOUS finding — fix before pilot).
17. **Mobile sticky action bar.** iPhone Safari, NewNote: scroll a long
    note. Save / Save&Send must remain visible above the bottom tab bar
    AND above the soft keyboard when typing. **PASS** = both visible.
18. **Mobile background-and-return.** On mobile: type, lock phone, wait
    30s, unlock. Autosave indicator should show "Saved Xs ago" with X
    ≥ 30. **PASS** = no error. **FAIL** = "Couldn't autosave".

---

# Top 5 Likely Workflow Failures

Ranked by likelihood × impact.

1. **Cerner iframe launch fails silently due to SameSite=Lax cookie.**
   Resident clicks the HaloNote tab in PowerChart, sees an endless
   redirect to /login that never completes. No error message, no
   support path. **Likelihood: high** (depends on the Cerner app
   configuration the operator chose, but iframe launches are common in
   PowerChart). **Impact: total — workflow does not start.**
   What the resident sees: a login screen they can't get past, or a
   blank iframe.
2. **PatientContextPanel shows the wrong patient's data.** On a Cerner
   launch, the chart panel below the note editor renders mock data (if
   `EHR_MODE` unset) or Athena tenant data (if `EHR_MODE=athenahealth`).
   The note header shows the right name; the chart context is wrong.
   **Likelihood: certain** (until the §2 fix lands).
   **Impact: clinical safety risk** — resident references wrong meds /
   allergies in their note.
   What the resident sees: a chart panel that "loads fine" but doesn't
   match what they expect from Cerner.
3. **Trailing edits lost on tab close / phone lock.** Resident types the
   last sentence of an assessment, locks the phone, walks to the next
   exam room. The 1.5s debounce never fired before the OS paused JS.
   When they reopen, the note ends one phrase earlier than they
   remember. **Likelihood: medium-high** (happens whenever the resident
   doesn't tap "Save draft" explicitly).
   **Impact: data loss, clinical-trust erosion.**
   What the resident sees: a draft that's "almost" what they typed.
4. **Refresh-token revocation produces a generic error mid-clinic.**
   Cerner sandbox refresh tokens have aggressive rotation/TTL behavior;
   the resident has been in HaloNote for hours, switches patients, and
   suddenly the chart panel won't load and "Send to EHR" errors out.
   No "please re-launch from Cerner" prompt.
   **Likelihood: medium** (sandbox refresh tokens regularly hit
   90-day-ish expirations, and Cerner sandbox tenants are reset
   periodically). **Impact: workflow halt.**
   What the resident sees: a red error like "EHR unavailable" or
   "Couldn't load patient context."
5. **Encounter context dropped.** Notes are filed under the patient,
   but the encounter id from PowerChart's launch is never persisted. If
   the resident later needs to match a note to its encounter (audit, AR
   reconciliation), there's nothing in HaloNote tying them.
   **Likelihood: certain** (until the §3 fix lands).
   **Impact: depends on how the pilot is being audited** — at minimum,
   loss of context for follow-up resident-program reviews.

---

# Minimal Fixes Required Before Pilot

Only small, audit-area-tied changes that genuinely block pilot use.

1. **Session cookie SameSite for Cerner iframe launches.**
   File: `artifacts/api-server/src/routes/auth.ts:47-55`.
   Change: when `process.env["SESSION_COOKIE_SAMESITE"] === "none"`,
   emit `sameSite: "none", secure: true`. Default remains lax.
   Why blocker: Cerner pilot may launch in an iframe; without this the
   resident cannot complete OAuth at all. Operator sets the env var
   per-deployment.

2. **Hide PatientContextPanel on Cerner launch until Cerner branch is
   wired.** File: `artifacts/provider-app/src/pages/NewNote.tsx:342-344`.
   Change: read `fromLaunch=1` from query, skip rendering the panel when
   set. Alternatively: read `connStatus.data?.athenahealth?.connected`
   and only render when true.
   Why blocker: avoids displaying wrong-patient/wrong-tenant chart data
   to a Cerner resident. Safer to hide than to show wrong data.

3. **Persist + read encounter id.** Files:
   - `artifacts/provider-app/src/pages/NewNote.tsx`: read
     `encounterId` query param alongside `ehrId` (one-liner mirroring
     `getEhrIdQueryParam` at `:68-72`), pass to the create-note call
     site at `:89-96` (and to the update payload).
   - Backend: add `encounterId` to the notes table + the create/update
     handlers (`routes/notes.ts`, schema + zod).
   Why blocker: if the pilot's audit requires encounter linkage, today's
   notes are not linkable. Small change, single-purpose.

4. **Beforeunload flush + visibilitychange flush in autosave hook.**
   File: `artifacts/provider-app/src/lib/use-note-autosave.ts`. Add a
   `useEffect` that registers `beforeunload` and `visibilitychange`
   listeners; on fire, synchronously `clearTimeout(timerRef.current)`
   and trigger `performSave()` (the request will be sent via
   `navigator.sendBeacon` or accept the small probability of the
   fetch being killed on real-unload — sendBeacon is better for true
   tab-close). At minimum a `visibilitychange === 'hidden'` flush.
   Why blocker: trailing-edge edit loss is the single most
   trust-killing failure mode for residents.

5. **Surface "please re-launch from Cerner" on refresh failure.**
   Files: `artifacts/api-server/src/lib/ehr-oauth.ts:516-518` (already
   throws `OauthExchangeError("no_refresh_token", 401)`) AND the route
   handlers that translate this. In `routes/patients.ts:167-181` and
   `routes/schedule.ts:32-46`, when err is `OauthExchangeError`,
   return a structured `{error: "ehr_reauth_required", provider:
   "cerner"}` rather than `ehr_unavailable`. Frontend: in
   `PatientContextPanel`, surface "Reconnect from Cerner to refresh
   chart context."
   Why blocker: cryptic 502s mid-clinic are the most likely thing to
   produce a support call.

6. **Strict `expires_in` floor.** File:
   `artifacts/api-server/src/lib/ehr-oauth.ts:396-405`. Change
   `if (!Number.isFinite(n) || n <= 0) return 300;` to `return 1;` (or
   `return 60;`). Trust the IdP. The current 300-floor masks token
   expiry and produces post-hoc 401s from FHIR.
   Why blocker: minor, but it's a one-line fix that prevents an entire
   class of mid-clinic refresh confusion.

7. **Include `cerner` in the disconnect/start zod enums.** Files:
   `lib/api-zod/src/generated/api.ts:858-880` plus the OpenAPI spec it
   regenerates from in `lib/api-spec`. Add `"cerner"` to the enum so
   the SPA can call `DELETE /api/auth/ehr/cerner` if a resident wants
   to unbind (debugging support).
   Why blocker: borderline — only really needed if a pilot resident
   gets stuck with bad tokens and needs to recover without DB access.
   Recommend including.

Items deliberately NOT proposed: Cerner UI block in Settings, Cerner
branch in `getSchedule`/`getPatientHistory`/`patient-sync`, write-back
DocumentReference. All would be useful but each is more than a
single-file change and the audit scope is "small fixes only."

---

# Manual Testing Scripts (numbered, click-by-click)

## A. Cold SMART launch from Cerner sandbox

1. Have a Cerner sandbox tenant configured with HaloNote registered as a
   provider-launch SMART app. Use the tenant's launch simulator (or
   PowerChart sandbox).
2. Sign out of HaloNote in all browser tabs (devtools → Application →
   clear `halonote_session`).
3. From the Cerner launcher: launch HaloNote against a known sandbox
   patient (e.g. Smart-1316007). Note the patient's name in PowerChart.
4. **Expected**: browser opens HaloNote. Lands on `/login?next=...`.
5. Sign in as a pre-provisioned resident account
   (`alice@halonote.example` / `hunter2` per dev seed).
6. **Expected**: page refreshes to the Cerner consent screen. Tap
   Accept.
7. **Expected**: redirect through `/api/auth/ehr/callback`. Eventually
   lands on `/patients/pt_xxx/notes/new?ehrId=Smart-1316007&fromLaunch=1`.
8. **Verify**: the patient name displayed on NewNote (top of page,
   "For Smith, Joe · MRN ...") matches the patient you launched against.
9. **Verify**: the PatientContextPanel either does NOT render (if fix
   #2 is in) or shows a "Loading patient context…" → eventually a data
   block. If it shows data, manually cross-reference against
   PowerChart's chart for that patient. Wrong = STOP, do not pilot.

## B. Mid-note network drop

1. Start at `/patients/<id>/notes/new` for a real patient (any).
2. Type at least 10 characters of body.
3. Wait 2 seconds. Indicator must say "Saved Xs ago".
4. Open devtools → Network → set throttling to **Offline**.
5. Type another sentence.
6. Wait 2 seconds. Indicator must say "Couldn't autosave" (red).
7. **DO NOT TYPE FURTHER YET.**
8. Set Network → Online.
9. Indicator should NOT recover until you type one more character —
    type a single character.
10. Wait 2 seconds. Indicator returns to "Saved Xs ago".
11. Navigate to `/patients/<id>`. The draft must show in the patient's
    note list and contain ALL the text you typed (including the
    offline portion).
12. **PASS** = full text present. **FAIL** = anything missing.

## C. Token expiry simulation

1. Connect Cerner (via launch flow A) or otherwise have a row in
   `ehr_connections` with `provider='cerner'` for your test user.
2. In a psql shell:
   ```sql
   UPDATE ehr_connections
   SET expires_at = NOW() - INTERVAL '1 minute'
   WHERE user_id = '<user_id>' AND provider = 'cerner';
   ```
3. In HaloNote, open NewNote for a patient. The chart panel should
   trigger a `/patients/<id>/history` fetch.
4. Watch server logs. **Expected**: log line showing a refresh-token
   POST to Cerner token URL, status 200, and a subsequent FHIR fetch.
5. **Verify**: chart panel renders without error.
6. **Verify** in psql: `expires_at` is in the future again, and
   `access_token` ciphertext has changed (`SELECT length(access_token)`
   should match before/after; treat the change in value as the signal).

## D. Token-refresh failure (revoked)

1. In psql, corrupt the refresh token for the test row:
   ```sql
   UPDATE ehr_connections
   SET refresh_token = 'deadbeef-not-a-real-token',
       expires_at = NOW() - INTERVAL '1 minute'
   WHERE user_id = '<user_id>' AND provider = 'cerner';
   ```
2. In HaloNote, hard-refresh the page. The session cookie is fine, so
   you're still signed in.
3. Open NewNote for a Cerner-originated patient. The chart panel
   triggers `/history`.
4. **Expected (current code)**: panel shows the amber "EHR is
   unavailable right now — chart context isn't loaded" card.
5. **Expected (with fix #5)**: panel shows "Reconnect from Cerner to
   refresh chart context" with a clearer remediation hint.
6. **Verify**: explicitly re-launching from the Cerner sandbox restores
   functionality (clears the bad refresh token via a fresh OAuth
   completion).

## E. Mobile background-and-return

1. On a real iPhone (iOS Safari) or Pixel (Chrome):
2. Sign in. Open NewNote for any patient.
3. Type 5 lines of clinical text.
4. **Without tapping Save draft**, lock the phone with the power
   button. Wait 90 seconds.
5. Unlock. The HaloNote tab should still be open.
6. **Verify**: the autosave indicator reads "Saved Xs ago" with X ≥
   90.
7. **Verify**: pull-down-to-refresh on the tab; the note draft is
   still listed in the patient's notes and the body matches.
8. **PASS** = body persists. **FAIL** = "Couldn't autosave" or
   missing text (matches the §9 SERIOUS risk).

## F. Patient switching mid-note

1. Open NewNote for patient A. Type 2 lines. Wait for "Saved".
2. Without using the back button, open a new tab and navigate to
   patient B's `/patients/<B>/notes/new`.
3. Type 2 lines in patient B's note. Wait for "Saved".
4. Switch back to tab A. Continue typing.
5. **Verify**: tab A's draft id (visible in dev as
   `autosave.draftId`) is different from tab B's.
6. **Verify**: in psql, the two draft rows have distinct `patient_id`
   and `id`.
7. **Verify**: both tabs' drafts show up under their respective
   patients on `/patients/<id>`.
8. Important: HaloNote does NOT show a "you have a draft on patient
   B" hint. Acceptable for pilot, but residents should be told.

## G. Schedule refresh — empty + non-empty states

1. (Empty) Set your device's date to a Saturday or Sunday OR use
   `EHR_MODE` unset. Navigate to `/`. Expected: "Nothing on your
   schedule today" with a calendar icon.
2. (Non-empty mock) Set device date to a weekday or use a weekday
   value via the date picker. Expected: 3-6 appointment cards.
3. Click the Refresh button. Spinner appears for ~200ms. Cards
   remain.
4. Click "Start note" on an appointment. Expected: navigates to
   `/patients/<id>/notes/new?ehrId=<patient.ehrId>`.
5. (Error) Disconnect Athena via Settings if connected. Reload `/`.
   For Cerner-only pilot users, expect either: demo data banner
   (mock), OR (post-fix) a Cerner-specific empty card. Confirm what
   you want pilot residents to see — there is no Cerner schedule
   branch yet.

## H. Logout / session timeout

1. Sign in. Open NewNote for any patient. Type 1 line. Wait for save.
2. In psql:
   ```sql
   UPDATE sessions SET expires_at = NOW() - INTERVAL '1 minute'
   WHERE user_id = '<user_id>';
   ```
3. Type another character in NewNote. Wait for the debounce.
4. **Expected (current)**: indicator goes to "Couldn't autosave" with
   error text mentioning 401.
5. **Expected (with a global 401 interceptor — see fix recommendation)**:
   automatic redirect to /login.
6. **Verify**: after re-signing in, navigate back to the note. Body
   contains the saved portion (whatever was persisted before the
   session went stale).

## I. Copy / Export of a finished note

1. From a finished note (`/patients/<id>/notes/<noteId>`), tap Export.
2. Tap "Copy full note". Toast: "Full note copied". Paste into a text
   editor. Verify header (CLINICAL NOTE, Patient, Date, Provider) plus
   full body.
3. Tap Export → "Copy SOAP note". If the note has S:/O:/A:/P: headers,
   toast "SOAP note copied" and the clipboard has just those blocks.
   If not, the menu item is disabled with sublabel "No SOAP sections
   detected".
4. Tap Export → "Copy patient instructions". Same pattern — only
   enabled when an "Instructions:" / "Patient Instructions:" header
   exists.
5. Tap Export → Print. Browser print dialog opens.
6. Tap Export → Save as PDF. Print dialog opens with filename
   pre-filled to `halo-note-<patient>-<YYYY-MM-DD>`. On desktop:
   select "Save as PDF" destination, save, open the PDF, verify
   header + body. On iPhone: AirPrint sheet appears; pinch out for
   PDF preview, share → Save to Files.
7. **Verify** on a note containing only "Plan: refill rx" (without
   trailing colon at end of line) — the parser should treat this as
   body, not as a header. **FAIL** = body shows as empty / "No
   sections detected".
8. **Verify** on a note containing a code-block-style fenced section.
   Should render with newlines preserved both on screen and in
   clipboard.

---

# Notes

- File-and-line citations in this report are accurate as of the
  repo state at audit time. If you edit any of these files, re-run
  the test scripts that reference them.
- Athena is mentioned only where its happy path exposes a gap the
  Cerner path inherits or duplicates.
- Severity tags reflect resident-pilot impact. A `[BLOCKER]` here is
  not a security issue (no PHI exfiltration risk in any finding) but
  a workflow-stopping or clinical-safety risk.
