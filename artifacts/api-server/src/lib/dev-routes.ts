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
const ALLOW_FLAG = "1";

let warned = false;

export function devRoutesEnabled(): boolean {
  const isProd = process.env["NODE_ENV"] === "production";
  const flag = process.env["ALLOW_DEV_ROUTES"]?.trim();
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
