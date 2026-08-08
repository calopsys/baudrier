#!/usr/bin/env node
// gsc-token.mjs - Mint a Google OAuth2 access token for Search Console from the service
// account stored in Scaleway Secret Manager (secret GSC_SERVICE_ACCOUNT, in the current
// app's own Scaleway Project - CONTRACT.md §2 "Secret Manager naming").
//
// Cross-OS (pure Node). The SA JSON is read from Secret Manager (in-memory), the JWT is
// signed with node:crypto (no SDK - keep it that way), exchanged for an access token,
// printed to stdout. Nothing touches disk; the private key never leaves this process.
//
//   node gsc-token.mjs            -> access token, scope webmasters (read+write)
//   node gsc-token.mjs --readonly -> access token, scope webmasters.readonly
//
// Secret Manager stores STRING values only (no "file" secret type like the vault this
// used to read from) - the service-account JSON is stored as a plain JSON string and
// parsed here.
//
// Exit codes (the calling skill acts on these):
//   0 ok | 4 GSC_SERVICE_ACCOUNT not configured yet (delegate to _setup-gsc) | 1 other

import crypto from "node:crypto";
import { getSecret } from "../scaleway/secrets.mjs";
import { ScwError } from "../scaleway/_scw-auth.mjs";

const readonly = process.argv.includes("--readonly");
const SCOPE = readonly
  ? "https://www.googleapis.com/auth/webmasters.readonly"
  : "https://www.googleapis.com/auth/webmasters https://www.googleapis.com/auth/siteverification";

// 1. Pull the SA JSON from Secret Manager (propagate a "not configured" signal as exit 4
//    so the calling skill can delegate to _setup-gsc, same contract as before).
let sa;
try {
  const raw = await getSecret("GSC_SERVICE_ACCOUNT");
  sa = JSON.parse(raw);
} catch (e) {
  if (e instanceof ScwError && e.type === "not_found") {
    console.error("GSC_SERVICE_ACCOUNT not found in Secret Manager.");
    process.exit(4);
  }
  if (e instanceof SyntaxError) {
    console.error("GSC_SERVICE_ACCOUNT is not valid JSON.");
    process.exit(1);
  }
  console.error(String((e && e.message) || e));
  process.exit(1);
}

// 2. Build + sign the JWT (RS256).
const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const now = Math.floor(Date.now() / 1000);
const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
const claims = b64url(
  JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri, exp: now + 3600, iat: now })
);
const signingInput = `${header}.${claims}`;
const signer = crypto.createSign("RSA-SHA256");
signer.update(signingInput);
const jwt = `${signingInput}.${b64url(signer.sign(sa.private_key))}`;

// 3. Exchange the JWT for an access token.
let data;
try {
  const res = await fetch(sa.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  if (!res.ok) {
    console.error(`Token exchange failed: HTTP ${res.status}`);
    process.exit(1);
  }
  data = await res.json();
} catch (e) {
  console.error(String((e && e.message) || e));
  process.exit(1);
}
if (!data.access_token) {
  console.error("Token exchange failed:", JSON.stringify(data));
  process.exit(1);
}
process.stdout.write(data.access_token);
