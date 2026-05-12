import type { Request, RequestHandler } from "express";
import type { User } from "@workspace/db";
import { lookupSession, SESSION_COOKIE } from "../lib/auth";

declare module "express-serve-static-core" {
  interface Request {
    user?: User;
    sessionId?: string;
  }
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  const sessionId = readSessionCookie(req);
  if (!sessionId) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  const result = await lookupSession(sessionId);
  if (!result) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }

  req.user = result.user;
  req.sessionId = result.session.id;
  next();
};

function readSessionCookie(req: Request): string | null {
  const fromCookies = req.cookies?.[SESSION_COOKIE];
  if (typeof fromCookies === "string" && fromCookies.length > 0) {
    return fromCookies;
  }
  return null;
}
