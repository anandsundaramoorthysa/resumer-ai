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
 */

import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { db, isDatabaseConfigured } from '@/lib/db';
import { accounts, sessions, users, verificationTokens } from '@/lib/db/schema';

const githubConfigured =
  Boolean(process.env.AUTH_GITHUB_ID) && Boolean(process.env.AUTH_GITHUB_SECRET);

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
  session: { strategy: isDatabaseConfigured ? 'database' : 'jwt' },
  providers: githubConfigured
    ? [
        GitHub({
          clientId: process.env.AUTH_GITHUB_ID,
          clientSecret: process.env.AUTH_GITHUB_SECRET,
          authorization: {
            // REQ-2.1 — repo access granted by the same sign-in.
            params: { scope: 'read:user user:email repo' },
          },
        }),
      ]
    : [],
  pages: { signIn: '/sign-in' },
  callbacks: {
    async session({ session, user }) {
      if (user) session.user.id = user.id;
      return session;
    },
  },
  trustHost: true,
});

export const isAuthConfigured = githubConfigured;
