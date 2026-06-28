// Generate an ES384 keypair for Epic SMART confidential-client auth
// (private_key_jwt). Prints the PEM private key and the public JWK that
// the JWKS endpoint will serve. Does NOT write anywhere — copy/paste into
// your secret store.
//
// Run for production (default): pnpm --filter @workspace/scripts run generate-epic-keypair
// Run for sandbox:               pnpm --filter @workspace/scripts run generate-epic-keypair -- --sandbox
//
// The output has three parts:
//   1. EPIC_KEY_ID[_SANDBOX] — random kid; register in Epic + put in env
//   2. EPIC_PRIVATE_KEY[_SANDBOX] — PEM, set in the api-server's secret store
//   3. PUBLIC_JWK — what /.well-known/jwks{,-sandbox}.json will return
//
// Run this script TWICE — once with --sandbox for sandbox env vars,
// once without for production. Epic forces distinct keys; do not reuse.
//
// SECURITY: the private key is printed once. Do NOT save the output to
// disk, paste it in a chat log, or commit it. It goes straight into your
// secret manager (AWS Secrets Manager / GCP Secret Manager / 1Password).

import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";

interface PublicJwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  kid: string;
  use: "sig";
  alg: "ES384";
}

function main(): void {
  const sandbox = process.argv.includes("--sandbox");
  const envSuffix = sandbox ? "_SANDBOX" : "";
  const jwksPath = sandbox ? "jwks-sandbox.json" : "jwks.json";
  const envLabel = sandbox ? "Sandbox / Non-Production" : "Production";

  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-384" });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicJwkRaw = createPublicKey(privateKey).export({ format: "jwk" });

  const kid = randomUUID();
  const publicJwk: PublicJwk = {
    kty: String(publicJwkRaw.kty),
    crv: String(publicJwkRaw.crv),
    x: String(publicJwkRaw.x),
    y: String(publicJwkRaw.y),
    kid,
    use: "sig",
    alg: "ES384",
  };

  const out = process.stdout;
  out.write("# ----------------------------------------------------------\n");
  out.write("# Epic " + envLabel + " keypair (ES384)\n");
  out.write("# Generated " + new Date().toISOString() + "\n");
  out.write("# ----------------------------------------------------------\n\n");
  out.write("EPIC_KEY_ID" + envSuffix + "=" + kid + "\n");
  out.write("EPIC_ALGORITHM" + envSuffix + "=ES384\n");
  out.write(
    "EPIC_PRIVATE_KEY" +
      envSuffix +
      "=\"" +
      String(privatePem).replace(/\n/g, "\\n") +
      "\"\n\n",
  );
  out.write("# Public JWK — already served by /.well-known/" + jwksPath + "\n");
  out.write("# when the above private key is loaded. Shown here so you can\n");
  out.write("# verify the kid Epic sees matches.\n");
  out.write(JSON.stringify(publicJwk, null, 2) + "\n");
}

main();
