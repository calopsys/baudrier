#!/usr/bin/env node
/**
 * check-deps-health.mjs - verify the installed npm dependencies are actually usable.
 *
 * This exists because of a specific, real failure mode: Scaleway's npm release
 * pipeline has been publishing @scaleway/* packages with no dist/ directory
 * while still declaring `exports` that point into it. Installing such a version
 * "succeeds", then every import fails at runtime with ERR_MODULE_NOT_FOUND
 * naming a file inside node_modules - which is baffling for a non-technical user
 * and looks like a bug in this harness rather than in a dependency.
 *
 * Run this after any install or dependency bump. It fails loudly and explains
 * what to do, instead of letting the confusing import error surface later.
 *
 * Usage:
 *   node tools/check-deps-health.mjs [--dir <node_modules parent>] [--json]
 *
 * --dir is optional: without it the directory is resolved by tools/deps-dir.mjs,
 * the same resolver the runtime uses, so running this by hand checks the install
 * that would actually be loaded rather than whatever cwd happens to be.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveDepsDir } from "./deps-dir.mjs";

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
const dirFlag = argv.indexOf("--dir");

/**
 * An explicit --dir always wins (bootstrap-deps.mjs passes the directory it just
 * installed into, which may not be the one currently resolvable). Otherwise take
 * the resolved install; failing that, the directory a resolution *would* target,
 * so the report says "node_modules is missing" about a meaningful path instead of
 * about the current working directory.
 */
const { dir: RESOLVED_DIR, source: RESOLVED_SOURCE } = (() => {
  if (dirFlag >= 0 && argv[dirFlag + 1]) return { dir: path.resolve(argv[dirFlag + 1]), source: "flag" };
  const withModules = resolveDepsDir();
  if (withModules) return withModules;
  const anyDir = resolveDepsDir({ requireNodeModules: false });
  if (anyDir) return anyDir;
  return { dir: process.cwd(), source: "cwd" };
})();

const BASE = RESOLVED_DIR;
const NM = path.join(BASE, "node_modules");

/** Packages we import at runtime, with the entry point that must resolve. */
const REQUIRED = [
  { name: "@scaleway/sdk", probe: "Container" },
  { name: "@scaleway/sdk-client", probe: "createClient" },
  { name: "@aws-sdk/client-s3", probe: "S3Client" },
];

const problems = [];
const checked = [];

// Resolution rooted in BASE, matching scripts/scaleway/_deps.mjs. The base file
// need not exist; only its directory matters for module resolution.
const req = createRequire(path.join(BASE, "__deps_health__.js"));

if (!fs.existsSync(NM)) {
  problems.push({
    package: "(none)",
    problem: "node_modules is missing entirely",
    fix: `run: cd "${BASE}" && npm install`,
  });
} else {
  for (const { name, probe } of REQUIRED) {
    const dir = path.join(NM, name);
    if (!fs.existsSync(dir)) {
      problems.push({ package: name, problem: "not installed", fix: `run: cd "${BASE}" && npm install` });
      continue;
    }

    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    } catch (e) {
      problems.push({ package: name, problem: `unreadable package.json: ${e.message}`, fix: "reinstall" });
      continue;
    }

    // Resolve exactly the way scripts/scaleway/_deps.mjs does at runtime, so
    // this check reflects real behaviour rather than a second guess at it.
    // Node's resolver honours the package's `exports` map and errors when the
    // target file is absent - which is precisely how a dist-less publish shows up.
    //
    // Note we must NOT hand-pick the `exports.import` / `module` field: the AWS
    // SDK's ESM build uses extensionless relative imports that only resolve under
    // a bundler, so preferring it would report a false failure on a package that
    // loads perfectly well via its CJS entry.
    let entryPath = null;
    try {
      entryPath = req.resolve(name);
    } catch (e) {
      problems.push({
        package: `${name}@${pkg.version}`,
        problem: `cannot be resolved - its declared entry point is not present in the published package (the tarball shipped without its compiled output): ${e.message.split("\n")[0]}`,
        fix: "this published version is broken upstream. Pin a known-good version in package.json (currently @scaleway/sdk 3.11.1 and @scaleway/sdk-client 2.4.2), delete node_modules, and reinstall.",
      });
      checked.push({ package: name, version: pkg.version, resolved: null });
      continue;
    }

    checked.push({ package: name, version: pkg.version, resolved: path.relative(dir, entryPath) });

    // Resolving is not enough - a file can exist and still fail to load.
    try {
      const mod = await import(pathToFileURL(entryPath).href);
      const ns = mod?.default && !(probe in mod) ? mod.default : mod;
      if (probe && !(probe in ns)) {
        problems.push({
          package: `${name}@${pkg.version}`,
          problem: `loads, but does not export "${probe}" - the package shape is not what this harness expects`,
          fix: "check whether a major version changed the export shape (@scaleway/sdk 4.x renamed the per-product namespaces)",
        });
      }
    } catch (e) {
      problems.push({
        package: `${name}@${pkg.version}`,
        problem: `import failed: ${e.message.split("\n")[0]}`,
        fix: "delete node_modules and reinstall; if it persists the published version is broken",
      });
    }
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: problems.length === 0, base: BASE, source: RESOLVED_SOURCE, checked, problems }, null, 2));
} else if (problems.length === 0) {
  console.log(`✅ Dependencies are healthy (${BASE}, ${RESOLVED_SOURCE}).`);
  for (const c of checked) console.log(`   ${c.package}@${c.version} -> ${c.resolved}`);
} else {
  console.error("❌ Dependency problems found:\n");
  for (const p of problems) {
    console.error(`   ${p.package}`);
    console.error(`      problem: ${p.problem}`);
    console.error(`      fix:     ${p.fix}\n`);
  }
}

process.exit(problems.length === 0 ? 0 : 1);
