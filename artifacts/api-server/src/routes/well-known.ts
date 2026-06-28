import { Router, type IRouter } from "express";
import {
  buildJwksDocument,
  type JwksDocument,
  type JwkSource,
} from "../lib/jwks-publish";

const router: IRouter = Router();

// PEM in an env var means embedded newlines, which most shells / .env
// loaders preserve OK but some serialize as the literal string "\n".
// Normalize both shapes so operators don't have to think about it.
function normalizePem(raw: string): string {
  return raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
}

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Epic forces distinct JWKS URLs for sandbox vs production (a real
// security boundary — sandbox key compromise must not affect prod).
// We serve two endpoints from one api-server, gated by separate env
// var families.
type Env = "production" | "sandbox";

interface EnvVarNames {
  privateKey: string;
  keyId: string;
  algorithm: string;
}

const ENV_VARS: Record<Env, EnvVarNames> = {
  production: {
    privateKey: "EPIC_PRIVATE_KEY",
    keyId: "EPIC_KEY_ID",
    algorithm: "EPIC_ALGORITHM",
  },
  sandbox: {
    privateKey: "EPIC_PRIVATE_KEY_SANDBOX",
    keyId: "EPIC_KEY_ID_SANDBOX",
    algorithm: "EPIC_ALGORITHM_SANDBOX",
  },
};

// Returning an empty `keys: []` when env vars are unset is deliberate:
// the route stays HTTP-200 so Epic gets a well-formed response, but
// signature verification will fail at the IdP rather than at our edge.
// That makes the misconfiguration obvious in Epic's logs (and ours)
// instead of presenting as a 404 that masquerades as a transient outage.
const cachedDocs: Partial<Record<Env, JwksDocument>> = {};
const cachedFingerprints: Partial<Record<Env, string>> = {};

function computeJwks(env: Env): JwksDocument {
  const names = ENV_VARS[env];
  const pem = readEnv(names.privateKey);
  const kid = readEnv(names.keyId);
  const alg = readEnv(names.algorithm) ?? "ES384";
  const sources: JwkSource[] =
    pem && kid
      ? [{ privateKeyPem: normalizePem(pem), kid, algorithm: alg }]
      : [];
  return buildJwksDocument(sources);
}

function getJwksDocument(env: Env): JwksDocument {
  // Bust the cache if the operative env vars changed (relevant for
  // tests that mutate process.env between cases).
  const names = ENV_VARS[env];
  const fp = `${process.env[names.privateKey] ?? ""}|${
    process.env[names.keyId] ?? ""
  }|${process.env[names.algorithm] ?? ""}`;
  if (!cachedDocs[env] || fp !== cachedFingerprints[env]) {
    cachedDocs[env] = computeJwks(env);
    cachedFingerprints[env] = fp;
  }
  return cachedDocs[env] as JwksDocument;
}

/** Exported for tests; do not call from production code. */
export function _resetJwksPublishCacheForTests(): void {
  delete cachedDocs.production;
  delete cachedDocs.sandbox;
  delete cachedFingerprints.production;
  delete cachedFingerprints.sandbox;
}

function serveJwks(env: Env) {
  return (_req: import("express").Request, res: import("express").Response) => {
    const doc = getJwksDocument(env);
    // SMART best practice: long cache + immutable kids. If we ever
    // rotate keys, the new kid will be added BEFORE the old one is
    // removed, so mid-flight verifications can still find their key.
    res.setHeader("cache-control", "public, max-age=3600");
    res.setHeader("content-type", "application/json");
    res.json(doc);
  };
}

// Production keys — what customer Epic prod environments fetch.
router.get("/jwks.json", serveJwks("production"));
// Sandbox keys — what fhir.epic.com and customer non-prod environments
// fetch. Path matches what's registered as the Non-Production JWK Set
// URL in the Epic developer portal.
router.get("/jwks-sandbox.json", serveJwks("sandbox"));

export default router;
