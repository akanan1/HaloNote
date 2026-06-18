import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Response } from "express";
import { resolveSessionCookieMode } from "./auth";

export const CSRF_COOKIE = "halonote_csrf";
export const CSRF_HEADER = "x-csrf-token";

const TOKEN_BYTES = 32;
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function generateCsrfToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

export function setCsrfCookie(res: Response, token: string): void {
  // Tracks the session cookie's SameSite/secure mode so both cookies
  // ship (or don't) under the same browser rules. If we left this as
  // sameSite=lax while the session is SameSite=None for an iframe
  // launch, the iframe would load with a session cookie but no CSRF
  // cookie, and the first POST would 403.
  const mode = resolveSessionCookieMode();
  // httpOnly: false on purpose — the SPA must be able to read this cookie
  // via document.cookie and echo it back as the X-CSRF-Token header. The
  // value is non-secret; security comes from the same-origin policy
  // preventing a cross-origin attacker from reading it.
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    sameSite: mode.sameSite,
    secure: mode.secure,
    path: "/",
    maxAge: TTL_MS,
  });
}

export function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
