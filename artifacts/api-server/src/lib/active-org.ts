import type { Request, Response } from "express";

// Returns the organization id the current request is acting on behalf of.
// Throws (and writes a 409 response) if the session has no active org.
//
// Use this from any route that creates or reads PHI. The "no active org"
// state is real and surfaceable: a user can be signed in but not yet
// part of any org (fresh signup before first invite/create), or their
// active org membership can have been revoked. The 409 with a stable
// code lets the frontend route the user to org-picker / first-run.
//
// This is intentionally a function-style assert rather than a middleware
// because (a) most routes also need other request data alongside the
// org id and (b) keeping the assert inline next to the DB call makes
// the tenancy boundary visible at the point of use.
export function getActiveOrgId(req: Request, res: Response): string | null {
  const orgId = req.activeOrganizationId;
  if (!orgId) {
    res.status(409).json({
      error: "no_active_organization",
      message:
        "This account is not currently acting on behalf of an organization.",
    });
    return null;
  }
  return orgId;
}
