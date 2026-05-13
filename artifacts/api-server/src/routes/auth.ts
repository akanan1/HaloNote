import { randomUUID } from "node:crypto";
import { Router, type CookieOptions, type IRouter } from "express";
import { eq } from "drizzle-orm";
import {
  ConfirmPasswordResetBody,
  LoginBody,
  RequestPasswordResetBody,
  SignupBody,
} from "@workspace/api-zod";
import { getDb, usersTable } from "@workspace/db";
import {
  createSession,
  destroySession,
  findUserByEmail,
  hashPassword,
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
  const isProd = process.env["NODE_ENV"] === "production";
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
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
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }
    const email = parsed.data.email.toLowerCase().trim();
    const displayName = parsed.data.displayName.trim();

    const existing = await findUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: "email_already_registered" });
      return;
    }

    try {
      const passwordHash = await hashPassword(parsed.data.password);
      const [user] = await getDb()
        .insert(usersTable)
        .values({
          id: `usr_${randomUUID()}`,
          email,
          displayName,
          passwordHash,
        })
        .returning();
      if (!user) throw new Error("Insert returned no row");

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
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }

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
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_request", issues: parsed.error.issues });
      return;
    }

    const user = await findUserByEmail(parsed.data.email);
    // Compute a hash either way so timing doesn't leak whether an account exists.
    const ok = user
      ? await verifyPassword(parsed.data.password, user.passwordHash)
      : false;
    if (!user || !ok) {
      res.status(401).json({ error: "invalid_credentials" });
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

router.get("/auth/me", requireAuth, (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  if (!req.cookies?.[CSRF_COOKIE]) {
    setCsrfCookie(res, generateCsrfToken());
  }
  res.json({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    twoFactorEnabled: Boolean(user.totpEnabledAt),
  });
});

export default router;
