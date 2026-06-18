import {
  createPrivateKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import type { JwksClient } from "./jwks";
import type { JwtSigner, JwtSigningAlgorithm } from "./types";

interface AlgParams {
  hash: string;
  dsaEncoding?: "ieee-p1363";
  keyType: "rsa" | "rsa-pss" | "ec";
  // For ECDSA: expected size of `r || s` in bytes.
  coordSize?: number;
}

const ALG_PARAMS: Record<JwtSigningAlgorithm, AlgParams> = {
  RS256: { hash: "sha256", keyType: "rsa" },
  RS384: { hash: "sha384", keyType: "rsa" },
  RS512: { hash: "sha512", keyType: "rsa" },
  // ECDSA needs `ieee-p1363` (a.k.a. JOSE) signature encoding — Node defaults
  // to DER, which IdPs will reject as malformed.
  ES256: { hash: "sha256", dsaEncoding: "ieee-p1363", keyType: "ec", coordSize: 32 },
  ES384: { hash: "sha384", dsaEncoding: "ieee-p1363", keyType: "ec", coordSize: 48 },
  ES512: { hash: "sha512", dsaEncoding: "ieee-p1363", keyType: "ec", coordSize: 66 },
};

function base64url(input: Buffer | Uint8Array | string): string {
  const buf =
    typeof input === "string"
      ? Buffer.from(input, "utf8")
      : Buffer.isBuffer(input)
        ? input
        : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export interface SignJwtOptions {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  algorithm: JwtSigningAlgorithm;
  // Provide exactly one of `privateKey` or `signer`.
  privateKey?: string | KeyObject;
  signer?: JwtSigner;
}

export async function signJwt(opts: SignJwtOptions): Promise<string> {
  const headerJson = JSON.stringify({
    ...opts.header,
    alg: opts.algorithm,
    typ: "JWT",
  });
  const claimsJson = JSON.stringify(opts.claims);
  const signingInput = `${base64url(headerJson)}.${base64url(claimsJson)}`;

  const params = ALG_PARAMS[opts.algorithm];

  let signature: Buffer | Uint8Array;
  if (opts.signer) {
    signature = await opts.signer(Buffer.from(signingInput), opts.algorithm);
    // Sanity-check ECDSA shape: a common footgun is forgetting to convert
    // KMS-returned DER into JOSE / IEEE-P1363 (use `derToJose` for that).
    if (params.coordSize !== undefined) {
      const expected = params.coordSize * 2;
      if (signature.length !== expected) {
        throw new Error(
          `Invalid signature length for ${opts.algorithm}: expected ${expected} bytes ` +
            `(JOSE / IEEE-P1363 r || s), got ${signature.length}. ` +
            `If your KMS returns DER, convert it with derToJose() first.`,
        );
      }
    }
  } else if (opts.privateKey) {
    signature = signLocally(signingInput, opts.privateKey, opts.algorithm);
  } else {
    throw new Error("signJwt requires either `privateKey` or `signer`.");
  }

  return `${signingInput}.${base64url(signature)}`;
}

function signLocally(
  signingInput: string,
  privateKey: string | KeyObject,
  algorithm: JwtSigningAlgorithm,
): Buffer {
  const params = ALG_PARAMS[algorithm];
  const data = Buffer.from(signingInput);
  // Normalize to KeyObject up front. crypto.sign's overloads split on
  // input shape (SignPrivateKeyInput.key is string|Buffer, SignKeyObject-
  // Input.key is KeyObject) and don't unify on a `string | KeyObject` —
  // a single KeyObject keeps the downstream call sites unambiguous.
  const key =
    typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;

  // Reject mismatches like RSA key + ES256 alg up front rather than
  // letting the IdP return an opaque 400.
  const actualType = key.asymmetricKeyType;
  if (actualType) {
    const expected = params.keyType;
    const compatible =
      (expected === "ec" && actualType === "ec") ||
      ((expected === "rsa" || expected === "rsa-pss") &&
        (actualType === "rsa" || actualType === "rsa-pss"));
    if (!compatible) {
      throw new Error(
        `Algorithm ${algorithm} requires a ${expected} key, got ${actualType}.`,
      );
    }
  }

  if (params.dsaEncoding) {
    return cryptoSign(params.hash, data, {
      key,
      dsaEncoding: params.dsaEncoding,
    });
  }
  return cryptoSign(params.hash, data, key);
}

// ─── Verification ────────────────────────────────────────────────────

export class JwtVerificationError extends Error {
  override readonly name = "JwtVerificationError";
  readonly reason: string;
  constructor(reason: string) {
    super(`JWT verification failed: ${reason}`);
    Object.setPrototypeOf(this, new.target.prototype);
    this.reason = reason;
  }
}

function base64urlDecode(input: string): Buffer {
  // node:Buffer accepts "base64url" since Node 16; this stays explicit
  // about padding so a malformed segment surfaces as our error, not the
  // built-in's silent re-interpretation.
  if (!/^[A-Za-z0-9_-]+$/.test(input)) {
    throw new JwtVerificationError("malformed_base64url_segment");
  }
  return Buffer.from(input, "base64url");
}

export interface VerifyJwtOptions {
  token: string;
  jwks: JwksClient;
  /**
   * Allowed `alg` header values. The token's own `alg` is matched against
   * this list before any key lookup — this is the canonical defense
   * against the JWT-spec "alg=none" and HMAC-with-RSA-public-key
   * substitution attacks. Default: RS256 only (what Okta/Athena use).
   */
  allowedAlgorithms?: JwtSigningAlgorithm[];
  /** Required `aud` claim — for SMART id_tokens, this is the client_id. */
  expectedAudience?: string | string[];
  /** Optional `iss` claim check. */
  expectedIssuer?: string;
  /** Acceptable clock skew when checking `exp` / `nbf`, in seconds. */
  clockToleranceSec?: number;
  /** For deterministic tests. */
  now?: () => number;
}

export interface VerifiedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
}

const DEFAULT_ALLOWED_ALGS: JwtSigningAlgorithm[] = ["RS256"];
const DEFAULT_CLOCK_TOLERANCE_SEC = 60;

const VERIFY_PARAMS: Record<
  JwtSigningAlgorithm,
  { hash: string; dsaEncoding?: "ieee-p1363" }
> = {
  RS256: { hash: "sha256" },
  RS384: { hash: "sha384" },
  RS512: { hash: "sha512" },
  ES256: { hash: "sha256", dsaEncoding: "ieee-p1363" },
  ES384: { hash: "sha384", dsaEncoding: "ieee-p1363" },
  ES512: { hash: "sha512", dsaEncoding: "ieee-p1363" },
};

/**
 * Verifies a JWT signature against a JWKS, checks standard claims, and
 * returns the decoded header + claims. Refuses unsupported algorithms,
 * `none`, mismatched aud/iss, expired or not-yet-valid tokens, and
 * tokens whose `kid` doesn't appear in the JWKS.
 *
 * SECURITY: pass only an `allowedAlgorithms` list you actually expect.
 * The default (`["RS256"]`) is correct for Athena/Okta — do NOT widen
 * it without a reason. Allowing `HS*` here is what enables the classic
 * "send HS256 + public key as HMAC secret" attack.
 */
export async function verifyJwt(
  options: VerifyJwtOptions,
): Promise<VerifiedJwt> {
  const allowed = options.allowedAlgorithms ?? DEFAULT_ALLOWED_ALGS;
  const tolerance = options.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC;
  const now = options.now ? options.now() : Date.now();

  const parts = options.token.split(".");
  if (parts.length !== 3) {
    throw new JwtVerificationError("malformed_token");
  }
  const [headerB64, claimsB64, sigB64] = parts as [string, string, string];

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(base64urlDecode(headerB64).toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new JwtVerificationError("malformed_header");
  }

  const alg = header["alg"];
  if (typeof alg !== "string") {
    throw new JwtVerificationError("missing_alg");
  }
  if (!(allowed as string[]).includes(alg)) {
    throw new JwtVerificationError(`alg_not_allowed:${alg}`);
  }
  const algorithm = alg as JwtSigningAlgorithm;

  const kid = typeof header["kid"] === "string" ? (header["kid"] as string) : null;
  const key = await options.jwks.getKey(kid);

  // Sanity-check the key/alg pair. Without this, an RSA key would happily
  // try to verify an EC signature — `crypto.verify` would just return
  // false, but the error surface is clearer here.
  const keyType = key.asymmetricKeyType;
  const params = VERIFY_PARAMS[algorithm];
  const expectsEc = algorithm.startsWith("ES");
  if (expectsEc && keyType !== "ec") {
    throw new JwtVerificationError(`key_type_mismatch:${keyType}_for_${alg}`);
  }
  if (!expectsEc && keyType !== "rsa" && keyType !== "rsa-pss") {
    throw new JwtVerificationError(`key_type_mismatch:${keyType}_for_${alg}`);
  }

  const signingInput = Buffer.from(`${headerB64}.${claimsB64}`);
  const signature = base64urlDecode(sigB64);
  const sigOk = params.dsaEncoding
    ? cryptoVerify(
        params.hash,
        signingInput,
        { key, dsaEncoding: params.dsaEncoding },
        signature,
      )
    : cryptoVerify(params.hash, signingInput, key, signature);
  if (!sigOk) {
    throw new JwtVerificationError("bad_signature");
  }

  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(base64urlDecode(claimsB64).toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    throw new JwtVerificationError("malformed_claims");
  }

  // Standard claim checks. These run AFTER signature verification so a
  // forged token doesn't even get to leak which claim it failed on.
  const nowSec = Math.floor(now / 1000);
  const exp = numericClaim(claims["exp"]);
  if (exp !== null && nowSec - tolerance > exp) {
    throw new JwtVerificationError("expired");
  }
  const nbf = numericClaim(claims["nbf"]);
  if (nbf !== null && nowSec + tolerance < nbf) {
    throw new JwtVerificationError("not_yet_valid");
  }

  if (options.expectedAudience !== undefined) {
    const expected = Array.isArray(options.expectedAudience)
      ? options.expectedAudience
      : [options.expectedAudience];
    const aud = claims["aud"];
    const audList = Array.isArray(aud) ? aud : aud !== undefined ? [aud] : [];
    if (!expected.some((e) => audList.includes(e))) {
      throw new JwtVerificationError("audience_mismatch");
    }
  }

  if (
    options.expectedIssuer !== undefined &&
    claims["iss"] !== options.expectedIssuer
  ) {
    throw new JwtVerificationError("issuer_mismatch");
  }

  return { header, claims };
}

function numericClaim(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
