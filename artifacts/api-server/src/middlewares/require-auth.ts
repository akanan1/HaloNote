import type { Request, RequestHandler } from "express";
import type { User } from "@workspace/db";
import { lookupSession, SESSION_COOKIE } from "../lib/auth";

declare module "express-serve-static-core" {
  interface Request {
    user?: User;
    sessionId?: string;
    // The org the session is currently acting on behalf of. Set when
    // the session's `active_organization_id` is non-null AND the user
    // still has an active membership in that org. Null otherwise —
    // routes that touch PHI must gate on this being a string (use the
    // `getActiveOrgId(req)` helper to assert + extract).
    activeOrganizationId?: string;
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
  // Trust the session's stored active org for now. Phase 0c will add a
  // freshness check against organization_members.is_active and tighten
  // this to refuse requests whose membership has been revoked.
  req.activeOrganizationId = result.session.activeOrganizationId ?? undefined;
  next();
};

function readSessionCookie(req: Request): string | null {
  const fromCookies = req.cookies?.[SESSION_COOKIE];
  if (typeof fromCookies === "string" && fromCookies.length > 0) {
    return fromCookies;
  }
  return null;
}
