import { randomUUID } from "node:crypto";
import { respondInvalidBody } from "../http";
import { Router, type CookieOptions, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  ConfirmPasswordResetBody,
  LoginBody,
  RequestPasswordResetBody,
  SignupBody,
  UpdateMeBody,
} from "@workspace/api-zod";
import {
  getDb,
  organizationMembersTable,
  organizationsTable,
  usersTable,
} from "@workspace/db";
import {
  createSession,
  destroySession,
  findUserByEmail,
  hashPassword,
  resolveSessionCookieMode,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  verifyPassword,
} from "../lib/auth";
import { generateTotpSecret, verifyTotpCode } from "../lib/totp";
import QRCode from "qrcode";
import {
  CSRF_COOKIE,
  generateCsrfToken,
  setCsrfCookie,
} from "../lib/csrf";
import { sendEmail } from "../lib/email";
import {
  findValidResetToken,
  issuePasswordResetToken,
  markResetTokenUsed,
} from "../lib/password-reset";
import {
  loginEmailRateLimit,
  loginIpRateLimit,
} from "../middlewares/login-rate-limit";
import {
  passwordResetEmailRateLimit,
  passwordResetIpRateLimit,
  signupIpRateLimit,
} from "../middlewares/password-reset-rate-limit";
import { requireAuth } from "../middlewares/require-auth";
import { devRoutesEnabled } from "../lib/dev-routes";

const router: IRouter = Router();

function cookieOptions(): CookieOptions {
  const mode = resolveSessionCookieMode();
  return {
    httpOnly: true,
    sameSite: mode.sameSite,
    secure: mode.secure,
    path: "/",
    maxAge: SESSION_TTL_MS,
  };
}

async function startSession(
  res: import("express").Response,
  userId: string,
): Promise<void> {
  const session = await createSession(userId);
  res.cookie(SESSION_COOKIE, session.id, cookieOptions());
  setCsrfCookie(res, generateCsrfToken());
}

// Dev-only sign-in via URL — used by browser-driven E2E flows where
// typing into a React-controlled <input> is unreliable. Double-gated:
// NODE_ENV != "production" AND ALLOW_DEV_ROUTES=1 (see lib/dev-routes).
// The browser hits this directly, the response sets the session
// cookies, and we 303 back.
if (devRoutesEnabled()) {
  router.get("/auth/dev-login", async (req, res) => {
    const emailRaw = req.query["email"];
    const email =
      typeof emailRaw === "string" ? emailRaw.toLowerCase().trim() : "";
    if (!email) {
      res.status(400).json({ error: "missing_email" });
      return;
    }
    const user = await findUserByEmail(email);
    if (!user) {
      res.status(404).json({ error: "no_such_user" });
      return;
    }
    await startSession(res, user.id);
    const returnRaw = req.query["return"];
    const returnTo =
      typeof returnRaw === "string" &&
      returnRaw.startsWith("/") &&
      !returnRaw.startsWith("//")
        ? returnRaw
        : "/";
    req.log.warn({ email }, "dev-login used (non-production only)");
    res.redirect(303, returnTo);
  });
}

router.post(
  "/auth/signup",
  signupIpRateLimit,
  async (req, res) => {
    const parsed = SignupBody.safeParse(req.body);
    if (!parsed.success) return respondInvalidBody(res, parsed.error);
    const email = parsed.data.email.toLowerCase().trim();
    const displayName = parsed.data.displayName.trim();

    const existing = await findUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: "email_already_registered" });
      return;
    }

    try {
      const passwordHash = await hashPassword(parsed.data.password);

      // Atomic: user, their personal organization, and their owner
      // membership are created together. A signup must never produce
      // a user with no org (which would 409 every subsequent PHI
      // request via getActiveOrgId). The org defaults to a generic
      // name + slug — the user can rename it from Settings later.
      const orgId = `org_${randomUUID()}`;
      const orgSlug = `org-${orgId.slice(4, 12)}`;
      const orgName = `${displayName}'s Organization`;

      const user = await getDb().transaction(async (tx) => {
        const [u] = await tx
          .insert(usersTable)
          .values({
            id: `usr_${randomUUID()}`,
            email,
            displayName,
            passwordHash,
          })
          .returning();
        if (!u) throw new Error("User insert returned no row");

        await tx.insert(organizationsTable).values({
          id: orgId,
          name: orgName,
          slug: orgSlug,
        });

        await tx.insert(organizationMembersTable).values({
          organizationId: orgId,
          userId: u.id,
          role: "owner",
          joinedAt: new Date(),
        });

        return u;
      });

      // Welcome email — fire-and-forget. Signup must not fail if the
      // email provider is degraded; the user already has an account
      // and an active session by this point.
      sendEmail({
        to: user.email,
        subject: "Welcome to HaloNote",
        body:
          `Hi ${user.displayName},\n\n` +
          `Welcome to HaloNote. Your account is ready — you're already signed in.\n\n` +
          `Next steps:\n` +
          `  • Connect your EHR (Athena, Cerner, or Epic) so notes can be pushed back to the chart.\n` +
          `  • Record your first encounter and review the generated note.\n` +
          `  • Invite a colleague if your practice is rolling this out as a team.\n\n` +
          `If anything's off, just reply to this email — it goes to a real person.\n\n` +
          `— The HaloNote team`,
      }).catch((err) => {
        req.log.warn({ err, userId: user.id }, "welcome email failed to send");
      });

      await startSession(res, user.id);
      res.status(201).json({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      });
    } catch (err) {
      // 23505 unique_violation can race past the findUserByEmail check
      // under concurrent signups for the same address.
      const e = err as { code?: unknown; cause?: { code?: unknown } };
      if (e.code === "23505" || e.cause?.code === "23505") {
        res.status(409).json({ error: "email_already_registered" });
        return;
      }
      req.log.error({ err }, "Failed to create user");
      res.status(500).json({ error: "persistence_failed" });
    }
  },
);

router.post(
  "/auth/password-reset/request",
  passwordResetIpRateLimit,
  passwordResetEmailRateLimit,
  async (req, res) => {
    const parsed = RequestPasswordResetBody.safeParse(req.body);
    // 204 even on validation failure — don't reveal what the server thinks
    // about the input. Reset abuse is bounded by the rate limiters above.
    if (!parsed.success) {
      res.status(204).end();
      return;
    }
    const email = parsed.data.email.toLowerCase().trim();
    const user = await findUserByEmail(email);

    if (user) {
      const { raw } = await issuePasswordResetToken(user.id);
      const appBase = process.env["APP_BASE_URL"] ?? "http://localhost:5174";
      const link = `${appBase}/reset-password?token=${encodeURIComponent(raw)}`;
      await sendEmail({
        to: user.email,
        subject: "Reset your HaloNote password",
        body:
          `Hi ${user.displayName},\n\n` +
          `Use this link to choose a new password. It's valid for 1 hour.\n\n` +
          `${link}\n\n` +
          `If you didn't ask for this, you can ignore the email.`,
      });
    }

    // Always 204, regardless of whether the email exists. User enumeration
    // defense — paired with the per-email + per-IP rate limiters above.
    res.status(204).end();
  },
);

router.post(
  "/auth/password-reset/confirm",
  passwordResetIpRateLimit,
  async (req, res) => {
    const parsed = ConfirmPasswordResetBody.safeParse(req.body);
    if (!parsed.success) return respondInvalidBody(res, parsed.error);

    const token = await findValidResetToken(parsed.data.token);
    if (!token) {
      res.status(400).json({ error: "invalid_or_expired_token" });
      return;
    }

    try {
      const passwordHash = await hashPassword(parsed.data.password);
      const db = getDb();
      await db
        .update(usersTable)
        .set({ passwordHash })
        .where(eq(usersTable.id, token.userId));
      await markResetTokenUsed(token.id);

      // Auto-login: the act of clicking the email link proved access to
      // the inbox; making them sign in again is friction without value.
      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, token.userId))
        .limit(1);
      if (!user) throw new Error("User vanished between update and select");

      await startSession(res, user.id);
      res.json({
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
      });
    } catch (err) {
      req.log.error({ err }, "Password reset confirm failed");
      res.status(500).json({ error: "persistence_failed" });
    }
  },
);

router.post(
  "/auth/login",
  loginIpRateLimit,
  loginEmailRateLimit,
  async (req, res) => {
    const parsed = LoginBody.safeParse(req.body);
    if (!parsed.success) return respondInvalidBody(res, parsed.error);

    const user = await findUserByEmail(parsed.data.email);
    // Compute a hash either way so timing doesn't leak whether an account exists.
    const ok = user
      ? await verifyPassword(parsed.data.password, user.passwordHash)
      : false;
    if (!user || !ok) {
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }

    // Admin accounts MUST have TOTP enrolled. We enforce at promotion
    // time (PATCH /users/:id refuses promoting a user without TOTP) but
    // we re-check here so a legacy admin row (or DB tampering) still
    // can't ride a password-only login into the audit log endpoint.
    //
    // The user is told what's wrong but doesn't get a session. Recovery
    // runbook: another admin demotes them to `member`, they enroll TOTP
    // (POST /auth/2fa/setup + verify-setup), then get re-promoted.
    if (user.role === "admin" && !user.totpEnabledAt) {
      req.log.warn(
        { userId: user.id },
        "auth: refusing admin login — TOTP not enrolled",
      );
      res.status(403).json({ error: "totp_required_for_admin" });
      return;
    }

    if (user.totpEnabledAt && user.totpSecret) {
      // Password is valid but 2FA is required. Caller resubmits with
      // `totpCode`. Returning 401 with a specific error makes the flow
      // explicit on the wire — the frontend pivots to the 2FA prompt.
      const totpCodeRaw = (req.body as { totpCode?: unknown }).totpCode;
      const totpCode = typeof totpCodeRaw === "string" ? totpCodeRaw : "";
      if (!totpCode) {
        res.status(401).json({ error: "totp_required" });
        return;
      }
      if (!verifyTotpCode(user.totpSecret, totpCode)) {
        res.status(401).json({ error: "invalid_totp_code" });
        return;
      }
    }

    await startSession(res, user.id);
    res.json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
    });
  },
);

// ---------------------------------------------------------------------------
// 2FA (TOTP) — RFC 6238, 6-digit codes, 30s period, ±1 window.
//
// Setup flow:
//   1. POST /auth/2fa/setup        → caller authenticated; returns secret,
//                                    otpauth URI, QR data URL. Persists the
//                                    secret but leaves totpEnabledAt null.
//   2. POST /auth/2fa/verify-setup → { code }; if valid, sets totpEnabledAt.
//   3. POST /auth/2fa/disable      → { code }; clears both fields.
// ---------------------------------------------------------------------------

router.post("/auth/2fa/setup", requireAuth, async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  if (user.totpEnabledAt) {
    res.status(409).json({ error: "totp_already_enabled" });
    return;
  }

  const handle = generateTotpSecret(user.email);
  await getDb()
    .update(usersTable)
    .set({ totpSecret: handle.secret, totpEnabledAt: null })
    .where(eq(usersTable.id, user.id));

  // Generate a QR data URL so the frontend can `<img src={qr}>` without
  // pulling in a QR library client-side. ~1 KB for a 6-digit TOTP URI.
  const qrDataUrl = await QRCode.toDataURL(handle.uri, { margin: 0 });

  res.json({
    secret: handle.secret,
    otpauthUri: handle.uri,
    qrDataUrl,
  });
});

router.post("/auth/2fa/verify-setup", requireAuth, async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const code = (req.body as { code?: unknown }).code;
  if (typeof code !== "string" || code.trim().length === 0) {
    res.status(400).json({ error: "missing_code" });
    return;
  }

  // Re-read the user so we have the latest totpSecret (the auth-injected
  // user may be stale — it comes from req.user populated by middleware).
  const [fresh] = await getDb()
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, user.id))
    .limit(1);
  if (!fresh || !fresh.totpSecret) {
    res.status(409).json({ error: "totp_setup_not_started" });
    return;
  }
  if (fresh.totpEnabledAt) {
    res.status(409).json({ error: "totp_already_enabled" });
    return;
  }
  if (!verifyTotpCode(fresh.totpSecret, code)) {
    res.status(400).json({ error: "invalid_totp_code" });
    return;
  }

  await getDb()
    .update(usersTable)
    .set({ totpEnabledAt: new Date() })
    .where(eq(usersTable.id, fresh.id));
  res.status(204).end();
});

router.post("/auth/2fa/disable", requireAuth, async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const code = (req.body as { code?: unknown }).code;
  if (typeof code !== "string" || code.trim().length === 0) {
    res.status(400).json({ error: "missing_code" });
    return;
  }

  const [fresh] = await getDb()
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, user.id))
    .limit(1);
  if (!fresh?.totpSecret || !fresh.totpEnabledAt) {
    res.status(409).json({ error: "totp_not_enabled" });
    return;
  }
  // Admins can't un-enroll TOTP — they'd be locked out by the login
  // enforcement above. The supported path is: get demoted to `member`
  // first, then disable. Keeps the "admin always has TOTP" invariant.
  if (fresh.role === "admin") {
    res.status(403).json({ error: "totp_required_for_admin" });
    return;
  }
  if (!verifyTotpCode(fresh.totpSecret, code)) {
    res.status(400).json({ error: "invalid_totp_code" });
    return;
  }

  await getDb()
    .update(usersTable)
    .set({ totpSecret: null, totpEnabledAt: null })
    .where(eq(usersTable.id, fresh.id));
  res.status(204).end();
});

router.post("/auth/logout", async (req, res) => {
  const sid = req.cookies?.[SESSION_COOKIE];
  if (typeof sid === "string" && sid.length > 0) {
    await destroySession(sid);
  }
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined });
  res.clearCookie(CSRF_COOKIE, { path: "/" });
  res.status(204).end();
});

function serializeMe(user: typeof usersTable.$inferSelect) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    twoFactorEnabled: Boolean(user.totpEnabledAt),
    onboardingCompleted: Boolean(user.onboardingCompletedAt),
    isFounder: Boolean(user.isFounder),
    autoPushMode: user.autoPushMode,
    silenceAutoStopSec: user.silenceAutoStopSec,
    autoPushOrders: Boolean(user.autoPushOrders),
    autoPushMedications: Boolean(user.autoPushMedications),
    autoApproveNonMedOrders: Boolean(user.autoApproveNonMedOrders),
    mobileOnboarded: Boolean(user.mobileOnboardedAt),
  };
}

router.get("/auth/me", requireAuth, (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  if (!req.cookies?.[CSRF_COOKIE]) {
    setCsrfCookie(res, generateCsrfToken());
  }
  res.json(serializeMe(user));
});

// Self-update of the signed-in user's preferences. Currently scoped
// to autoPushMode + silenceAutoStopSec; expand the body schema rather than adding more
// endpoints when more knobs land. CSRF + auth come from the global
// middleware stack; we explicitly require auth here too as belt+
// suspenders.
router.patch("/auth/me", requireAuth, async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const parsed = UpdateMeBody.safeParse(req.body);
  if (!parsed.success) return respondInvalidBody(res, parsed.error);
  const updates: Partial<typeof usersTable.$inferInsert> = {};
  if (parsed.data.autoPushMode !== undefined) {
    updates.autoPushMode = parsed.data.autoPushMode;
  }
  if (parsed.data.silenceAutoStopSec !== undefined) {
    updates.silenceAutoStopSec = parsed.data.silenceAutoStopSec;
  }
  if (parsed.data.autoPushOrders !== undefined) {
    updates.autoPushOrders = parsed.data.autoPushOrders;
  }
  if (parsed.data.autoPushMedications !== undefined) {
    updates.autoPushMedications = parsed.data.autoPushMedications;
  }
  if (Object.keys(updates).length === 0) {
    // No-op patch — just echo the current state. Saves a write but
    // keeps the response shape consistent so callers don't have to
    // branch on the partial-vs-empty body case.
    res.json(serializeMe(user));
    return;
  }
  const [updated] = await getDb()
    .update(usersTable)
    .set(updates)
    .where(eq(usersTable.id, user.id))
    .returning();
  if (!updated) {
    res.status(500).json({ error: "persistence_failed" });
    return;
  }
  res.json(serializeMe(updated));
});

export default router;
