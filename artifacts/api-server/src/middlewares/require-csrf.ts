import type { RequestHandler } from "express";
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  isSafeMethod,
  timingSafeStringEqual,
} from "../lib/csrf";

// Double-submit cookie pattern: the SPA reads the halonote_csrf cookie via
// document.cookie and echoes it back as the X-CSRF-Token header. An attacker
// on another origin can't read the cookie (same-origin policy) and can't
// add a custom header on a forged request (browsers block cross-origin
// requests with non-CORS-safelisted headers without a preflight that the
// attacker can't satisfy without the API's CORS allowlist).
export const requireCsrf: RequestHandler = (req, res, next) => {
  if (isSafeMethod(req.method)) {
    next();
    return;
  }

  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get(CSRF_HEADER);

  if (
    typeof cookie !== "string" ||
    cookie.length === 0 ||
    typeof header !== "string" ||
    header.length === 0 ||
    !timingSafeStringEqual(cookie, header)
  ) {
    res.status(403).json({ error: "csrf_failed" });
    return;
  }

  next();
};
