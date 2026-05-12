import {
  createPrivateKey,
  sign as cryptoSign,
  type KeyObject,
} from "node:crypto";
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
