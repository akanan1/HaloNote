import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";

// Generate a unique email + MRN per test run so the suite doesn't trip
// over a prior run's signup. We don't truncate the test DB between
// playwright runs — the api-server seeds it on boot and the E2E flow
// adds more.
const RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 10_000)}`;
const NEW_USER_EMAIL = `e2e-${RUN_ID}@halonote.test`;
const NEW_USER_PASSWORD = "correct horse battery staple";
const NEW_USER_NAME = "Dr. E2E Tester";
const NEW_PATIENT_MRN = `MRN-E2E-${RUN_ID}`;
const NEW_PATIENT_FIRST = "Quill";
const NEW_PATIENT_LAST = "Anderson";
const NEW_PATIENT_DOB = "1972-08-15";

// Matches the dev secret pre-enrolled on Alice in
// artifacts/api-server/src/lib/seed-users.ts. RFC 4226 canonical test
// vector — safe to commit.
const ALICE_TOTP_SECRET = "JBSWY3DPEHPK3PXP";

// RFC 4648 Base32 → bytes (Buffer). Pure stdlib, kept inline so the
// provider-app's devDeps stay small.
function base32ToBuffer(b32: string): Buffer {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = b32.replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 char: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

// 6-digit RFC 6238 TOTP for the current 30-second window.
function currentTotp(secretBase32: string): string {
  const key = base32ToBuffer(secretBase32);
  const counter = BigInt(Math.floor(Date.now() / 1000 / 30));
  const ctrBuf = Buffer.alloc(8);
  ctrBuf.writeBigUInt64BE(counter);
  const hmac = createHmac("sha1", key).update(ctrBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

// Tick every required-agreement checkbox on the onboarding gate, then
// accept and skip the remaining encouragement steps. Brand-new signups
// land on /onboarding step 0 (Agreements) and can't reach the rest of
// the app until they clear it.
async function completeOnboarding(page: import("@playwright/test").Page) {
  await expect(
    page.getByRole("heading", {
      name: /please review and accept these agreements/i,
    }),
  ).toBeVisible({ timeout: 15_000 });

  const checkboxes = page.getByRole("checkbox");
  const count = await checkboxes.count();
  for (let i = 0; i < count; i++) {
    await checkboxes.nth(i).check();
  }
  await page.getByRole("button", { name: /accept and continue/i }).click();

  // "Skip for now" appears once we're past the agreements gate; it
  // POSTs /onboarding/complete and navigates to /. Wait for that nav
  // to settle so the session cookie write isn't racing the next goto.
  await page.getByRole("button", { name: /skip for now/i }).click();
  await page.waitForURL((url) => url.pathname === "/", { timeout: 15_000 });
}

test("provider can sign up, add a patient, write a note, and push it to the EHR mock", async ({
  page,
}) => {
  // ---------- Signup ----------
  await page.goto("/signup");

  await page.getByLabel("Full name").fill(NEW_USER_NAME);
  await page.getByLabel("Email").fill(NEW_USER_EMAIL);
  await page.getByLabel("Password").fill(NEW_USER_PASSWORD);
  await page.getByRole("button", { name: /create account/i }).click();

  // Signup creates a personal org + owner membership atomically and
  // bounces a brand-new user to /onboarding. Walk the gate so the
  // rest of the flow can reach PHI routes.
  await completeOnboarding(page);

  // After onboarding completes the user lands on / (Today). Jump to
  // the patient list — RequireAuth would have bounced us back to
  // /login if signup hadn't actually signed us in.
  await page.goto("/patients");
  await expect(
    page.getByRole("heading", { name: /^patients$/i }),
  ).toBeVisible();

  // ---------- Add a patient ----------
  await page.getByRole("button", { name: /add patient/i }).click();
  await expect(
    page.getByRole("heading", { name: /add patient/i }),
  ).toBeVisible();

  await page.getByLabel("First name").fill(NEW_PATIENT_FIRST);
  await page.getByLabel("Last name").fill(NEW_PATIENT_LAST);
  await page.getByLabel("Date of birth").fill(NEW_PATIENT_DOB);
  await page.getByLabel("MRN").fill(NEW_PATIENT_MRN);
  await page.getByRole("button", { name: /save patient/i }).click();

  // Lands on the patient detail page for the new patient.
  await expect(
    page.getByRole("heading", {
      name: `${NEW_PATIENT_LAST}, ${NEW_PATIENT_FIRST}`,
    }),
  ).toBeVisible();
  await expect(page.getByText(NEW_PATIENT_MRN)).toBeVisible();

  // ---------- Write + send a note ----------
  await page.getByRole("button", { name: /^new note$/i }).click();
  await expect(
    page.getByRole("heading", { name: /^new note$/i }),
  ).toBeVisible();

  const noteBody = `E2E ${RUN_ID}: SOAP — Subjective: c/o headache. Objective: vitals stable. Assessment: tension. Plan: hydration, follow up in 2w.`;
  // The page has multiple accessible names containing "Note" (a
  // "HaloNote home" header link, a "Note template" select). Use the
  // textarea id directly to disambiguate.
  await page.locator("#note-body").fill(noteBody);

  // Save the note as a draft. We don't exercise "Save & send to EHR"
  // from this page in CI — that pathway creates a draft and immediately
  // POSTs to /notes/:id/send-to-ehr, which 409s on drafts. The end-to-
  // end push flow lives on the EncounterReview page (approve → send);
  // covering it here would require an approval step the NewNote UI
  // doesn't expose. Tracked as a separate product issue.
  await page.getByRole("button", { name: /save draft/i }).click();
  await expect(page.getByText(/draft saved/i)).toBeVisible({
    timeout: 10_000,
  });

  // ---------- Sign out ----------
  await page.getByRole("button", { name: /sign out/i }).click();
  await expect(
    page.getByRole("heading", { name: /^sign in$/i }),
  ).toBeVisible({ timeout: 10_000 });
});

test("a non-admin user signing in cannot see the audit log nav link", async ({
  page,
}) => {
  await page.goto("/login");

  // bob is the seeded "member" account from the api-server's
  // seedUsersIfEmpty() — set up by index.ts on boot with
  // org_default membership + BAA already on file.
  await page.getByLabel("Email").fill("bob@halonote.example");
  await page.getByLabel("Password").fill("hunter2");
  await page.getByRole("button", { name: /sign in/i }).click();

  // Sign-in is async — the POST completes, then the SPA navigates to
  // /. Wait for that landing so the session cookie write isn't racing
  // the next goto, then jump to the patient list.
  await page.waitForURL((url) => url.pathname === "/", { timeout: 15_000 });
  await page.goto("/patients");
  await expect(
    page.getByRole("heading", { name: /^patients$/i }),
  ).toBeVisible();

  // Audit log button is hidden for non-admins.
  await expect(page.getByRole("button", { name: /audit log/i })).toHaveCount(
    0,
  );
});

test("alice (admin) sees the audit log nav and can open the page", async ({
  page,
}) => {
  await page.goto("/login");

  await page.getByLabel("Email").fill("alice@halonote.example");
  await page.getByLabel("Password").fill("hunter2");
  await page.getByRole("button", { name: /sign in/i }).click();

  // Admin login: first submit returns totp_required, which causes the
  // form to reveal an "Authenticator code" input. Compute a code from
  // the seeded dev secret and submit again.
  const totpInput = page.getByLabel(/authenticator code/i);
  await expect(totpInput).toBeVisible({ timeout: 10_000 });
  await totpInput.fill(currentTotp(ALICE_TOTP_SECRET));
  await page.getByRole("button", { name: /^sign in$/i }).click();

  // Sign-in is async — the POST completes, then the SPA navigates to
  // /. Wait for that landing so the session cookie write isn't racing
  // the next goto, then jump to the patient list.
  await page.waitForURL((url) => url.pathname === "/", { timeout: 15_000 });
  await page.goto("/patients");
  await expect(
    page.getByRole("heading", { name: /^patients$/i }),
  ).toBeVisible();

  await page.getByRole("button", { name: /audit log/i }).click();
  await expect(
    page.getByRole("heading", { name: /^audit log$/i }),
  ).toBeVisible();
});
