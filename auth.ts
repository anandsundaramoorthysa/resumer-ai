/**
 * Authentication — REQ-7.1, REQ-7.2, and the REQ-2.1 unified OAuth grant.
 *
 * Design note (a deliberate change from specs/design.md §2, which said Clerk):
 * Auth.js with the GitHub provider gives us the user's GitHub access token directly in
 * the same sign-in that authenticates them — which is exactly what the portfolio sync
 * needs. Clerk would mean a second SaaS account plus extra work to get the provider
 * token back out. One flow, one credential, no third-party dependency.
 *
 * Scope note: GitHub's OAuth scopes have no read-only variant for private repos, so we
 * request `repo` and never issue a write call anywhere in this codebase (REQ-10.3).
 *
 * Session note: sessions are JWTs rather than database rows. That is forced rather than
 * chosen — Auth.js will not issue a database session for the Credentials provider, and
 * email/password sign-in is a requirement. Nothing else depends on the session table:
 * the GitHub access token is read from the `account` row by user id, not from the
 * session, so the sync is unaffected.
 */

import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { eq } from 'drizzle-orm';
import { db, isDatabaseConfigured } from '@/lib/db';
import { accounts, sessions, users, verificationTokens } from '@/lib/db/schema';
import { verifyPassword } from '@/lib/auth/password';
import { normalizeEmail } from '@/lib/auth/email-policy';

const githubConfigured =
  Boolean(process.env.AUTH_GITHUB_ID) && Boolean(process.env.AUTH_GITHUB_SECRET);
const googleConfigured =
  Boolean(process.env.AUTH_GOOGLE_ID) && Boolean(process.env.AUTH_GOOGLE_SECRET);

/**
 * Why every failure here returns the same null:
 *
 * "No account with that address", "wrong password" and "not verified yet" are three
 * different facts, and telling them apart lets a stranger test which addresses have
 * accounts here. The sign-in page says one thing for all three. The verification case is
 * the one real cost — a user who never clicked the link gets an unhelpful message — so
 * that page carries a standing "resend the confirmation email" link instead.
 */
const credentialsProvider = Credentials({
  credentials: {
    email: { label: 'Email', type: 'email' },
    password: { label: 'Password', type: 'password' },
  },
  async authorize(raw) {
    if (!isDatabaseConfigured) return null;

    const email = typeof raw?.email === 'string' ? normalizeEmail(raw.email) : '';
    const password = typeof raw?.password === 'string' ? raw.password : '';
    if (!email || !password) return null;

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    // An address with no password (a GitHub or Google account) is verified against a
    // dummy hash anyway, so the response takes the same time either way and does not
    // reveal that the address exists under another provider.
    const stored =
      user?.passwordHash ??
      'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    const correct = await verifyPassword(password, stored);
    if (!user || !user.passwordHash || !correct) return null;
    if (!user.emailVerified) return null;

    return { id: user.id, email: user.email, name: user.name, image: user.image };
  },
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Without a database the app still boots (JWT sessions only) so a fresh clone can be
  // opened and inspected before Postgres is provisioned.
  adapter: isDatabaseConfigured
    ? DrizzleAdapter(db, {
        usersTable: users,
        accountsTable: accounts,
        sessionsTable: sessions,
        verificationTokensTable: verificationTokens,
      })
    : undefined,
  session: { strategy: 'jwt' },
  providers: [
    ...(githubConfigured
      ? [
          GitHub({
            clientId: process.env.AUTH_GITHUB_ID,
            clientSecret: process.env.AUTH_GITHUB_SECRET,
            authorization: {
              // REQ-2.1 — repo access granted by the same sign-in.
              params: { scope: 'read:user user:email repo' },
            },
            // Linking by email is safe only because GitHub verifies the address it
            // returns. Enabling this for a provider that did not would let anyone who
            // could claim an address take over the account behind it.
            allowDangerousEmailAccountLinking: true,
          }),
        ]
      : []),
    ...(googleConfigured
      ? [
          Google({
            clientId: process.env.AUTH_GOOGLE_ID,
            clientSecret: process.env.AUTH_GOOGLE_SECRET,
            allowDangerousEmailAccountLinking: true,
          }),
        ]
      : []),
    ...(isDatabaseConfigured ? [credentialsProvider] : []),
  ],
  pages: { signIn: '/sign-in' },
  callbacks: {
    /**
     * An OAuth sign-in is proof the provider delivered mail to that address, so it also
     * settles verification for a password account created earlier with the same one.
     */
    async signIn({ user, account }) {
      if (!isDatabaseConfigured) return true;
      if (account?.type === 'oauth' && user?.email) {
        await db
          .update(users)
          .set({ emailVerified: new Date() })
          .where(eq(users.email, normalizeEmail(user.email)));
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user?.id) token.sub = user.id;
      return token;
    },
    async session({ session, token }) {
      if (token?.sub) session.user.id = token.sub;
      return session;
    },
  },
  trustHost: true,
});

/** True when at least one way in is configured. */
export const isAuthConfigured = githubConfigured || googleConfigured || isDatabaseConfigured;
export const providerAvailability = {
  github: githubConfigured,
  google: googleConfigured,
  password: isDatabaseConfigured,
};
