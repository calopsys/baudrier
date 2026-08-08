#!/usr/bin/env node
// add-cleanup-workflow.mjs - Retrofit the branch-cleanup workflow into an
// existing project. New projects get the same file from bootstrap-init.mjs
// (step cleanupWorkflow); this script covers projects scaffolded before it
// existed. The workflow shape is pinned by check 60 in tools/verify.mjs and
// documented in CONTRACT.md §5.
//
// Usage:
//   node add-cleanup-workflow.mjs [--project-dir <path>] [--force]
//
// Idempotent: if the file already exists, the script reports it and exits 0
// without a write. Pass --force to overwrite with the current template.
// Output: ▸/✅ progress lines, then one JSON line for the caller to parse.

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { render } from "./_render.mjs";

const args = process.argv.slice(2);
let projectDir = process.cwd();
let force = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--project-dir" && args[i + 1]) {
    projectDir = args[++i];
  } else if (args[i] === "--force") {
    force = true;
  } else {
    console.error(`Unknown arg: ${args[i]}`);
    process.exit(1);
  }
}

const REL_DEST = ".github/workflows/clean-merged-branches.yml";
const dest = join(projectDir, REL_DEST);

console.log(`\n▸ Adding ${REL_DEST} (dispatch-only maintenance workflow)`);

if (existsSync(dest) && !force) {
  console.log(`  ✅ ${REL_DEST} already present (pass --force to overwrite)`);
  console.log(JSON.stringify({ success: true, created: false, file: REL_DEST }));
  process.exit(0);
}

mkdirSync(join(projectDir, ".github/workflows"), { recursive: true });
writeFileSync(dest, render("deploy/clean-merged-branches.yml", {}));
console.log(`  ✅ ${REL_DEST} written - the next commit + push ships it`);
console.log(JSON.stringify({ success: true, created: true, file: REL_DEST }));
