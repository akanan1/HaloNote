import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

// AES-256-GCM at-rest encryption for EHR OAuth tokens. Format on disk:
//
//   v1.<iv_b64url>.<ciphertext_b64url>.<tag_b64url>
//
// The `v1.` prefix lets us rotate algorithms / keys later without
// guessing the layout. IV is 12 bytes (NIST SP 800-38D §5.2.1.1
// recommends 96 bits for GCM). Auth tag is the default 16 bytes.
//
// Key is loaded from the EHR_TOKEN_ENC_KEY env var only — never from a
// file, the DB, or a CLI flag. Must be base64 of exactly 32 bytes
// (256 bits). The key is read lazily on first use so importing this
// module from contexts that don't touch tokens (most unit tests) doesn't
// fail.

const VERSION = "v1";
const IV_BYTES = 12;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const ENV_VAR = "EHR_TOKEN_ENC_KEY";

export class TokenDecryptError extends Error {
  override readonly name = "TokenDecryptError";
  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env[ENV_VAR];
  if (!raw || raw.length === 0) {
    const msg =
      process.env["NODE_ENV"] === "production"
        ? `${ENV_VAR} is required in production — refusing to start without an EHR token encryption key.`
        : `${ENV_VAR} is required (base64 of ${KEY_BYTES} random bytes).`;
    throw new Error(msg);
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
  } catch {
    throw new Error(`${ENV_VAR} is not valid base64.`);
  }
  if (buf.length !== KEY_BYTES) {
    // Length check only — never include the value in the message.
    throw new Error(
      `${ENV_VAR} must decode to exactly ${KEY_BYTES} bytes (got ${buf.length}).`,
    );
  }
  cachedKey = buf;
  return cachedKey;
}

// Exposed only for tests that need to force a key reload after mutating
// process.env. Not exported from the package index.
export function _resetKeyCacheForTests(): void {
  cachedKey = null;
}

export function encryptToken(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString("base64url"),
    ct.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

export function decryptToken(ciphertext: string): string {
  const key = loadKey();
  const parts = ciphertext.split(".");
  // Constant-shape validation. Bail before touching the crypto API so a
  // mangled value gets a clean error instead of an opaque OpenSSL one.
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new TokenDecryptError("unsupported ciphertext format");
  }
  let iv: Buffer;
  let ct: Buffer;
  let tag: Buffer;
  try {
    iv = Buffer.from(parts[1]!, "base64url");
    ct = Buffer.from(parts[2]!, "base64url");
    tag = Buffer.from(parts[3]!, "base64url");
  } catch {
    throw new TokenDecryptError("ciphertext decode failed");
  }
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new TokenDecryptError("ciphertext field length mismatch");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    // Auth-tag failure or any other crypto error — swallow the original
    // message so we don't accidentally leak details about the ciphertext
    // structure.
    throw new TokenDecryptError("token decryption failed");
  }
}

// Helper for callers that want to detect "this string is already a v1
// ciphertext" before re-encrypting. Constant-time on the version prefix
// to avoid timing-based oracles on the format byte (paranoid, but free).
export function looksLikeCiphertext(value: string): boolean {
  if (value.length < VERSION.length + 1) return false;
  const head = Buffer.from(value.slice(0, VERSION.length));
  const expected = Buffer.from(VERSION);
  if (head.length !== expected.length) return false;
  return timingSafeEqual(head, expected) && value[VERSION.length] === ".";
}
