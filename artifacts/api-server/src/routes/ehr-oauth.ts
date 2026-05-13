import { Router, type IRouter } from "express";
import {
  completeOauthFlow,
  deleteConnection,
  getConnection,
  OauthExchangeError,
  OauthStateError,
  startOauthFlow,
  type EhrProvider,
} from "../lib/ehr-oauth";
import { devRoutesEnabled } from "../lib/dev-routes";

const router: IRouter = Router();

const PROVIDERS: ReadonlySet<EhrProvider> = new Set(["athenahealth", "epic"]);

function parseProvider(raw: unknown): EhrProvider | null {
  if (typeof raw !== "string") return null;
  return PROVIDERS.has(raw as EhrProvider) ? (raw as EhrProvider) : null;
}

// Allow only same-origin paths so the callback can't be turned into an
// open-redirect via the returnPath query string.
function safeReturnPath(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  if (!raw.startsWith("/") || raw.startsWith("//")) return undefined;
  return raw;
}

// Begin a SMART OAuth handshake. The browser POSTs (CSRF-protected) and
// we hand it back the authorize URL. The frontend then sets
// window.location to that URL so the user lands on Athena's login.
router.post("/auth/ehr/:provider/start", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const provider = parseProvider(req.params.provider);
  if (!provider) {
    res.status(400).json({ error: "unknown_provider" });
    return;
  }
  const returnPath = safeReturnPath(
    (req.body as { returnPath?: unknown } | null)?.returnPath,
  );

  try {
    const { authorizeUrl } = await startOauthFlow({
      userId: user.id,
      provider,
      ...(returnPath ? { returnPath } : {}),
    });
    res.json({ authorizeUrl });
  } catch (err) {
    req.log.error({ err, provider }, "ehr oauth start failed");
    const message = err instanceof Error ? err.message : "start_failed";
    res.status(500).json({ error: "oauth_start_failed", message });
  }
});

// Dev-only GET seam for the start endpoint. Browser-automation tools
// sometimes can't reliably synthesize the click that triggers the
// React-driven POST, so this lets an E2E driver navigate directly to
// the authorize URL. Same auth (session cookie + state row) as the
// POST path; double-gated (NODE_ENV + ALLOW_DEV_ROUTES) via
// devRoutesEnabled().
if (devRoutesEnabled()) {
  router.get("/auth/ehr/:provider/dev-start", async (req, res) => {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: "unauthenticated" });
      return;
    }
    const provider = parseProvider(req.params.provider);
    if (!provider) {
      res.status(400).json({ error: "unknown_provider" });
      return;
    }
    const returnPath = safeReturnPath(req.query["return"]) ?? "/settings";
    try {
      const { authorizeUrl } = await startOauthFlow({
        userId: user.id,
        provider,
        returnPath,
      });
      req.log.warn({ provider }, "ehr dev-start used (non-production only)");
      res.redirect(303, authorizeUrl);
    } catch (err) {
      req.log.error({ err, provider }, "ehr oauth dev-start failed");
      res.status(500).json({ error: "oauth_start_failed" });
    }
  });
}

// The callback is hit by the browser following an Athena redirect, NOT
// by application code — it has to be a GET so the redirect carries.
// Auth on this route comes from the session cookie the user already
// has; the state parameter binds the flow to that user.
//
// IMPORTANT: This route bypasses the standard CSRF middleware because
// the request originates cross-site from Athena. The state parameter
// is the CSRF defense — it's bound to a server-side row, single-use,
// and TTL'd. Mounted as a GET at the top of the file so the global
// requireCsrf middleware (which only checks state-changing verbs)
// doesn't apply anyway.
router.get("/auth/ehr/callback", async (req, res) => {
  // The user must be signed in; the OAuth state row also encodes the
  // user id, so we double-check that whoever's session this is matches.
  const sessionUser = req.user;
  if (!sessionUser) {
    redirectToSettings(res, {
      ok: false,
      error: "not_signed_in",
    });
    return;
  }

  const code = typeof req.query["code"] === "string" ? req.query["code"] : "";
  const state =
    typeof req.query["state"] === "string" ? req.query["state"] : "";
  const upstreamError =
    typeof req.query["error"] === "string" ? req.query["error"] : null;

  if (upstreamError) {
    req.log.warn({ upstreamError }, "ehr oauth callback returned an error");
    redirectToSettings(res, { ok: false, error: upstreamError });
    return;
  }
  if (!code || !state) {
    redirectToSettings(res, { ok: false, error: "missing_params" });
    return;
  }

  try {
    const result = await completeOauthFlow({ code, state });
    if (result.userId !== sessionUser.id) {
      // Session/state mismatch — could mean the user signed out and back
      // in as someone else mid-flow. Refuse to bind the tokens to the
      // wrong account.
      req.log.warn(
        {
          stateUserId: result.userId,
          sessionUserId: sessionUser.id,
          provider: result.provider,
        },
        "ehr oauth user mismatch",
      );
      redirectToSettings(res, { ok: false, error: "user_mismatch" });
      return;
    }
    const returnPath = result.returnPath ?? "/settings";
    redirectToSettings(res, {
      ok: true,
      provider: result.provider,
      returnPath,
    });
  } catch (err) {
    if (err instanceof OauthStateError) {
      req.log.warn({ err: err.message }, "ehr oauth state invalid");
      redirectToSettings(res, { ok: false, error: err.message });
      return;
    }
    if (err instanceof OauthExchangeError) {
      req.log.warn(
        { status: err.status, message: err.message },
        "ehr oauth exchange failed",
      );
      redirectToSettings(res, { ok: false, error: "exchange_failed" });
      return;
    }
    req.log.error({ err }, "ehr oauth callback unexpected error");
    redirectToSettings(res, { ok: false, error: "callback_failed" });
  }
});

router.delete("/auth/ehr/:provider", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const provider = parseProvider(req.params.provider);
  if (!provider) {
    res.status(400).json({ error: "unknown_provider" });
    return;
  }
  const ok = await deleteConnection(user.id, provider);
  if (!ok) {
    res.status(404).json({ error: "not_connected" });
    return;
  }
  res.status(204).end();
});

router.get("/auth/ehr/status", async (req, res) => {
  const user = req.user;
  if (!user) {
    res.status(401).json({ error: "unauthenticated" });
    return;
  }
  const [athena] = await Promise.all([getConnection(user.id, "athenahealth")]);
  res.json({
    athenahealth: athena
      ? {
          connected: true,
          practitionerId: athena.practitionerId,
          scope: athena.scope,
          expiresAt: athena.expiresAt,
          updatedAt: athena.updatedAt,
        }
      : { connected: false },
  });
});

interface CallbackRedirectArgs {
  ok: boolean;
  provider?: EhrProvider;
  error?: string;
  returnPath?: string;
}

function redirectToSettings(
  res: import("express").Response,
  args: CallbackRedirectArgs,
): void {
  // The auth flow lands the user back in the provider-app. We use a
  // same-origin URL so the existing session cookie ships and the
  // Settings page can re-fetch /auth/ehr/status.
  const dest = args.returnPath ?? "/settings";
  const params = new URLSearchParams();
  params.set("ehrConnected", args.ok ? "1" : "0");
  if (args.provider) params.set("provider", args.provider);
  if (args.error) params.set("error", args.error);
  const url = `${dest}?${params.toString()}`;
  res.redirect(303, url);
}

export default router;
