import { logger } from "./logger";

// Second gate for the dev-only routes (dev-login, dev-start,
// dev-sandbox-patients). NODE_ENV alone has bitten us in other shops
// — a misconfigured Docker build, a CI variable that doesn't get
// passed through, a `node --env-file` typo, and you've shipped an
// auth bypass to prod. The explicit opt-in env var means the routes
// stay dormant unless someone deliberately turns them on, even in
// non-production environments.
//
// Both checks must pass to mount the routes:
//   1. NODE_ENV is not "production"
//   2. ALLOW_DEV_ROUTES is exactly "1"
//
// Production fail-closed posture: if NODE_ENV=production AND
// ALLOW_DEV_ROUTES is set to anything other than the explicit
// opt-out values below, this function THROWS on first call instead
// of silently ignoring the flag. Because all three call sites invoke
// devRoutesEnabled() at module-import time, the throw propagates up
// the import chain and crashes app boot before the server starts
// listening. The operator sees the misconfiguration in deploy logs
// immediately rather than running with a confusing partial-state
// deployment that would silently lose its safety the moment a
// future code change relaxes the !isProd guard.
const ALLOW_FLAG = "1";

// Values that explicitly mean "off" in a production deployment. An
// env template carrying ALLOW_DEV_ROUTES= (empty) or =0 / =false will
// not trigger the production throw — the operator has clearly opted
// out. Any other value is treated as "the operator intended to
// enable dev routes" and is rejected loudly.
const PROD_OPTOUT_VALUES: ReadonlySet<string> = new Set([
  "",
  "0",
  "false",
  "no",
  "off",
]);

let warned = false;

export function devRoutesEnabled(): boolean {
  const isProd = process.env["NODE_ENV"] === "production";
  const flag = process.env["ALLOW_DEV_ROUTES"]?.trim() ?? "";

  if (isProd && !PROD_OPTOUT_VALUES.has(flag.toLowerCase())) {
    // Fail-closed: refuse to boot rather than silently ignoring the
    // flag. The message intentionally tells the operator exactly
    // which env var is wrong and how to fix it.
    throw new Error(
      "ALLOW_DEV_ROUTES is set in a NODE_ENV=production deployment. " +
        "Dev-only routes (dev-login, dev-start, sandbox-patients) " +
        "expose unauthenticated session minting and CSRF-free OAuth " +
        "start — they must NEVER be enabled in production. Unset " +
        "ALLOW_DEV_ROUTES (or set it to one of: 0, false, no, off) " +
        "and redeploy.",
    );
  }

  const enabled = !isProd && flag === ALLOW_FLAG;
  if (enabled && !warned) {
    warned = true;
    logger.warn(
      "Dev-only routes are mounted (ALLOW_DEV_ROUTES=1, NODE_ENV != production). " +
        "These include unauthenticated session minting (/api/auth/dev-login), " +
        "a CSRF-free OAuth start (/api/auth/ehr/:provider/dev-start), and a " +
        "live Athena sandbox read (/api/dev/sandbox-patients). They must NEVER " +
        "ship in a production environment.",
    );
  }
  return enabled;
}

// Exposed only so tests can clear the warn-once latch between cases.
// Not exported from the package index.
export function _resetForTests(): void {
  warned = false;
}
