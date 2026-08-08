import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq, ne, and, isNull, gt, sql } from "drizzle-orm";
import { randomBytes } from "crypto";
import {
  createTRPCRouter,
  protectedProcedure,
  rateLimitedProcedure,
} from "~/server/api/trpc";
import { db } from "~/server/db";
import { users, passwordResetTokens } from "~/server/db/schema";
import { hashPassword, verifyPassword } from "~/lib/password";
import { sendMail, escapeHtml } from "~/server/mail";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h

export const authRouter = createTRPCRouter({
  signup: rateLimitedProcedure
    .input(
      z.object({
        email: z.string().email(),
        password: z.string().min(8).max(200),
        name: z.string().min(1).max(100).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const existing = await db.query.users.findFirst({
        where: eq(users.email, input.email),
      });
      if (existing) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Impossible de créer ce compte.",
        });
      }
      const passwordHash = await hashPassword(input.password);
      const [user] = await db
        .insert(users)
        .values({
          email: input.email,
          name: input.name ?? null,
          passwordHash,
        })
        .returning({ id: users.id, email: users.email });
      return { id: user!.id, email: user!.email };
    }),

  deleteAccount: protectedProcedure.mutation(async ({ ctx }) => {
    await db.delete(users).where(eq(users.id, ctx.session.user.id));
    return { success: true };
  }),

  /**
   * Send a password-reset email via Scaleway Transactional Email (TEM).
   * Always returns success regardless of whether the email exists, to avoid
   * account enumeration.
   */
  requestPasswordReset: rateLimitedProcedure
    .input(z.object({ email: z.string().email() }))
    .mutation(async ({ input }) => {
      const user = await db.query.users.findFirst({
        where: eq(users.email, input.email),
      });

      if (user) {
        // selector:verifier format - `selector` is a non-secret, indexed
        // lookup key; `verifier` is the actual secret and only its scrypt
        // hash is stored. This is what lets resetPassword below find the row
        // with one indexed lookup instead of scrypt-verifying every
        // outstanding token.
        const selector = randomBytes(12).toString("hex");
        const verifier = randomBytes(32).toString("base64url");
        const verifierHash = await hashPassword(verifier);
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

        await db.insert(passwordResetTokens).values({
          userId: user.id,
          selector,
          verifierHash,
          expiresAt,
        });

        const rawToken = `${selector}.${verifier}`;
        const resetUrl = `${process.env.APP_URL ?? "http://localhost:3000"}/reset-password?token=${rawToken}`;
        const safeUrl = escapeHtml(resetUrl);

        // TEM constraints (see CONTRACT.md): subject >= 10 chars, max 3
        // recipients, no templating engine on the API side.
        await sendMail({
          to: user.email,
          subject: "Réinitialisation de ton mot de passe",
          html: `<p>Pour choisir un nouveau mot de passe, clique sur ce lien :</p><p><a href="${safeUrl}">${safeUrl}</a></p><p>Le lien expire dans 1 heure et ne peut être utilisé qu’une fois. Si tu n’as pas demandé cette réinitialisation, ignore cet email.</p>`,
          text: `Pour choisir un nouveau mot de passe, ouvre ce lien : ${resetUrl}\n\nLe lien expire dans 1 heure et ne peut être utilisé qu’une fois. Si tu n’as pas demandé cette réinitialisation, ignore cet email.`,
        });
      } else {
        // No account for this email. Do equivalent CPU work (a throwaway hash)
        // so the response time does not reveal whether the account exists.
        await hashPassword(randomBytes(32).toString("base64url"));
      }

      return { success: true };
    }),

  /**
   * Consume a password-reset token and set a new password.
   * Token is `<selector>.<verifier>` - single-use (consumedAt set after
   * success, siblings deleted) and TTL-bounded.
   */
  resetPassword: rateLimitedProcedure
    .input(
      z.object({
        token: z.string().min(1).max(400),
        newPassword: z.string().min(8).max(200),
      }),
    )
    .mutation(async ({ input }) => {
      const [selector, verifier] = input.token.split(".");
      if (!selector || !verifier) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Lien invalide ou expiré." });
      }

      // Indexed lookup by selector - exactly ONE candidate row, not the
      // whole outstanding-token table like the old design (which meant one
      // scrypt verification per guess for every reset request left open).
      const candidate = await db.query.passwordResetTokens.findFirst({
        where: and(
          eq(passwordResetTokens.selector, selector),
          isNull(passwordResetTokens.consumedAt),
          gt(passwordResetTokens.expiresAt, new Date()),
        ),
      });

      if (!candidate) {
        // No such selector, already consumed, or expired. Do equivalent CPU
        // work so response time doesn't reveal which of those it was.
        await hashPassword(randomBytes(32).toString("base64url"));
        throw new TRPCError({ code: "BAD_REQUEST", message: "Lien invalide ou expiré." });
      }

      const verifierOk = await verifyPassword(verifier, candidate.verifierHash);
      if (!verifierOk) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Lien invalide ou expiré." });
      }

      const newHash = await hashPassword(input.newPassword);
      await db.transaction(async (tx) => {
        await tx
          .update(users)
          .set({
            passwordHash: newHash,
            // Bumping this invalidates every JWT issued before the reset -
            // see the jwt() callback in auth.ts. Sessions here are stateless
            // (no DB row to delete), so this counter is what "sign out
            // everywhere" actually means for this auth mode.
            sessionVersion: sql`${users.sessionVersion} + 1`,
          })
          .where(eq(users.id, candidate.userId));

        await tx
          .update(passwordResetTokens)
          .set({ consumedAt: new Date() })
          .where(eq(passwordResetTokens.id, candidate.id));

        // A successful reset retires every other in-flight reset link for
        // this account too, not just the one used.
        await tx
          .delete(passwordResetTokens)
          .where(and(eq(passwordResetTokens.userId, candidate.userId), ne(passwordResetTokens.id, candidate.id)));
      });

      return { success: true };
    }),
});
