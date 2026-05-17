import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture what the upsert / update chain receives so we can assert the
// values that reach the DB are ciphertext, not plaintext.
type ValuesPayload = Record<string, unknown>;
let lastInsertValues: ValuesPayload | null = null;
let lastUpdateSet: ValuesPayload | null = null;

vi.mock("@workspace/db", () => {
  const insertChain = (_table: unknown) => ({
    values: (v: ValuesPayload) => {
      lastInsertValues = v;
      return {
        onConflictDoUpdate: ({ set }: { set: ValuesPayload }) => {
          lastUpdateSet = set;
          return Promise.resolve();
        },
      };
    },
  });
  const updateChain = () => ({
    set: (v: ValuesPayload) => {
      lastUpdateSet = v;
      return { where: () => Promise.resolve() };
    },
  });
  const selectChain = () => ({
    from: () => ({
      where: () => ({ limit: () => Promise.resolve([]) }),
    }),
  });
  const deleteChain = () => ({
    where: () => ({
      returning: () => Promise.resolve([]),
    }),
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    insert: insertChain,
    update: updateChain,
    select: selectChain,
    delete: deleteChain,
    transaction: async (fn: (tx: unknown) => Promise<void>) => fn(db),
  };
  return {
    getDb: () => db,
    ehrConnectionsTable: { userId: "userId", provider: "provider" } as unknown,
    ehrOauthStatesTable: {} as unknown,
    usersTable: {} as unknown,
  };
});

import { upsertConnection } from "./ehr-oauth";
import {
  _resetKeyCacheForTests,
  decryptToken,
  looksLikeCiphertext,
} from "./token-crypto";

const ENV_VAR = "EHR_TOKEN_ENC_KEY";

describe("upsertConnection at-rest encryption", () => {
  const original = process.env[ENV_VAR];

  beforeEach(() => {
    process.env[ENV_VAR] = randomBytes(32).toString("base64");
    _resetKeyCacheForTests();
    lastInsertValues = null;
    lastUpdateSet = null;
  });

  afterEach(() => {
    if (original === undefined) delete process.env[ENV_VAR];
    else process.env[ENV_VAR] = original;
    _resetKeyCacheForTests();
  });

  it("writes ciphertext (not plaintext) for accessToken + refreshToken on insert", async () => {
    const access = "plaintext-access-token-AAA";
    const refresh = "plaintext-refresh-token-BBB";

    await upsertConnection({
      userId: "u_1",
      provider: "athenahealth",
      accessToken: access,
      refreshToken: refresh,
      expiresAt: new Date(Date.now() + 60_000),
      practitionerId: null,
      scope: null,
    });

    expect(lastInsertValues).not.toBeNull();
    const insertedAccess = lastInsertValues!["accessToken"] as string;
    const insertedRefresh = lastInsertValues!["refreshToken"] as string;

    // Encryption boundary holds: the values handed to the DB driver are
    // v1-format ciphertext, not the original token strings.
    expect(looksLikeCiphertext(insertedAccess)).toBe(true);
    expect(looksLikeCiphertext(insertedRefresh)).toBe(true);
    expect(insertedAccess).not.toContain(access);
    expect(insertedRefresh).not.toContain(refresh);

    // ...and decrypting them produces the original plaintext.
    expect(decryptToken(insertedAccess)).toBe(access);
    expect(decryptToken(insertedRefresh)).toBe(refresh);

    // The onConflict path writes the same ciphertext for the update set.
    expect(lastUpdateSet).not.toBeNull();
    expect(decryptToken(lastUpdateSet!["accessToken"] as string)).toBe(access);
    expect(decryptToken(lastUpdateSet!["refreshToken"] as string)).toBe(
      refresh,
    );
  });

  it("persists a null refreshToken as null (does not encrypt null)", async () => {
    await upsertConnection({
      userId: "u_2",
      provider: "athenahealth",
      accessToken: "only-access",
      refreshToken: null,
      expiresAt: new Date(Date.now() + 60_000),
      practitionerId: null,
      scope: null,
    });

    expect(lastInsertValues!["refreshToken"]).toBeNull();
    expect(
      decryptToken(lastInsertValues!["accessToken"] as string),
    ).toBe("only-access");
  });

  it("fails loudly when the encryption key is missing instead of writing plaintext", async () => {
    delete process.env[ENV_VAR];
    _resetKeyCacheForTests();

    await expect(
      upsertConnection({
        userId: "u_3",
        provider: "athenahealth",
        accessToken: "would-be-plaintext",
        refreshToken: "would-be-plaintext-refresh",
        expiresAt: new Date(Date.now() + 60_000),
        practitionerId: null,
        scope: null,
      }),
    ).rejects.toThrow(/EHR_TOKEN_ENC_KEY is required/);

    // Nothing should have made it to the DB if encryption failed.
    expect(lastInsertValues).toBeNull();
  });
});
