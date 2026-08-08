// db/safe.ts - Database resilience helper.
//
// Stored data is an optimisation, not a dependency: a page that only reads
// data it could otherwise default or recompute must keep answering even
// when the database is unreachable (a cold start, a Scaleway incident, a
// migration in flight). Wrap that kind of read in tryDb() instead of
// awaiting the query directly.
//
// Do NOT use this for a write, or for a read the app cannot honestly serve
// without (an auth lookup, a payment record) - those must fail loudly, not
// silently return a fallback the caller mistakes for real data.

/**
 * Runs `fn`. On any error, logs one line (never the error's cause chain,
 * which could expose a connection string) and returns `fallback` instead of
 * throwing - `fallback` is called if it is a function. A throwing fallback
 * function is logged the same way and yields `undefined`, so a broken
 * fallback still can't make the caller's read throw.
 */
export async function tryDb<T>(fn: () => Promise<T>, fallback: T | (() => T | Promise<T>)): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`db unavailable, using fallback: ${message}`);
    if (typeof fallback !== "function") return fallback;
    try {
      return await (fallback as () => T | Promise<T>)();
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      console.warn(`db fallback threw, returning undefined: ${fallbackMessage}`);
      return undefined as T;
    }
  }
}
