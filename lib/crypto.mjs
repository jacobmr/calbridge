import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 2;

function loadKey(keyId) {
  const envName = keyId === 0 ? 'CALBRIDGE_DEK' : `CALBRIDGE_DEK_${keyId}`;
  const b64 = process.env[envName];
  if (!b64) throw new Error(`${envName} not set`);
  const buf = Buffer.from(b64, 'base64');
  if (buf.length !== 32) throw new Error(`${envName} must decode to 32 bytes`);
  return buf;
}

export function encrypt(plaintext, { keyId = 0 } = {}) {
  const key = loadKey(keyId);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const enc = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([VERSION, keyId]), nonce, enc, tag]);
}

export function decrypt(blob) {
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length < HEADER_LEN + NONCE_LEN + TAG_LEN) throw new Error('ciphertext too short');
  const version = buf[0];
  if (version !== VERSION) throw new Error(`unsupported version: ${version}`);
  const keyId = buf[1];
  const nonce = buf.subarray(HEADER_LEN, HEADER_LEN + NONCE_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ciphertext = buf.subarray(HEADER_LEN + NONCE_LEN, buf.length - TAG_LEN);
  const key = loadKey(keyId);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString('utf8');
}
