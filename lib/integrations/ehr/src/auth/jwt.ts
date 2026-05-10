import { sign as cryptoSign, type KeyObject } from "node:crypto";
import type { JwtSigner, JwtSigningAlgorithm } from "./types";

interface AlgParams {
  hash: string;
  dsaEncoding?: "ieee-p1363";
}

const ALG_PARAMS: Record<JwtSigningAlgorithm, AlgParams> = {
  RS256: { hash: "sha256" },
  RS384: { hash: "sha384" },
  RS512: { hash: "sha512" },
  // ECDSA needs `ieee-p1363` (a.k.a. JOSE) signature encoding — Node defaults
  // to DER, which IdPs will reject as malformed.
  ES256: { hash: "sha256", dsaEncoding: "ieee-p1363" },
  ES384: { hash: "sha384", dsaEncoding: "ieee-p1363" },
  ES512: { hash: "sha512", dsaEncoding: "ieee-p1363" },
};

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
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

  let signature: Buffer;
  if (opts.signer) {
    signature = await opts.signer(Buffer.from(signingInput), opts.algorithm);
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

  // Two distinct call sites so TS picks the right crypto.sign overload —
  // a conditional `key | { key, dsaEncoding }` union doesn't narrow cleanly
  // against the four overload signatures.
  if (params.dsaEncoding) {
    return cryptoSign(params.hash, data, {
      key: privateKey,
      dsaEncoding: params.dsaEncoding,
    });
  }
  return cryptoSign(params.hash, data, privateKey);
}
