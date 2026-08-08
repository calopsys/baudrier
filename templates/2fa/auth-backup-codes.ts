import { verifyPassword } from "~/lib/password";
import { db } from "~/server/db";
import { consumedBackupCodes } from "~/server/db/schema";

/**
 * Codes de secours 2FA. Les hachages (scrypt salt:hash) restent dans la
 * variable d’environnement `ADMIN_2FA_BACKUP_HASHES` (tableau JSON) - régénérer
 * les codes ne demande donc toujours pas de base de données. L’usage unique,
 * en revanche, est tracé en base (table `consumed_backup_code`) : un code
 * déjà utilisé échoue même s’il reste présent dans la variable d’env, tant
 * qu’elle n’a pas été régénérée.
 */
export async function consumeBackupCode(code: string): Promise<boolean> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return false;

  let hashes: string[] = [];
  try {
    const parsed: unknown = JSON.parse(process.env.ADMIN_2FA_BACKUP_HASHES ?? "[]");
    if (Array.isArray(parsed)) hashes = parsed.filter((h): h is string => typeof h === "string");
  } catch {
    return false;
  }

  for (const hash of hashes) {
    if (!(await verifyPassword(normalized, hash))) continue;

    // Match found. Mark it consumed atomically: ON CONFLICT DO NOTHING means
    // a second use of the same code - including a concurrent replay racing
    // this very request - never gets past this point, even though
    // verifyPassword above already said the hash was correct.
    const result = await db.insert(consumedBackupCodes).values({ codeHash: hash }).onConflictDoNothing();
    return (result.rowCount ?? 0) > 0;
  }
  return false;
}
