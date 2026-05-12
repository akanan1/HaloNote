import { Router, type CookieOptions, type IRouter } from "express";
import { LoginBody } from "@workspace/api-zod";
import {
  createSession,
  destroySession,
  findUserByEmail,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  verifyPassword,
} from "../lib/auth";
import {
  CSRF_COOKIE,
  generateCsrfToken,
  setCsrfCookie,
} from "../lib/csrf";
import {
  loginEmailRateLimit,
  loginIpRateLimit,
} from "../middlewares/login-rate-limit";
import { requireAuth } from "../middlewares/require-auth";

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

router.post("/auth/login", loginIpRateLimit, loginEmailRateLimit, async (req, res) => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_request", issues: parsed.error.issues });
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

  const session = await createSession(user.id);
  res.cookie(SESSION_COOKIE, session.id, cookieOptions());
  setCsrfCookie(res, generateCsrfToken());
  res.json({ id: user.id, email: user.email, displayName: user.displayName });
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
    // requireAuth guarantees this, but TS doesn't know.
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  // Re-issue the CSRF cookie if it's missing — handles users who cleared
  // it independently of the session cookie, so they can keep mutating
  // without re-logging-in.
  if (!req.cookies?.[CSRF_COOKIE]) {
    setCsrfCookie(res, generateCsrfToken());
  }
  res.json({
    id: user.id,
    email: user.email,
    displayName: user.displayName,
  });
});

export default router;
