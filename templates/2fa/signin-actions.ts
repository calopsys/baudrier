"use server";

import { headers } from "next/headers";
import { signIn } from "~/server/auth";
import { resolveClientIp } from "~/proxy";
import { verifyPassword, getAdminPasswordHash } from "~/lib/password";
import {
  verifyTotp,
  isTrustedDevice,
  setTrustedDevice,
  createLoginProof,
} from "~/lib/auth-2fa";
import { consumeBackupCode } from "~/lib/auth-backup-codes";
import { checkRateLimit } from "~/lib/rate-limit";

export type LoginResult =
  | { status: "ok" }
  | { status: "bad_credentials" }
  | { status: "2fa_required" }
  | { status: "invalid_code" }
  | { status: "rate_limited"; minutes: number }
  | { status: "error" };

export async function loginAction(input: {
  username: string;
  password: string;
  code?: string;
}): Promise<LoginResult> {
  try {
    const username = input.username?.trim() ?? "";

    // Keyed on IP AND username: keying on IP alone means rotating through
    // X-Forwarded-For values (spoofable - see proxy.ts) resets the window
    // for one specific targeted account. Keying on username alone would let
    // one attacker IP grief every other account's window. Both together.
    const ip = resolveClientIp(await headers()) ?? "unknown";
    const { allowed, retryAfterMs } = await checkRateLimit(`login:${ip}:${username || "unknown"}`);
    if (!allowed) {
      return { status: "rate_limited", minutes: Math.ceil((retryAfterMs ?? 0) / 60000) };
    }

    const password = input.password;
    if (!username || !password) return { status: "bad_credentials" };

    const expectedUsername = process.env.ADMIN_USERNAME ?? "admin";
    if (username !== expectedUsername) return { status: "bad_credentials" };

    const passwordOk = await verifyPassword(password, getAdminPasswordHash());
    if (!passwordOk) return { status: "bad_credentials" };

    // 2e facteur - sauf si l’appareil est déjà de confiance (< 24h).
    const trusted = await isTrustedDevice(username);
    if (!trusted) {
      const code = input.code?.trim();
      if (!code) return { status: "2fa_required" };
      const codeOk = verifyTotp(code) || (await consumeBackupCode(code));
      if (!codeOk) return { status: "invalid_code" };
      await setTrustedDevice(username);
    }

    // Émet la preuve à usage unique puis ouvre la session NextAuth.
    const proof = await createLoginProof(username);
    await signIn("credentials", { username, proof, redirect: false });

    return { status: "ok" };
  } catch {
    return { status: "error" };
  }
}
