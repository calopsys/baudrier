#!/usr/bin/env node
/**
 * _deps.mjs - resolve the harness's npm dependencies from the plugin data directory.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * The plugin's own directory (${CLAUDE_PLUGIN_ROOT}) is a read-only cache, so
 * dependencies are installed into ${CLAUDE_PLUGIN_DATA} instead (see
 * tools/bootstrap-deps.mjs). Claude Code's documentation suggests pointing
 * NODE_PATH at that directory - but **NODE_PATH has no effect on ESM `import`
 * resolution**. It is honoured only by CommonJS `require`. Every script here is
 * ESM, so a bare `import "@scaleway/sdk"` would fail no matter what NODE_PATH says.
 *
 * There is no documented, blessed alternative (confirmed: it is a gap in the
 * plugin docs). So we resolve explicitly:
 *
 *   1. `createRequire` rooted inside the data directory gives us CJS resolution
 *      semantics, which DO search that directory's node_modules.
 *   2. `require.resolve(spec)` yields an absolute path to the real entry file.
 *   3. `import(pathToFileURL(abs))` loads it as ESM.
 *
 * WHICH directory that is comes from tools/deps-dir.mjs, shared with the installer.
 * It has to be shared: these scripts run under the Bash tool, which - unlike a
 * hook - never sees ${CLAUDE_PLUGIN_DATA}, so this side cannot work the answer out
 * on its own and used to guess a directory that does not exist.
 *
 * Results are memoised, so the resolution cost is paid once per process.
 *
 * Every consumer should import through here rather than reaching for a bare
 * specifier, so there is exactly one place that knows where dependencies live.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { attemptedDirs, PLUGIN_ROOT, resolveDepsDir } from "../../tools/deps-dir.mjs";

/** Absolute, because the user's shell is rarely sitting in the plugin directory. */
const BOOTSTRAP = path.join(PLUGIN_ROOT, "tools", "bootstrap-deps.mjs");
const HEALTH = path.join(PLUGIN_ROOT, "tools", "check-deps-health.mjs");

let cachedRequire = null;
let cachedRoot = null;
let cachedSource = null;

/**
 * Build a `require` whose resolution starts in the directory tools/deps-dir.mjs
 * resolved.
 */
function depsRequire() {
  if (cachedRequire) return cachedRequire;

  const resolved = resolveDepsDir();
  if (!resolved) {
    const tried = attemptedDirs()
      .map((c) => `  - ${c.dir}   [${c.source}]`)
      .join("\n");
    const override = process.env.BAUDRIER_DEPS_DIR
      ? "\nLa variable BAUDRIER_DEPS_DIR impose ce dossier et désactive toute recherche automatique.\n" +
        "Videz-la si vous voulez laisser le harness chercher lui-même.\n"
      : "";
    throw new Error(
      "Les dépendances du harness ne sont pas installées.\n\n" +
        "Aucun dossier node_modules trouvé parmi :\n" +
        tried +
        "\n" +
        override +
        `\nLancez : node "${BOOTSTRAP}"\n` +
        "(normalement fait automatiquement à l'ouverture d'une session Claude Code).",
    );
  }

  cachedRoot = resolved.dir;
  cachedSource = resolved.source;
  // The base must be a file path inside the root for createRequire to search
  // that root's node_modules. The file need not exist.
  cachedRequire = createRequire(path.join(cachedRoot, "__baudrier_deps__.js"));
  return cachedRequire;
}

/** The directory dependencies were resolved from. Useful for diagnostics. */
export function depsRoot() {
  depsRequire();
  return cachedRoot;
}

const moduleCache = new Map();

/**
 * Import a dependency by package specifier, resolved from the data directory.
 * @param {string} spec e.g. "@scaleway/sdk"
 * @returns {Promise<any>} the module namespace
 */
export async function loadDep(spec) {
  if (moduleCache.has(spec)) return moduleCache.get(spec);
  const req = depsRequire();
  let abs;
  try {
    abs = req.resolve(spec);
  } catch (e) {
    throw new Error(
      `La dépendance "${spec}" est introuvable dans ${cachedRoot} (source : ${cachedSource}).\n` +
        `Lancez : node "${BOOTSTRAP}"\n` +
        `Détail : ${e.message}`,
    );
  }
  let mod;
  try {
    mod = await import(pathToFileURL(abs).href);
  } catch (e) {
    // The single most likely cause is an upstream package published without its
    // compiled output - point straight at the tool that diagnoses it.
    throw new Error(
      `La dépendance "${spec}" est installée dans ${cachedRoot} mais ne peut pas être chargée.\n` +
        `C'est généralement le signe d'une version publiée sans son dossier dist/.\n` +
        `Diagnostic : node "${HEALTH}" --dir "${cachedRoot}"\n` +
        `Réparation : node "${BOOTSTRAP}"\n` +
        `Détail : ${e.message.split("\n")[0]}`,
    );
  }
  moduleCache.set(spec, mod);
  return mod;
}

/** The Scaleway SDK namespace (Container, Jobs, Secret, Iam, ...). */
export const loadScalewaySdk = () => loadDep("@scaleway/sdk");

/** The Scaleway SDK client factory and typed error classes. */
export const loadScalewayClient = () => loadDep("@scaleway/sdk-client");

/** The AWS S3 client - Scaleway Object Storage is S3-protocol only. */
export const loadS3 = () => loadDep("@aws-sdk/client-s3");

/** The AWS S3 presigner, for upload/download URLs. */
export const loadS3Presigner = () => loadDep("@aws-sdk/s3-request-presigner");

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const root = depsRoot();
    console.log(`▸ dépendances résolues depuis : ${root} (source : ${cachedSource})`);
    for (const spec of ["@scaleway/sdk", "@scaleway/sdk-client", "@aws-sdk/client-s3"]) {
      try {
        const m = await loadDep(spec);
        console.log(`✅ ${spec} (${Object.keys(m).length} exports)`);
      } catch (e) {
        console.log(`⚠️  ${spec} : ${e.message.split("\n")[0]}`);
      }
    }
    console.log(JSON.stringify({ ok: true, depsRoot: root, source: cachedSource }));
  } catch (e) {
    console.error(`❌ ${e.message}`);
    console.log(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
}
