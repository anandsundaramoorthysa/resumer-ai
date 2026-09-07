/**
 * Password strength rules.
 *
 * Separate from lib/auth/password.ts because that module imports `node:crypto` for
 * hashing, and the sign-up form checks these rules while the user types — importing the
 * hashing module into a client component would pull a Node builtin into the browser
 * bundle. The rules themselves are pure, so both sides run exactly the same check.
 */

export const MIN_PASSWORD_LENGTH = 10;


/**
 * The most common passwords, which are the ones actually tried in a credential-stuffing
 * run. A length rule alone accepts "password123" and "qwertyuiop", both of which are in
 * the first hundred guesses of any list.
 */
const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789', '1234567890',
  'qwertyuiop', 'qwerty123', 'letmein123', 'iloveyou1', 'admin123', 'welcome123',
  'abc12345', 'football1', 'monkey123', 'dragon123', 'sunshine1', 'princess1', 'trustno1',
  'baseball1', 'superman1', 'starwars1', 'whatever1', 'changeme1', 'letmein1234',
]);

export interface PasswordCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Length first, then variety, then the common list.
 *
 * No maximum below 200 characters and no forced symbol: both push people toward
 * "Password1!" and away from a passphrase, which is longer and stronger. NIST dropped
 * composition rules for exactly this reason.
 */
export function checkPassword(password: string, email = ''): PasswordCheck {
  const problems: string[] = [];
  const p = password.normalize('NFKC');

  if (p.length < MIN_PASSWORD_LENGTH) {
    problems.push(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (p.length > 200) problems.push('That is longer than 200 characters.');
  if (/^\s|\s$/.test(password)) problems.push('It starts or ends with a space, which is easy to mistype.');

  const lower = p.toLowerCase();
  if (COMMON.has(lower)) problems.push('That is one of the most commonly used passwords.');
  if (/^(.)\1+$/.test(p)) problems.push('That is a single character repeated.');
  if (/^(0123456789|1234567890|abcdefghij)/.test(lower)) problems.push('That is a keyboard or counting sequence.');

  const localPart = email.split('@')[0]?.toLowerCase() ?? '';
  if (localPart.length >= 4 && lower.includes(localPart)) {
    problems.push('It contains your email address, which is the first thing anyone would try.');
  }

  return { ok: problems.length === 0, problems };
}
