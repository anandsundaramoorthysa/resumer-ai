/**
 * Encrypting the provider tokens stored in the `account` table.
 *
 * The GitHub token is the most dangerous value this application holds. It is granted
 * with `repo` scope, because GitHub offers no read-only variant that reaches private
 * repositories, so a single leaked row is read *and write* access to everything the user
 * has. Postgres is also the most likely thing to leak — a backup, a snapshot, a
 * connection string in the wrong place, a `drizzle-kit studio` left open. Encrypting at
 * the application layer means the database alone is not enough.
 *
 * AES-256-GCM, which authenticates as well as encrypts: a ciphertext altered in the
 * database fails to decrypt rather than silently producing different bytes. The IV is
 * random per value and stored alongside, which is what makes it safe to encrypt the same
 * token twice.
 *
 * The envelope carries a version so the scheme can change without a migration that has
 * to run everywhere at once: an old value still names the format it was written in.
 */

import 'server-only';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const TAG_BYTES = 16;

export class MissingKeyError extends Error {}

/**
 * The key, derived from `TOKEN_ENC_KEY`.
 *
 * SHA-256 of whatever is provided, so any passphrase length works and the caller does
 * not have to produce exactly 32 bytes. This is not a password — it comes from a
 * generated secret, not from something a human chose — so a KDF with a work factor
 * would add cost without adding resistance to anything.
 */
function key(): Buffer {
  const raw = process.env.TOKEN_ENC_KEY?.trim();
  if (!raw) throw new MissingKeyError('TOKEN_ENC_KEY is not set.');
  if (raw.length < 32) {
    throw new MissingKeyError('TOKEN_ENC_KEY is too short — use at least 32 characters.');
  }
  return createHash('sha256').update(raw).digest();
}

export function isEncryptionConfigured(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

/** `v1.<iv>.<tag>.<ciphertext>`, each part base64url. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * True for a value this module wrote.
 *
 * Needed because the column held plaintext before this existed, and a row written then
 * must keep working rather than being read as a corrupt ciphertext. The check is on
 * shape, and a GitHub token (`gho_…`, `ghp_…`) cannot accidentally match it.
 */
export function looksEncrypted(value: string): boolean {
  if (!value.startsWith(`${VERSION}.`)) return false;
  return value.split('.').length === 4;
}

/**
 * Decrypts, or returns the value unchanged if it was never encrypted.
 *
 * Returning plaintext untouched is what makes the migration gradual: every existing row
 * keeps working, and each is re-encrypted the next time it is written. Throwing here
 * instead would mean every user's sync breaking at the moment this shipped.
 */
export function decryptSecret(value: string): string {
  if (!looksEncrypted(value)) return value;

  const [, ivB64, tagB64, dataB64] = value.split('.');
  const iv = Buffer.from(ivB64, 'base64url');
  const tag = Buffer.from(tagB64, 'base64url');
  const data = Buffer.from(dataB64, 'base64url');

  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Stored secret is malformed.');
  }

  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  // Throws on a wrong key or altered ciphertext, which is the point of GCM: a value
  // that has been tampered with must not decrypt to anything at all.
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Encrypts when a key is configured, and passes through when one is not. */
export function encryptIfPossible(plaintext: string | null | undefined): string | null {
  // An empty token is not a token. Normalising it to null keeps one representation of
  // "nothing stored" in the column rather than two.
  if (!plaintext) return null;
  if (!isEncryptionConfigured()) {
    // Loud, because the failure mode is silent: everything works, and the tokens are
    // sitting in the database in the clear.
    console.warn(
      '[secret-box] TOKEN_ENC_KEY is not set — provider tokens are being stored in plaintext.',
    );
    return plaintext;
  }
  return encryptSecret(plaintext);
}

/** Decrypts when possible; a value that cannot be read is null rather than a throw. */
export function decryptIfPossible(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return decryptSecret(value);
  } catch (err) {
    // The message only — a stack trace through the crypto module says nothing the
    // message does not, and this can be hit once per request on a rotated key.
    console.error(
      '[secret-box] could not decrypt a stored token:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Constant-time equality, for callers comparing two secrets. */
export function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
