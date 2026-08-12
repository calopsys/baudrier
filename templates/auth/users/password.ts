import { scrypt, randomBytes, timingSafeEqual, type ScryptOptions } from "crypto";

// A manual Promise wrapper, not `promisify(scrypt)`: scrypt has a 3-arg and a
// 4-arg (with options) overload, and `promisify` only carries ONE of a
// function's overloads through to its return type - TypeScript picks the
// 3-arg one, so passing `options` as a 4th positional argument fails to
// type-check even though it's valid at runtime. Calling scrypt directly with
// all 4 arguments (as done here) resolves to the correct overload.
function scryptAsync(password: string, salt: string, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

// N=32768 is two times Node's default (16384): still stronger than
// default, but now bounded by the container, not by the crypto. The
// working set is `128 * N * r` bytes per in-flight hash - 32 MiB here.
// Preset S gives 512 MB and allows 8 concurrent requests, and any
// credentials request can force one hash - so maxConcurrency * workingSet
// must leave room for Next.js beside it. CONTRACT.md records the coupling;
// verify check 71 enforces the lockstep across the four mint sites and
// the budget.
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;

function paramsTag(): string {
  return `N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}`;
}

function parseParamsTag(tag: string): { N: number; r: number; p: number } | null {
  const m = /^N=(\d+),r=(\d+),p=(\d+)$/.exec(tag);
  if (!m) return null;
  return { N: Number(m[1]), r: Number(m[2]), p: Number(m[3]) };
}

/**
 * Hash a password with scrypt. Output format:
 * `scrypt:N=..,r=..,p=..:<saltHex>:<hashHex>` - the cost params travel with
 * the hash so a future change to SCRYPT_PARAMS can still verify hashes
 * minted under the old ones (see verifyPassword). scrypt is preferred over
 * bcrypt because bcrypt hashes contain `$` characters that break shell
 * piping and env-var CLI quoting.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const buf = await scryptAsync(password, salt, KEY_LEN, SCRYPT_PARAMS);
  return `scrypt:${paramsTag()}:${salt}:${buf.toString("hex")}`;
}

/**
 * Verify a plain password against a stored hash. Uses timingSafeEqual to
 * prevent timing attacks. Parses the cost params from the hash itself
 * (current format above); also accepts the older bare `<saltHex>:<hashHex>`
 * format (Node's scrypt defaults) so this stays a strict superset, not a
 * breaking change, if any such hash exists.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(":");

  let salt: string | undefined;
  let hash: string | undefined;
  let params: { N: number; r: number; p: number; maxmem?: number };

  if (parts.length === 4 && parts[0] === "scrypt") {
    const parsed = parseParamsTag(parts[1]!);
    if (!parsed) return false;
    salt = parts[2];
    hash = parts[3];
    // 256 MB, not the current file's 64 MB: a hash minted before this file's
    // last SCRYPT_PARAMS change may carry an older, larger N in its tag (up
    // to N=131072, which needs 128 MiB) - lowering this value would brick it.
    params = { ...parsed, maxmem: 256 * 1024 * 1024 };
  } else if (parts.length === 2) {
    [salt, hash] = parts;
    params = { N: 16384, r: 8, p: 1 };
  } else {
    return false;
  }

  if (!salt || !hash) return false;
  const buf = await scryptAsync(password, salt, KEY_LEN, params);
  const stored = Buffer.from(hash, "hex");
  if (stored.length !== buf.length) return false;
  return timingSafeEqual(buf, stored);
}
