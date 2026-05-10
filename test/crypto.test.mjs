import { test, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encrypt, decrypt } from "../lib/crypto.mjs";

before(() => {
  process.env.CALBRIDGE_DEK = randomBytes(32).toString("base64");
});

test("encrypt/decrypt round-trips a string", () => {
  const blob = encrypt("hello world");
  assert.equal(decrypt(blob), "hello world");
});

test("encrypt/decrypt round-trips a multi-byte string", () => {
  const s = "café — naïve résumé 🔐";
  assert.equal(decrypt(encrypt(s)), s);
});

test("two encrypts of same plaintext have different nonces", () => {
  const a = encrypt("same");
  const b = encrypt("same");
  assert.notDeepEqual(Buffer.from(a), Buffer.from(b));
  assert.equal(decrypt(a), "same");
  assert.equal(decrypt(b), "same");
});

test("decrypt rejects tampered ciphertext", () => {
  const blob = encrypt("secret");
  const tampered = Buffer.from(blob);
  // flip a byte inside the ciphertext region (after 2-byte header + 12-byte nonce)
  tampered[14] ^= 0x01;
  assert.throws(() => decrypt(tampered));
});

test("decrypt rejects tampered authentication tag", () => {
  const blob = encrypt("secret");
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1] ^= 0x01;
  assert.throws(() => decrypt(tampered));
});

test("decrypt rejects unsupported version byte", () => {
  const blob = encrypt("secret");
  const tampered = Buffer.from(blob);
  tampered[0] = 0xff;
  assert.throws(() => decrypt(tampered), /version/);
});

test("decrypt rejects too-short blob", () => {
  assert.throws(() => decrypt(Buffer.alloc(8)), /too short/);
});

test("encrypt with unknown keyId throws", () => {
  assert.throws(() => encrypt("x", { keyId: 9 }), /CALBRIDGE_DEK_9/);
});

test("crypto rejects bad-length DEK", () => {
  const saved = process.env.CALBRIDGE_DEK;
  process.env.CALBRIDGE_DEK = Buffer.alloc(16).toString("base64");
  try {
    assert.throws(() => encrypt("x"), /32 bytes/);
  } finally {
    process.env.CALBRIDGE_DEK = saved;
  }
});

test("blob layout: header(2) + nonce(12) + ciphertext + tag(16)", () => {
  const blob = encrypt("hi");
  // 2 + 12 + 2 + 16 = 32 bytes for a 2-byte plaintext
  assert.equal(blob.length, 32);
  assert.equal(blob[0], 1, "version byte");
  assert.equal(blob[1], 0, "keyId byte");
});
