import type { KeyObject } from "node:crypto";

export interface AccessToken {
  token: string;
  // ms epoch
  expiresAt: number;
  tokenType: string;
  scope?: string;
}

export interface TokenProvider {
  getToken(): Promise<string>;
  getAccessToken(): Promise<AccessToken>;
  invalidate(): void;
}

export interface OAuth2Config {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  fetchImpl?: typeof fetch;
}

export type JwtSigningAlgorithm =
  | "RS256"
  | "RS384"
  | "RS512"
  | "ES256"
  | "ES384"
  | "ES512";

/**
 * Override hook for delegating signature production to an external signer
 * (KMS, HSM, cloud key vault, etc). The private key never enters process
 * memory in this case.
 *
 * The callback receives the signing input bytes (`base64url(header) +
 * "." + base64url(claims)`) and must return the raw signature in JOSE /
 * IEEE-P1363 format — for ECDSA that means `r || s` concatenated, NOT
 * ASN.1 DER. Most KMS providers return DER for ECDSA, so a DER→JOSE
 * conversion step in the callback is usually required.
 */
export type JwtSigner = (
  signingInput: Buffer,
  algorithm: JwtSigningAlgorithm,
) => Promise<Buffer | Uint8Array> | Buffer | Uint8Array;

export interface JwtBearerAuthConfig {
  tokenUrl: string;
  clientId: string;
  algorithm: JwtSigningAlgorithm;
  /**
   * PEM-encoded private key (or pre-built KeyObject) used for local
   * signing. Mutually exclusive with `signer`; one of the two is required.
   */
  privateKey?: string | KeyObject;
  /**
   * External signer override. When provided, takes precedence over
   * `privateKey` and signing is delegated to the callback.
   */
  signer?: JwtSigner;
  // Required by most IdPs (incl. Epic) so they can pick the matching
  // public key out of the JWKS the client has registered.
  keyId?: string;
  // `aud` claim. Defaults to tokenUrl per SMART backend services spec.
  audience?: string;
  scope?: string;
  // Lifetime of the client_assertion JWT. SMART recommends ≤ 5 minutes.
  assertionLifetimeSeconds?: number;
  fetchImpl?: typeof fetch;
}
