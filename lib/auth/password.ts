/**
 * Password hashing and strength.
 *
 * scrypt rather than bcrypt or argon2, and it is a deliberate choice rather than a
 * shortcut: both alternatives are native modules, which on a serverless host means a
 * binary in the deployment bundle and a build that breaks whenever the runtime's ABI
 * moves. scrypt is memory-hard, is in Node's standard library, and is what the OWASP
 * password storage guidance names as an acceptable choice when argon2 is unavailable.
 *
 * Parameters are stored in the hash string, so raising the cost later does not
 * invalidate existing passwords — an old hash still verifies against its own parameters
 * and can be re-hashed on the next successful sign-in.
 */

import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** N=2^15 costs roughly 100ms and 32MB — comfortable inside a function's limits. */
const PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, KEY_LENGTH, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * Always constant-time, and never throws on a malformed stored value: a hash that
 * cannot be parsed is a failed verification, not a 500 that tells the caller their
 * address exists but something is wrong with it.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [scheme, n, r, p, saltB64, keyB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;

    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    if (salt.length === 0 || expected.length === 0) return false;

    const actual = await scryptAsync(password.normalize('NFKC'), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: PARAMS.maxmem,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export { checkPassword, MIN_PASSWORD_LENGTH, type PasswordCheck } from './password-rules';
