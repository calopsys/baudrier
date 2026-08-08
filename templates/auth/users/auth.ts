import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { DrizzleAdapter } from "@auth/drizzle-adapter";
import { eq } from "drizzle-orm";
import { db } from "~/server/db";
import { users, accounts, sessions, verificationTokens } from "~/server/db/schema";
import { verifyPassword } from "~/lib/password";

// Module augmentation: NextAuth's default Session.User has `id?: string`. We
// know `id` is always set (we set it in the jwt → session callbacks below),
// so we narrow the type to make `session.user.id` non-nullable in `protectedProcedure`.
declare module "next-auth" {
  interface Session extends DefaultSession {
    user: {
      id: string;
    } & DefaultSession["user"];
  }
  interface User {
    sessionVersion: number;
  }
}
// No `declare module "next-auth/jwt"` needed for `token.sessionVersion`:
// the JWT type already extends `Record<string, unknown>`, so arbitrary keys
// read/write without augmentation - same as the pre-existing `token.id` below.

// baudrier:auth-modes users
//
// Drizzle adapter is wired even though session strategy is "jwt" (NextAuth doesn't
// write to the sessions table in JWT mode). This is credentials-only auth (no
// OAuth provider is offered by this harness), but the adapter tables
// (accounts/sessions) are the standard @auth/drizzle-adapter shape, so keeping
// them wired costs nothing and avoids a schema migration if OAuth is ever added
// by hand later.
export const { auth, handlers, signIn, signOut } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        const user = await db.query.users.findFirst({ where: eq(users.email, email) });
        if (!user || !user.passwordHash) return null;

        const ok = await verifyPassword(password, user.passwordHash);
        if (!ok) return null;

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
          sessionVersion: user.sessionVersion,
        };
      },
    }),
  ],
  callbacks: {
    // Persist the user id + sessionVersion in the JWT at sign-in - needed
    // because we use jwt strategy without the sessions table; the default
    // callback drops custom fields like `id` otherwise.
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.sessionVersion = user.sessionVersion;
        return token;
      }

      // Re-checked on every subsequent request (jwt() runs on token decode,
      // not only at sign-in): a password reset bumps sessionVersion in DB,
      // and returning null here is what actually invalidates this JWT, since
      // sessions are stateless - there is no server-side row to delete.
      if (typeof token.id === "string") {
        const current = await db.query.users.findFirst({
          where: eq(users.id, token.id),
          columns: { sessionVersion: true },
        });
        if (!current || current.sessionVersion !== token.sessionVersion) {
          return null;
        }
      }
      return token;
    },
    session({ session, token }) {
      if (token.id && session.user) session.user.id = token.id as string;
      return session;
    },
  },
  pages: {
    signIn: "/signin",
  },
});
