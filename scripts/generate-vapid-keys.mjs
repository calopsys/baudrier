#!/usr/bin/env node
// generate-vapid-keys.mjs
// Generates a VAPID key pair for Web Push and prints it as JSON on stdout :
//   { "publicKey": "...", "privateKey": "..." }
//
// IMPORTANT : run with the cwd AT THE PROJECT ROOT (cd <WEB_DIR> && node ...).
// This script lives in the plugin, but `web-push` is installed in the project : we
// resolve it from the cwd via createRequire (a bare ESM import would resolve
// relative to the plugin folder and fail).
//
// The keys are then stored via scripts/scaleway/secrets.mjs (putSecret) and
// written to .env locally :
//   VAPID_PUBLIC_KEY=<publicKey>
//   VAPID_PRIVATE_KEY=<privateKey>
// These are project-SPECIFIC secrets (like AUTH_SECRET) : Scaleway Secret
// Manager for the app's own Project, never a shared baudrier vault.

import { createRequire } from "node:module";
import path from "node:path";

const requireFromProject = createRequire(path.join(process.cwd(), "package.json"));

let webpush;
try {
  webpush = requireFromProject("web-push");
} catch {
  console.error(
    JSON.stringify({
      error:
        "web-push not found in the current project. Run from the project root, after : pnpm add web-push",
    }),
  );
  process.exit(1);
}

const keys = webpush.generateVAPIDKeys();
process.stdout.write(JSON.stringify({ publicKey: keys.publicKey, privateKey: keys.privateKey }));
