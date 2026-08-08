import { z } from "zod";
import { createTRPCRouter, rateLimitedProcedure } from "~/server/api/trpc";
import { sendMail, escapeHtml } from "~/server/mail";

export const contactRouter = createTRPCRouter({
  send: rateLimitedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        email: z.string().email(),
        message: z.string().min(1).max(5000),
        website: z.string().max(200).optional(), // champ honeypot
      }),
    )
    .mutation(async ({ input }) => {
      // Honeypot : si le champ caché est rempli, c’est un bot - on rejette silencieusement
      if (input.website && input.website.length > 0) {
        return { success: true }; // Faux succès pour ne pas alerter le bot
      }

      const safeName = escapeHtml(input.name);
      const safeEmail = escapeHtml(input.email);
      const safeMessage = escapeHtml(input.message);

      await sendMail({
        to:
          process.env.CONTACT_RECIPIENT_EMAIL ??
          process.env.TEM_SENDER_EMAIL!,
        subject: `Formulaire de contact : ${input.name}`,
        html: `<p><strong>De :</strong> ${safeName} (${safeEmail})</p><p>${safeMessage}</p>`,
        text: `De : ${input.name} (${input.email})\n\n${input.message}`,
      });
      return { success: true };
    }),
});
