#!/usr/bin/env node
// _stack.mjs - detects which of the two supported stacks a project directory
// holds, from package.json dependencies only (CONTRACT.md: no repo metadata
// file). `astro` means a vitrine (templates/landing); `next` means the T3
// app (templates/deploy). Checked here, not inferred from the user's
// description, so bootstrap/deploy/scale never guess.
//
// USAGE (module):
//   import { detectStack } from "./_stack.mjs";
//
// USAGE (CLI):
//   node _stack.mjs <dir>     # prints {"stack":"landing|application|unknown"}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function readPackageJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function stackFromPackageJson(pkg) {
  if (!pkg) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if ("astro" in deps) return "landing";
  if ("next" in deps) return "application";
  return null;
}

/**
 * @param {string} dir project root (or monorepo root)
 * @returns {"landing"|"application"|"unknown"}
 */
export function detectStack(dir) {
  const root = stackFromPackageJson(readPackageJson(join(dir, "package.json")));
  if (root) return root;

  const web = stackFromPackageJson(readPackageJson(join(dir, "apps", "web", "package.json")));
  if (web) return web;

  return "unknown";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = process.argv[2] || process.cwd();
  process.stdout.write(JSON.stringify({ stack: detectStack(dir) }) + "\n");
}
