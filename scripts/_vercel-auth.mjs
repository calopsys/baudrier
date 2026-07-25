#!/usr/bin/env node
// _vercel-auth.mjs - Shared Vercel auth + project resolution helpers.
//
// Extracted from push-env-vars.mjs so every script that talks to the Vercel REST
// API resolves the token and the project the same way (no duplicated OS logic).
//
//   import { loadAuthToken, readLinkedProject } from "./_vercel-auth.mjs";
//
// Not a CLI: this module only exports helpers.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";

// Vercel CLI auth file location varies by OS AND by CLI version. Older versions
// nested it under `Data/auth.json` (Cocoa app convention); newer versions
// (~v40+) put it directly in the app-support folder. We try both per platform
// and use whichever exists.
export function getAuthFilePathCandidates() {
  const os = platform();
  if (os === "win32") {
    const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
    return [
      join(appData, "com.vercel.cli", "Data", "auth.json"),
      join(appData, "com.vercel.cli", "auth.json"),
    ];
  }
  if (os === "darwin") {
    const base = join(homedir(), "Library", "Application Support", "com.vercel.cli");
    return [
      join(base, "Data", "auth.json"),
      join(base, "auth.json"),
    ];
  }
  // Linux / other POSIX
  const xdg = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return [
    join(xdg, "com.vercel.cli", "Data", "auth.json"),
    join(xdg, "com.vercel.cli", "auth.json"),
  ];
}

// Returns the Vercel API token, or null when the CLI is not logged in.
// `onWarn` receives a human-readable line when a candidate file exists but is unreadable.
export function loadAuthToken({ onWarn } = {}) {
  if (process.env.VERCEL_TOKEN) return process.env.VERCEL_TOKEN;
  for (const p of getAuthFilePathCandidates()) {
    try {
      if (!existsSync(p)) continue;
      const data = JSON.parse(readFileSync(p, "utf8"));
      if (data.token) {
        // Don't pre-check expiry - let the API return 401 if the token is truly dead.
        // Pre-checks are unreliable: clocks drift, Vercel uses grace periods, and
        // the refreshToken can silently extend the session.
        return data.token;
      }
    } catch (err) {
      if (onWarn) onWarn(`Could not read ${p} (${err.message}) - trying next candidate.`);
    }
  }
  return null;
}

// Reads .vercel/project.json from a project directory.
// Returns { projectId, orgId } or null when the project is not linked.
export function readLinkedProject(projectDir = process.cwd()) {
  const p = join(projectDir, ".vercel", "project.json");
  if (!existsSync(p)) return null;
  try {
    const project = JSON.parse(readFileSync(p, "utf8"));
    if (!project.projectId) return null;
    return { projectId: project.projectId, orgId: project.orgId || null };
  } catch {
    return null;
  }
}
