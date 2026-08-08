#!/usr/bin/env node
// Pull environment variables FROM Scaleway Secret Manager.
// Optionally filters by keys, optionally merges into local .env.local.
//
// Secret Manager holds one canonical value per key (CONTRACT.md §2 "Secret
// Manager naming": a secret's name IS the env var name, one Scaleway Project
// per app). There is no per-environment target on the READ side - that
// concept lives on which CONTAINER a value is pushed to (see
// push-env-vars.mjs), not how it's read back.
//
// Usage:
//   node pull-env-vars.mjs [--keys=K1,K2] [--write-to-local] [--json]
//
// Exit codes:
//   0 = success
//   1 = invalid args, Scaleway credentials missing, or the pull failed

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { getSecret, listSecrets } from "./scaleway/secrets.mjs";
import { ScwError } from "./scaleway/_scw-auth.mjs";

// ─── Parse args ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let keysFilter = null;
let writeToLocal = false;
let asJson = false;

for (const arg of args) {
  if (arg.startsWith("--keys=")) {
    keysFilter = arg.slice("--keys=".length).split(",").map((s) => s.trim()).filter(Boolean);
  } else if (arg === "--write-to-local") {
    writeToLocal = true;
  } else if (arg === "--json") {
    asJson = true;
  } else if (arg === "--help" || arg === "-h") {
    console.log("Usage: pull-env-vars.mjs [--keys=K1,K2] [--write-to-local] [--json]");
    process.exit(0);
  } else {
    console.error(`Unknown arg: ${arg}`);
    process.exit(1);
  }
}

// ─── Resolve which secret names to pull ────────────────────────────────
let names;
try {
  if (keysFilter && keysFilter.length > 0) {
    names = keysFilter;
  } else {
    const secrets = await listSecrets();
    names = secrets.map((s) => s.name);
  }
} catch (err) {
  console.error(`Failed to list Scaleway Secret Manager secrets: ${err.message}`);
  process.exit(1);
}

// ─── Fetch values ───────────────────────────────────────────────────────
const envs = {};
const notFound = [];
for (const name of names) {
  try {
    envs[name] = await getSecret(name);
  } catch (err) {
    if (err instanceof ScwError && err.type === "not_found") {
      notFound.push(name);
      continue;
    }
    console.error(`Failed to read secret "${name}": ${err.message}`);
    process.exit(1);
  }
}

if (notFound.length > 0) {
  console.error(`Note: not found in Secret Manager: ${notFound.join(", ")}`);
}

// ─── Optional merge into .env.local ────────────────────────────────────
if (writeToLocal) {
  const localPath = ".env.local";
  const existing = existsSync(localPath) ? readFileSync(localPath, "utf8") : "";
  const lines = existing.split("\n");
  const presentKeys = new Set();
  for (const line of lines) {
    const idx = line.indexOf("=");
    if (idx > 0 && !line.trimStart().startsWith("#")) {
      presentKeys.add(line.slice(0, idx).trim());
    }
  }

  // Update lines that match a pulled key, leave others alone
  const updated = lines.map((line) => {
    const idx = line.indexOf("=");
    if (idx <= 0 || line.trimStart().startsWith("#")) return line;
    const key = line.slice(0, idx).trim();
    if (key in envs) {
      const val = envs[key];
      const needsQuote = /[\s"#'$`\\]/.test(val);
      const safe = needsQuote ? `"${val.replace(/"/g, '\\"')}"` : val;
      return `${key}=${safe}`;
    }
    return line;
  });

  // Append keys that weren't in the existing file
  const toAppend = Object.entries(envs).filter(([k]) => !presentKeys.has(k));
  if (toAppend.length > 0) {
    if (updated.length > 0 && updated[updated.length - 1].trim() !== "") {
      updated.push("");
    }
    updated.push(`# Pulled from Scaleway Secret Manager on ${new Date().toISOString().slice(0, 10)}`);
    for (const [k, v] of toAppend) {
      const needsQuote = /[\s"#'$`\\]/.test(v);
      const safe = needsQuote ? `"${v.replace(/"/g, '\\"')}"` : v;
      updated.push(`${k}=${safe}`);
    }
  }

  writeFileSync(localPath, updated.join("\n"), "utf8");

  // Make sure .env.local is gitignored
  const gitignorePath = ".gitignore";
  if (existsSync(gitignorePath)) {
    const gi = readFileSync(gitignorePath, "utf8");
    if (!gi.split("\n").some((l) => l.trim() === ".env.local" || l.trim() === ".env.*.local")) {
      writeFileSync(gitignorePath, gi.trimEnd() + "\n.env.local\n", "utf8");
    }
  }
}

// ─── Output ────────────────────────────────────────────────────────────
if (asJson) {
  process.stdout.write(JSON.stringify(envs));
} else {
  const count = Object.keys(envs).length;
  if (count === 0) {
    console.log(`No variable ${keysFilter ? "matching the filter " : ""}found in Secret Manager.`);
  } else {
    console.log(`${count} variable${count > 1 ? "s" : ""} pulled from Secret Manager:`);
    for (const key of Object.keys(envs).sort()) {
      console.log(`  - ${key} (present)`);
    }
    if (writeToLocal) {
      console.log("\nMerged into .env.local.");
    }
  }
}

process.exit(0);
