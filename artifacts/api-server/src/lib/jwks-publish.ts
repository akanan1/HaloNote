import { createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";

// Public-facing JWKS document shape (RFC 7517 §5). We only ever emit
// keys of the shapes Epic expects: ES384 (EC P-384) or RS384 (RSA).
export interface JwksDocument {
  keys: PublicJwk[];
}

export type PublicJwk =
  | (PublicEcJwk & SmartKeyMeta)
  | (PublicRsaJwk & SmartKeyMeta);

interface SmartKeyMeta {
  kid: string;
  use: "sig";
  alg: string;
}

interface PublicEcJwk {
  kty: "EC";
  crv: string;
  x: string;
  y: string;
}

interface PublicRsaJwk {
  kty: "RSA";
  n: string;
  e: string;
}

export interface JwkSource {
  /** PEM-encoded private key (PKCS8 or SEC1 for EC; PKCS1 or PKCS8 for RSA). */
  privateKeyPem: string;
  /** Matches the `kid` Epic stores against this app's registration. */
  kid: string;
  /** Signing algorithm — must match what the JWT signer uses at runtime. */
  algorithm: string;
}

/**
 * Derive the public JWK for a single signing key. The private key never
 * leaves this function — only the public coordinates / modulus are
 * extracted via `export({ format: "jwk" })`, then we re-shape the result
 * to the SMART-mandated fields (`kid`, `use: "sig"`, `alg`).
 */
export function publicJwkFromPem(source: JwkSource): PublicJwk {
  const privateKey: KeyObject = createPrivateKey(source.privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  const raw = publicKey.export({ format: "jwk" });

  if (raw.kty === "EC") {
    if (
      typeof raw.crv !== "string" ||
      typeof raw.x !== "string" ||
      typeof raw.y !== "string"
    ) {
      throw new Error("EC private key did not yield x/y/crv on JWK export");
    }
    return {
      kty: "EC",
      crv: raw.crv,
      x: raw.x,
      y: raw.y,
      kid: source.kid,
      use: "sig",
      alg: source.algorithm,
    };
  }
  if (raw.kty === "RSA") {
    if (typeof raw.n !== "string" || typeof raw.e !== "string") {
      throw new Error("RSA private key did not yield n/e on JWK export");
    }
    return {
      kty: "RSA",
      n: raw.n,
      e: raw.e,
      kid: source.kid,
      use: "sig",
      alg: source.algorithm,
    };
  }
  throw new Error(`Unsupported key type for JWKS publish: ${String(raw.kty)}`);
}

/**
 * Build a complete JWKS document from a set of key sources. Sources are
 * iterated in order; consumers (Epic, in our case) select by `kid`.
 * Throws if a key fails to parse — we'd rather fail-fast at startup than
 * serve an empty JWKS that locks the integration out silently.
 */
export function buildJwksDocument(sources: JwkSource[]): JwksDocument {
  return { keys: sources.map(publicJwkFromPem) };
}
