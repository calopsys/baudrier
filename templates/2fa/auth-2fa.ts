import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { TOTP, Secret } from "otpauth";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "~/server/db";
import { trustedDevices, loginProofs } from "~/server/db/schema";

/**
 * Briques 2FA :
 * - vérification du code TOTP (appli d’authentification)
 * - cookie "appareil de confiance" (2FA demandé 1×/24h par navigateur),
 *   signé ET vérifié en base (table trusted_device) - un cookie rejoué après
 *   révocation ou expiration en base est refusé même si sa signature reste
 *   valide.
 * - preuve de connexion à usage unique (nonce en base, table login_proof) :
 *   le serveur d’auth fait confiance à la server action qui a déjà vérifié
 *   mot de passe + 2FA (voir loginAction), mais la preuve ne peut être
 *   consommée qu’une seule fois.
 */

const TRUST_COOKIE = "__Host-{{COOKIE_NAME}}";
const TRUST_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const PROOF_TTL_MS = 90_000; // 90s

function secretKey(): string {
  const s = process.env.AUTH_SECRET;
  if (!s) throw new Error("AUTH_SECRET manquant");
  return s;
}

function sign(data: string): string {
  return createHmac("sha256", secretKey()).update(data).digest("hex");
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/* ── TOTP ────────────────────────────────────────────────────────────── */

export function verifyTotp(token: string): boolean {
  const secret = process.env.ADMIN_TOTP_SECRET;
  if (!secret) return false;
  const clean = token.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return false;
  const totp = new TOTP({
    issuer: "{{ISSUER}}",
    label: "admin",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
  // window:1 tolère un décalage d’horloge d’un cran (±30s).
  return totp.validate({ token: clean, window: 1 }) !== null;
}

/* ── Appareil de confiance (cookie 24h + table trusted_device) ──────────── */

export async function setTrustedDevice(username: string): Promise<void> {
  const deviceId = crypto.randomUUID();
  const exp = Date.now() + TRUST_TTL_MS;
  await db.insert(trustedDevices).values({
    id: deviceId,
    username,
    expiresAt: new Date(exp),
  });

  const value = `${deviceId}.${exp}.${sign(`${username}|${deviceId}|${exp}`)}`;
  (await cookies()).set(TRUST_COOKIE, value, {
    httpOnly: true,
    // __Host- requires Secure - unconditional, not NODE_ENV-gated. Serverless
    // Containers always serve HTTPS in production; browsers treat localhost
    // as a secure context too, so `next dev` still works.
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: TRUST_TTL_MS / 1000,
  });
}

export async function isTrustedDevice(username: string): Promise<boolean> {
  const raw = (await cookies()).get(TRUST_COOKIE)?.value;
  if (!raw) return false;
  const [deviceId, exp, mac] = raw.split(".");
  if (!deviceId || !exp || !mac) return false;
  if (!safeEqualHex(mac, sign(`${username}|${deviceId}|${exp}`))) return false;
  if (Number(exp) <= Date.now()) return false;

  // The signature only proves the cookie hasn't been tampered with - it says
  // nothing about revocation. The device row is the actual source of truth:
  // sign-out marks it revoked, and that must take effect immediately even
  // though the cookie itself is still validly signed and unexpired.
  const device = await db.query.trustedDevices.findFirst({ where: eq(trustedDevices.id, deviceId) });
  if (!device || device.username !== username || device.revokedAt) return false;
  return device.expiresAt.getTime() > Date.now();
}

/** Revokes the current browser's trusted-device grant (DB row + cookie).
 * Called on sign-out - staying signed out should mean staying 2FA-challenged
 * next time, not just ending the current session. */
export async function revokeTrustedDevice(): Promise<void> {
  const jar = await cookies();
  const deviceId = jar.get(TRUST_COOKIE)?.value.split(".")[0];
  jar.delete(TRUST_COOKIE);
  if (!deviceId) return;
  await db.update(trustedDevices).set({ revokedAt: new Date() }).where(eq(trustedDevices.id, deviceId));
}

/* ── Preuve de connexion à usage unique (server action → NextAuth authorize) ── */

export async function createLoginProof(username: string): Promise<string> {
  const id = crypto.randomUUID();
  const exp = Date.now() + PROOF_TTL_MS;
  await db.insert(loginProofs).values({
    id,
    username,
    expiresAt: new Date(exp),
  });
  return `${id}.${exp}.${sign(`${username}|${id}|${exp}`)}`;
}

export async function verifyLoginProof(username: string, proof: string): Promise<boolean> {
  const [id, exp, mac] = proof.split(".");
  if (!id || !exp || !mac) return false;
  if (!safeEqualHex(mac, sign(`${username}|${id}|${exp}`))) return false;
  if (Number(exp) <= Date.now()) return false;

  // Atomic single-use: the UPDATE only matches a row that is still
  // unconsumed, unexpired, and for this username. A rowCount of 0 means it
  // was already burned (or never existed) - replaying the same proof string
  // a second time must fail even though its signature still checks out.
  const result = await db
    .update(loginProofs)
    .set({ consumedAt: new Date() })
    .where(
      and(
        eq(loginProofs.id, id),
        eq(loginProofs.username, username),
        isNull(loginProofs.consumedAt),
        gt(loginProofs.expiresAt, new Date()),
      ),
    );
  return (result.rowCount ?? 0) > 0;
}
