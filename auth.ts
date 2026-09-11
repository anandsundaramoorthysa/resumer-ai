/**
 * Authentication — REQ-7.1, REQ-7.2, and the REQ-2.1 unified OAuth grant.
 *
 * Design note (a deliberate change from specs/design.md §2, which said Clerk):
 * Auth.js with the GitHub provider gives us the user's GitHub access token directly in
 * the same sign-in that authenticates them — which is exactly what the portfolio sync
 * needs. Clerk would mean a second SaaS account plus extra work to get the provider
 * token back out. One flow, one credential, no third-party dependency.
 *
 * Scope note: GitHub's OAuth scopes have no read-only variant for private repositories.
 * `repo` — read *and* write to everything the user owns — was the only way to read one
 * portfolio repo, which is an absurd thing to ask for and an unpleasant thing to hold.
 *
 * A GitHub App solves it properly: the user installs it on the repositories they choose,
 * the permission is `contents: read`, and access is a token minted on demand rather than
 * a credential we store. So when one is configured, sign-in asks only for identity and
 * the consent screen stops mentioning repositories at all. Without one, `repo` is still
 * requested, because otherwise existing users lose sync the moment this ships.
 *
 * Session note: sessions are JWTs rather than database rows. That is forced rather than
 * chosen — Auth.js will not issue a database session for the Credentials provider, and
 * email/password sign-in is a requirement. Nothing else depends on the session table:
 * the GitHub access token is read from the `account` row by user id, not from the
 * session, so the sync is unaffected.
 *
 * What a stateless session DOES cost is revocation: there is no row to delete, so a
 * password reset could not end the sessions that existed before it, and a token issued
 * to an attacker kept working for its full lifetime after the victim did the one thing
 * they were told to do. `users.sessionsValidFrom` is the answer — a reset records the
 * instant, every token records when it was minted, and the `session` callback below
 * refuses the ones that predate it.
 */

import NextAuth from 'next-auth';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import { DrizzleAdapter } from '@auth/drizzle-adapter';
import type { Adapter } from 'next-auth/adapters';
import { eq } from 'drizzle-orm';
import { db, isDatabaseConfigured } from '@/lib/db';
import { accounts, sessions, users, verificationTokens } from '@/lib/db/schema';
import { verifyPassword } from '@/lib/auth/password';
import { normalizeEmail } from '@/lib/auth/email-policy';
import { linkedAccountPatch } from '@/lib/auth/account-linking';
import { sessionSurvivesReset } from '@/lib/auth/session-validity';
import { callerIp, clearAttempts, rateLimit } from '@/lib/auth/rate-limit';
import { encryptIfPossible } from '@/lib/auth/secret-box';
import { isGitHubAppConfigured } from '@/lib/github/app';

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
 *
 * Why the rate limit is HERE and not only in the server action:
 *
 * Auth.js publishes `/api/auth/callback/credentials`, and anyone can post an email and
 * password to it directly — no React, no server action, no `guardSignInAction`. A limiter
 * that only guards the form guards the path nobody attacking would use. This was not
 * theoretical: the endpoint was driven from a shell script during development and signed
 * in without the form being involved at all. So the check lives on the path Auth.js
 * itself calls, which every route into a password sign-in must pass through.
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

    // Before any database read or any scrypt work: an attacker who is over the limit
    // should not get to spend our CPU either.
    const verdict = await rateLimit('sign-in', email, await callerIp());
    if (!verdict.allowed) return null;

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

    // Signing in successfully clears the counter, so someone who mistyped four times and
    // then got it right is not still four attempts deep for the next quarter of an hour.
    // This has to happen here: `signIn()` throws a redirect on success, so the equivalent
    // line after it in the server action was unreachable.
    await clearAttempts('sign-in', email);

    return { id: user.id, email: user.email, name: user.name, image: user.image };
  },
});

/**
 * The adapter, with addresses normalised on the way in and out.
 *
 * Password signup stores `normalizeEmail(...)`; the adapter stored whatever the OAuth
 * provider returned. So `First.Last@Corp.com` from GitHub and `first.last@corp.com` from
 * a password signup were two rows for one person — which defeats the unique constraint
 * on `user.email`, breaks the credentials lookup for anyone who first arrived via OAuth,
 * and undoes the "one inbox, one profile" rule `lib/auth/email-policy.ts` exists to
 * enforce. Both sides now key on the same string.
 */
function normalizingAdapter(base: Adapter): Adapter {
  return {
    ...base,
    createUser: (user) =>
      base.createUser!({ ...user, email: user.email ? normalizeEmail(user.email) : user.email }),
    getUserByEmail: (email) => base.getUserByEmail!(normalizeEmail(email)),
    updateUser: (user) =>
      base.updateUser!({ ...user, email: user.email ? normalizeEmail(user.email) : user.email }),

    /**
     * Provider tokens are encrypted on the way into the database.
     *
     * This is the only write path for them — Auth.js calls `linkAccount` when a provider
     * is first connected and whenever the grant is renewed — so encrypting here covers
     * every token that ever reaches the table. Reads go through
     * `lib/server/github-token.ts`, which is the matching half.
     *
     * The GitHub token carries `repo` scope, since GitHub has no read-only variant that
     * reaches private repositories. A leaked row is therefore read and write access to
     * everything the user owns, which is why this is worth the indirection.
     */
    linkAccount: (account) =>
      base.linkAccount!({
        ...account,
        access_token: encryptIfPossible(account.access_token) ?? undefined,
        refresh_token: encryptIfPossible(account.refresh_token) ?? undefined,
        id_token: encryptIfPossible(account.id_token) ?? undefined,
      }),
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  // Without a database the app still boots (JWT sessions only) so a fresh clone can be
  // opened and inspected before Postgres is provisioned.
  adapter: isDatabaseConfigured
    ? normalizingAdapter(
        DrizzleAdapter(db, {
          usersTable: users,
          accountsTable: accounts,
          sessionsTable: sessions,
          verificationTokensTable: verificationTokens,
        }),
      )
    : undefined,
  session: { strategy: 'jwt' },
  providers: [
    ...(githubConfigured
      ? [
          GitHub({
            clientId: process.env.AUTH_GITHUB_ID,
            clientSecret: process.env.AUTH_GITHUB_SECRET,
            authorization: {
              // REQ-2.1 — one sign-in, no second credential to set up. The `repo` half
              // is dropped as soon as a GitHub App can take over the reading.
              params: {
                // `read:org` is membership, read-only: it is what lets the install
                // callback confirm that an organisation the app was installed on is one
                // this person actually belongs to. Without it GitHub reports only public
                // memberships, and most people's are private.
                scope: isGitHubAppConfigured()
                  ? 'read:user user:email read:org'
                  : 'read:user user:email read:org repo',
              },
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
    async signIn({ user, account, profile }) {
      if (!isDatabaseConfigured) return true;
      if (account?.type !== 'oauth' || !user?.email) return true;

      // Account linking by email is only sound if the provider actually verified the
      // address. GitHub returns the user's verified primary address, so it always has.
      // Google normally does too, but a Workspace tenant on a self-owned domain can
      // present an unverified one — and with linking enabled, that would be a takeover
      // of any password account holding the same address. So the claim is checked.
      if (account.provider === 'google') {
        const verifiedClaim = (profile as { email_verified?: unknown } | undefined)?.email_verified;
        if (verifiedClaim !== true && verifiedClaim !== 'true') return false;
      }

      // Verifying the address must not also bless a password nobody proved they own —
      // see lib/auth/account-linking.ts for the takeover this prevents.
      const [before] = await db
        .select({ emailVerified: users.emailVerified })
        .from(users)
        .where(eq(users.id, user.id!))
        .limit(1);

      // Scoped to the row being signed in, not to every row matching the address.
      await db
        .update(users)
        .set(linkedAccountPatch(before?.emailVerified))
        .where(eq(users.id, user.id!));
      return true;
    },
    async jwt({ token, user }) {
      if (user?.id) {
        token.sub = user.id;
        // Stamped once, when the token is minted, and never touched again — that is the
        // whole point. Auth.js refreshes `iat` whenever it re-issues the cookie, so a
        // token that had been alive for a fortnight would keep looking newly issued and
        // would outlive every reset. `authAt` records when this SESSION began.
        //
        // Milliseconds rather than JWT's usual seconds: a reset writes
        // `sessionsValidFrom` at full precision, and a second's rounding would bounce
        // the user who signs in immediately after resetting.
        token.authAt = Date.now();
      }
      return token;
    },
    async session({ session, token }) {
      if (!token?.sub) return session;

      /**
       * The cost of stateless sessions, paid here.
       *
       * `resetPasswordAction` changes `passwordHash`, but a JWT already in someone's
       * cookie jar is not stored anywhere we can delete — it stays valid until it
       * expires on its own. So the one thing a reset CAN do is record when it happened,
       * and every session read compares against it.
       *
       * That is one primary-key lookup per authenticated request, which the JWT
       * strategy was chosen to avoid. It is worth it: without it "reset your password"
       * does not end the attacker's session, which is the single thing a user resetting
       * a password is trying to do.
       */
      if (isDatabaseConfigured) {
        const [row] = await db
          .select({ sessionsValidFrom: users.sessionsValidFrom })
          .from(users)
          .where(eq(users.id, token.sub))
          .limit(1);

        if (!sessionSurvivesReset(token.authAt, row?.sessionsValidFrom)) {
          // Auth.js gives this callback no way to say "the token is dead" — the
          // signature returns a session, not null. A session with no user and an expiry
          // already past is the same thing to everything downstream: every guard in this
          // app reads `session?.user?.id`, and there is none to read.
          return { expires: new Date(0).toISOString() };
        }
      }

      session.user.id = token.sub;
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
