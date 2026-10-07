/**
 * Stands in for `@/auth` in the `db-*` suites. The real module builds NextAuth with a
 * Drizzle adapter at import time, which wants a real driver and OAuth configuration. Here
 * `auth()` simply returns whatever session the test installed with `setSession`.
 */
const g = globalThis as unknown as { __testSession?: unknown };

export function setSession(session: unknown): void {
  g.__testSession = session;
}

export async function auth(): Promise<unknown> {
  return g.__testSession ?? null;
}

export const handlers = {
  GET: async () => new Response('stub', { status: 501 }),
  POST: async () => new Response('stub', { status: 501 }),
};
export async function signIn(): Promise<never> {
  throw new Error('tests/db/auth-stub: signIn is not available');
}
export async function signOut(): Promise<never> {
  throw new Error('tests/db/auth-stub: signOut is not available');
}
export const isAuthConfigured = true;
export const providerAvailability = { github: false, google: false, email: true };
