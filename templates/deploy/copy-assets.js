// copy-assets.js - patches `.next/standalone` after `next build`.
//
// Next.js's `output: 'standalone'` (see next.config.js) traces node_modules
// into a self-contained server but does NOT copy `.next/static/` (client JS
// chunks, CSS) or `public/` (favicons, robots.txt, images, PWA manifest,
// ...) into `.next/standalone/`. Ship the standalone folder as-is and the
// container starts fine and passes its health check - it "deploys
// successfully" - and then serves a completely unstyled page with 404s on
// every static asset for every real visitor. This script is what prevents
// that.
//
// Run AFTER `next build` and BEFORE the Docker runner stage copies
// `.next/standalone` into the final image. See templates/deploy/Dockerfile.
//
// This file uses ESM `import`: create-t3-app's package.json sets
// `"type": "module"`, so a bare `node copy-assets.js` inside the Docker
// build treats this file as an ES module and `require` throws
// (ReferenceError: require is not defined in ES module scope - verified on
// a live build). No dependencies, no build step - it only has whatever
// `pnpm install` put in node_modules.

import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const STANDALONE_DIR = join(ROOT, ".next", "standalone");

/**
 * @param {string} src
 * @param {string} dest
 * @param {{optional?: boolean}} [options]
 */
function copy(src, dest, { optional = false } = {}) {
  if (!existsSync(src)) {
    if (optional) {
      console.log(`copy-assets: ${src} does not exist, skipping (optional)`);
      return;
    }
    throw new Error(
      `copy-assets: expected ${src} to exist - did \`next build\` run first?`,
    );
  }
  cpSync(src, dest, { recursive: true });
  console.log(`copy-assets: copied ${src} -> ${dest}`);
}

if (!existsSync(STANDALONE_DIR)) {
  throw new Error(
    `copy-assets: ${STANDALONE_DIR} does not exist - is "output: 'standalone'" set in next.config.js?`,
  );
}

copy(join(ROOT, ".next", "static"), join(STANDALONE_DIR, ".next", "static"));

// public/ is optional - a from-scratch project may not have created one yet.
copy(join(ROOT, "public"), join(STANDALONE_DIR, "public"), { optional: true });
