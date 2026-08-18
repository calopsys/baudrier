#!/usr/bin/env node
/**
 * verify.mjs - integrity gate for baudrier.
 *
 * The harness cannot be end-to-end tested without live Scaleway credentials,
 * so this script is the definition of "it works" for everything that CAN be
 * checked statically:
 *
 *   1. syntax     every .mjs parses (node --check)
 *   2. imports    every relative ESM import resolves on disk
 *   3. scripts    every scripts/... path named in a SKILL.md exists
 *   4. skills     every skill referenced by a SKILL.md exists (and no
 *                 reference to a skill we deleted survives)
 *   5. renders    every render() target in scripts/*.mjs resolves under templates/
 *   6. providers  no removed-provider tokens survive outside allowlisted docs
 *   7. envvars    no removed-provider env vars survive
 *
 * Usage:
 *   node tools/verify.mjs              # human report, exit 1 on failure
 *   node tools/verify.mjs --json       # machine readable
 *   node tools/verify.mjs --only 6     # run a single check
 *   node tools/verify.mjs --quiet      # summary lines only
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
const QUIET = argv.includes("--quiet");
const ONLY = (() => {
  const i = argv.indexOf("--only");
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(",") : null;
})();

/* ------------------------------------------------------------------ helpers */

const IGNORE_DIRS = new Set([".git", "node_modules", ".opencode", ".next", ".claude"]);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const ALL_FILES = walk(ROOT).map((f) => path.relative(ROOT, f));
const rel = (f) => f.split(path.sep).join("/");
const FILES = ALL_FILES.map(rel);
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const exists = (f) => fs.existsSync(path.join(ROOT, f));

const MJS = FILES.filter((f) => f.endsWith(".mjs"));

/**
 * Strip line and block comments so a check tests real code, not prose. Several
 * files deliberately name a forbidden function in a comment to explain that they
 * do not call it; flagging those would be a false positive.
 *
 * One combined regex, one left-to-right pass - not two separate global
 * replaces. A prior two-pass version ran the block-comment strip over the
 * whole file first, so a `//` line comment whose text happens to contain a
 * literal slash-star (e.g. a path glob like "scripts/scaleway/*") was
 * misread as opening a real block comment; it then swallowed everything up
 * to the next accidental block-comment closer found anywhere later in the
 * file - once, this ate ~22 KB of real code, silently hiding an unrelated
 * check's target line. A single pass with both alternatives tried at each
 * position resolves this correctly: at the `//` that actually starts the
 * comment, the block-comment alternative cannot match there (next char is
 * `/`, not `*`), so the line-comment alternative wins and consumes the rest
 * of the line - including any later slash-star text on it - before that
 * text is ever considered as a fresh match.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, (m, linePrefix) => (m.startsWith("/*") ? "" : linePrefix));
}
const SKILL_MDS = FILES.filter((f) => /^skills\/[^/]+\/SKILL\.md$/.test(f));
const SKILL_DIRS = fs
  .readdirSync(path.join(ROOT, "skills"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

/** Skills intentionally removed by the fork. Any surviving reference is a bug. */
const DELETED_SKILLS = [
  "add-i18n", "add-github-auth", "add-google-auth", "add-stripe",
  "add-backup-db", "new-email-address", "add-collab", "quotas",
  "_dns-brevo", "_dns-cloudflare", "_dns-gandi", "_dns-godaddy-manual",
  "_dns-hostinger", "_dns-infomaniak-manual", "_dns-ionos-manual",
  "_dns-namecheap", "_dns-ovh", "_dns-porkbun", "_dns-resend",
  "_dns-squarespace-manual", "_setup-render", "_create-render-worker",
  "_create-cloudflare-worker", "_migrate-workers", "_setup-wrangler",
  "_setup-stripe-cli", "_setup-github-deploy", "_add-keyring",
  "_ensure-vault", "_get-secret",
];

/** Skills that must exist by the end of the conversion. */
const REQUIRED_NEW_SKILLS = ["deploy", "publish", "unpublish", "scale", "costs"];

/** Docs where naming a removed provider is legitimate (history/attribution). */
const PROVIDER_DOC_ALLOWLIST = new Set([
  "NOTICE", "LICENSE", "CHANGELOG.md", "README.md",
  // CLAUDE.md states the Apache-2.0 derivation for whoever picks the repo up.
  // These are attribution and provider-history docs: naming the upstream
  // project is the point, not a leftover.
  "CONTRACT.md", "CLAUDE.md", "tools/verify.mjs",
]);

/**
 * Removed-provider tokens. `allow` lists paths where the pattern is expected
 * for unrelated reasons (e.g. scripts/_render.mjs is a template renderer and
 * has nothing to do with Render.com).
 */
const BANNED = [
  { name: "Vercel", re: /vercel/i },
  { name: "Neon", re: /\bneon\b/i },
  { name: "Cloudflare", re: /cloudflare|\bCF_[A-Z]/ },
  { name: "wrangler", re: /wrangler/i },
  { name: "Cloudflare R2", re: /\bR2_[A-Z]|r2\.cloudflarestorage/ },
  { name: "Render.com", re: /\bRender\b|RENDER_[A-Z]|render\.com/, allow: [/^scripts\/_render\.mjs$/] },
  { name: "Resend", re: /\bResend\b|RESEND_[A-Z]/ },
  { name: "Brevo", re: /brevo/i },
  { name: "Bitwarden", re: /bitwarden|\bbw\s+(get|list|unlock|login|config|create)\b/i },
  { name: "Stripe", re: /stripe/i },
  { name: "Anthropic API", re: /ANTHROPIC_API_KEY|api\.anthropic\.com/ },
  { name: "Google Analytics", re: /GA_MEASUREMENT_ID|NEXT_PUBLIC_GA_|googletagmanager|gtag\(/ },
  { name: "Upstash", re: /upstash/i },
];

/** Removed-provider env vars, with their intended replacement. */
const BANNED_ENV = {
  VERCEL_TOKEN: "SCW_SECRET_KEY",
  VERCEL_URL: "APP_URL",
  NEON_API_KEY: "SCW_SECRET_KEY",
  CLOUDFLARE_API_TOKEN: "SCW_SECRET_KEY",
  CF_API_TOKEN: "SCW_SECRET_KEY",
  CLOUDFLARE_ACCOUNT_ID: "SCW_DEFAULT_PROJECT_ID",
  CF_ACCOUNT_ID: "SCW_DEFAULT_PROJECT_ID",
  R2_ACCESS_KEY_ID: "SCW_ACCESS_KEY",
  R2_SECRET_ACCESS_KEY: "SCW_SECRET_KEY",
  R2_ENDPOINT: "STORAGE_ENDPOINT",
  R2_BUCKET_NAME: "STORAGE_BUCKET",
  R2_BUCKET: "STORAGE_BUCKET",
  R2_PUBLIC_URL: "STORAGE_PUBLIC_URL",
  R2_ACCOUNT_ID: "SCW_DEFAULT_PROJECT_ID",
  RESEND_API_KEY: "SCW_SECRET_KEY",
  RESEND_FROM_EMAIL: "TEM_SENDER_EMAIL",
  RESEND_SENDER_EMAIL: "TEM_SENDER_EMAIL",
  BREVO_API_KEY: "SCW_SECRET_KEY",
  BREVO_SENDER_EMAIL: "TEM_SENDER_EMAIL",
  BREVO_SENDER_NAME: "TEM_SENDER_NAME",
  RENDER_API_KEY: "SCW_SECRET_KEY",
  STRIPE_SECRET_KEY: null,
  STRIPE_WEBHOOK_SECRET: null,
  ANTHROPIC_API_KEY: "SCW_GENERATIVE_API_KEY",
  NEXT_PUBLIC_GA_MEASUREMENT_ID: "NEXT_PUBLIC_MATOMO_SITE_ID",
  NEXT_PUBLIC_GA_ID: "NEXT_PUBLIC_MATOMO_SITE_ID",
};

/* ------------------------------------------------------------------- checks */

const checks = [];
const define = (id, title, fn) => checks.push({ id, title, fn });

define("1", "Syntax: every .mjs parses", () => {
  const fails = [];
  for (const f of MJS) {
    try {
      execFileSync(process.execPath, ["--check", path.join(ROOT, f)], { stdio: "pipe" });
    } catch (e) {
      const msg = (e.stderr?.toString() || e.message).split("\n").find((l) => l.includes("Error")) || "parse error";
      fails.push({ file: f, detail: msg.trim() });
    }
  }
  return fails;
});

define("2", "Imports: relative ESM imports resolve", () => {
  const fails = [];
  // Allow newlines (multi-line `import { a, b } from "..."`) but never cross a
  // `;` or a backtick, so the match cannot run out of a real import statement
  // and into an `import ... from "./x"` string that merely appears inside a
  // template literal of generated code.
  const RE = /(?:^|\n)[ \t]*(?:import|export)\b[^;`]*?\bfrom\s+["'](\.[^"']+)["']/g;
  const DYN = /import\(\s*["'](\.[^"']+)["']\s*\)/g;
  for (const f of MJS) {
    const src = read(f);
    for (const re of [RE, DYN]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const spec = m[1];
        const target = path.resolve(path.dirname(path.join(ROOT, f)), spec);
        if (!fs.existsSync(target)) {
          fails.push({ file: f, detail: `unresolved import "${spec}"` });
        }
      }
    }
  }
  return fails;
});

define("3", "Scripts: paths named in SKILL.md exist", () => {
  const fails = [];
  const RE = /scripts\/[A-Za-z0-9_\-./]*\.(?:mjs|sh|json|js)/g;
  for (const f of [...SKILL_MDS, ...FILES.filter((x) => /^skills\/.*\.md$/.test(x))]) {
    const src = read(f);
    const seen = new Set();
    let m;
    RE.lastIndex = 0;
    while ((m = RE.exec(src))) {
      let p = m[0].replace(/\.$/, "");
      if (seen.has(p)) continue;
      seen.add(p);
      if (!exists(p)) fails.push({ file: f, detail: `missing ${p}` });
    }
  }
  return [...new Map(fails.map((x) => [x.file + x.detail, x])).values()];
});

define("4", "Skills: referenced skills exist, deleted ones are gone", () => {
  const fails = [];
  const deleted = new Set(DELETED_SKILLS);
  for (const f of FILES.filter((x) => x.startsWith("skills/") && x.endsWith(".md"))) {
    const src = read(f);
    for (const name of deleted) {
      const re = new RegExp(`(?<![A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`);
      if (re.test(src)) fails.push({ file: f, detail: `references deleted skill "${name}"` });
    }
    // Slash-commands pointing at nonexistent skills. Restricted to the
    // `add-*` naming convention: prose legitimately contains page paths like
    // `/contact` or `/agences`, which are not skill references.
    for (const m of src.matchAll(/`\/(add-[a-z0-9-]+)`/g)) {
      const n = m[1];
      if (!SKILL_DIRS.includes(n) && !deleted.has(n)) {
        fails.push({ file: f, detail: `slash-command /${n} has no skill directory` });
      }
    }
  }
  for (const n of REQUIRED_NEW_SKILLS) {
    if (!SKILL_DIRS.includes(n)) fails.push({ file: "skills/", detail: `required new skill "${n}" not created` });
  }

  // /start is retired. It is asserted by directory rather than through
  // DELETED_SKILLS: that list matches whole words in every skill markdown, and
  // "start" is an ordinary English word that appears in legitimate prose.
  // Its surviving checks live in _preflight, which /bootstrap runs at Step 0 -
  // a public onboarding skill coming back would restore the dead end where a
  // user ran it, read "now type /bootstrap", and never did.
  if (SKILL_DIRS.includes("start")) {
    fails.push({ file: "skills/start", detail: "the retired /start skill is back - its checks belong in skills/_preflight, invoked by /bootstrap Step 0" });
  }
  if (!SKILL_DIRS.includes("_preflight")) {
    fails.push({ file: "skills/_preflight", detail: "the internal preflight skill is missing - /bootstrap Step 0 has nothing to invoke" });
  }
  return [...new Map(fails.map((x) => [x.file + x.detail, x])).values()];
});

define("5", "Renders: every render() target resolves under templates/", () => {
  const fails = [];
  const scripts = FILES.filter((f) => /^scripts\/.*\.mjs$/.test(f) && f !== "scripts/_render.mjs");

  const checkId = (file, id) => {
    if (!exists(`templates/${id}`)) fails.push({ file, detail: `render("${id}") -> missing templates/${id}` });
  };

  // Direct literal calls: render("id/file.ext", ...). Covers the vast
  // majority of call sites across scripts/*.mjs.
  for (const f of scripts) {
    const src = read(f);
    for (const m of src.matchAll(/render\(\s*["']([^"'`]+)["']/g)) {
      checkId(f, m[1]);
    }
  }

  // setup-auth-users.mjs writeAuthPages(): render(`${f.id}/${variant}.tsx`,
  // ...) built from a `features` array of { id } entries and one hardcoded
  // `variant`. Neither is a literal at the call site, so both are resolved
  // from their declarations instead.
  const authUsers = "scripts/setup-auth-users.mjs";
  if (exists(authUsers)) {
    const src = read(authUsers);
    if (/render\(`\$\{f\.id\}\/\$\{variant\}\.tsx`/.test(src)) {
      const variant = src.match(/const variant = "([^"]+)"/)?.[1];
      const featAt = src.indexOf("const features = [");
      const featEnd = featAt >= 0 ? src.indexOf("];", featAt) : -1;
      if (!variant || featAt < 0) {
        fails.push({
          file: authUsers,
          detail: "writeAuthPages()'s dynamic render() target can no longer be resolved statically - `variant` or the `features` array is not in the expected shape",
        });
      } else {
        const block = src.slice(featAt, featEnd > 0 ? featEnd : undefined);
        const ids = [...block.matchAll(/\{\s*id:\s*"([^"]+)"/g)].map((mm) => mm[1]);
        if (!ids.length) fails.push({ file: authUsers, detail: 'features array has no { id: "..." } entries' });
        for (const id of ids) checkId(authUsers, `${id}/${variant}.tsx`);
      }
    }

    // writeAuthRouter(): render(templatePath) where templatePath is a ternary
    // of two literals, neither of which sits at the call site.
    if (/render\(templatePath/.test(src)) {
      const ternary = src.match(/const templatePath = state\.\w+\s*\n?\s*\?\s*"([^"]+)"\s*\n?\s*:\s*"([^"]+)"/);
      if (!ternary) {
        fails.push({ file: authUsers, detail: "render(templatePath) target ternary no longer matches the expected two-literal shape" });
      } else {
        checkId(authUsers, ternary[1]);
        checkId(authUsers, ternary[2]);
      }
    }
  }

  // setup-auth-admin.mjs writeAdminPages(): render(tplPath) destructured from
  // a `targets` array of [dest, tplPath] tuples.
  const authAdmin = "scripts/setup-auth-admin.mjs";
  if (exists(authAdmin)) {
    const src = read(authAdmin);
    if (/render\(tplPath/.test(src)) {
      const targetsAt = src.indexOf("const targets = [");
      const targetsEnd = targetsAt >= 0 ? src.indexOf("];", targetsAt) : -1;
      if (targetsAt < 0) {
        fails.push({ file: authAdmin, detail: "render(tplPath) target array `targets` no longer found" });
      } else {
        const block = src.slice(targetsAt, targetsEnd > 0 ? targetsEnd : undefined);
        const ids = [...block.matchAll(/\[\s*"[^"]+"\s*,\s*"([^"]+)"\s*\]/g)].map((mm) => mm[1]);
        if (!ids.length) fails.push({ file: authAdmin, detail: "targets array has no [dest, tplPath] tuples" });
        for (const id of ids) checkId(authAdmin, id);
      }
    }
  }

  // setup-2fa.mjs writeCode(): render(tpl, vars) destructured from a `writes`
  // array of [relDest, tpl, vars] tuples.
  const setup2fa = "scripts/setup-2fa.mjs";
  if (exists(setup2fa)) {
    const src = read(setup2fa);
    if (/render\(tpl,/.test(src)) {
      const writesAt = src.indexOf("const writes = [");
      const writesEnd = writesAt >= 0 ? src.indexOf("];", writesAt) : -1;
      if (writesAt < 0) {
        fails.push({ file: setup2fa, detail: "render(tpl, vars) target array `writes` no longer found" });
      } else {
        const block = src.slice(writesAt, writesEnd > 0 ? writesEnd : undefined);
        const ids = [...block.matchAll(/\[\s*"[^"]+"\s*,\s*"([^"]+)"/g)].map((mm) => mm[1]);
        if (!ids.length) fails.push({ file: setup2fa, detail: "writes array has no [relDest, tpl, vars] tuples" });
        for (const id of ids) checkId(setup2fa, id);
      }
    }
  }

  return fails;
});

define("6", "Providers: no removed-provider tokens survive", () => {
  const fails = [];
  for (const f of FILES) {
    if (PROVIDER_DOC_ALLOWLIST.has(f)) continue;
    if (f.startsWith("tools/")) continue;
    let src;
    try {
      src = read(f);
    } catch {
      continue;
    }
    const lines = src.split("\n");
    for (const b of BANNED) {
      if (b.allow?.some((r) => r.test(f))) continue;
      const hits = [];
      lines.forEach((l, i) => {
        if (b.re.test(l)) hits.push(i + 1);
      });
      if (hits.length) {
        fails.push({
          file: f,
          detail: `${b.name} x${hits.length} (lines ${hits.slice(0, 6).join(",")}${hits.length > 6 ? "…" : ""})`,
        });
      }
    }
  }
  return fails;
});

define("7", "Env vars: no removed-provider env vars survive", () => {
  const fails = [];
  for (const f of FILES) {
    if (PROVIDER_DOC_ALLOWLIST.has(f)) continue;
    if (f.startsWith("tools/")) continue;
    let src;
    try {
      src = read(f);
    } catch {
      continue;
    }
    for (const [v, repl] of Object.entries(BANNED_ENV)) {
      const re = new RegExp(`(?<![A-Z0-9_])${v}(?![A-Z0-9_])`, "g");
      const n = [...src.matchAll(re)].length;
      if (n) {
        fails.push({ file: f, detail: `${v} x${n} -> ${repl ? `use ${repl}` : "REMOVE (provider dropped)"}` });
      }
    }
  }
  return fails;
});

define("8", "Branding: no upstream product name outside attribution docs", () => {
  // hypervibe-harness is Apache-2.0, but our own NOTICE records that the licence
  // grants no right to the "Hypervibe" name. Using it in shipped copy would be a
  // trademark problem, not just a cosmetic one.
  const fails = [];
  for (const f of FILES) {
    if (PROVIDER_DOC_ALLOWLIST.has(f) || f.startsWith("tools/")) continue;
    let src;
    try {
      src = read(f);
    } catch {
      continue;
    }
    const n = (src.match(/hypervibe/gi) || []).length;
    if (n) fails.push({ file: f, detail: `"Hypervibe" x${n} - rebrand to Baudrier` });
  }
  return fails;
});

define("9", "Skill structure: frontmatter, naming, and required docs", () => {
  const fails = [];
  for (const dir of SKILL_DIRS) {
    const skillMd = `skills/${dir}/SKILL.md`;
    if (!exists(skillMd)) {
      fails.push({ file: `skills/${dir}`, detail: "no SKILL.md" });
      continue;
    }
    const src = read(skillMd);
    const fm = src.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) {
      fails.push({ file: skillMd, detail: "missing YAML frontmatter" });
      continue;
    }
    const body = fm[1];
    const name = body.match(/^name:\s*(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (!name) fails.push({ file: skillMd, detail: "frontmatter has no name" });
    else if (name !== dir) fails.push({ file: skillMd, detail: `frontmatter name "${name}" != directory "${dir}"` });
    if (!/^description:/m.test(body)) fails.push({ file: skillMd, detail: "frontmatter has no description" });

    const internal = dir.startsWith("_");
    if (internal) {
      if (!/^user-invocable:\s*false/m.test(body)) {
        fails.push({ file: skillMd, detail: "internal skill must declare user-invocable: false" });
      }
      if (exists(`skills/${dir}/DOC.md`)) {
        fails.push({ file: skillMd, detail: "internal skill must not ship DOC.md" });
      }
    } else {
      for (const doc of ["DOC.md", "DOC.fr.md"]) {
        if (!exists(`skills/${dir}/${doc}`)) fails.push({ file: `skills/${dir}`, detail: `public skill missing ${doc}` });
      }
    }
  }
  return fails;
});

define("10", "Orphans: every script is reachable from a skill or another script", () => {
  const fails = [];
  // Comments are stripped from .mjs sources: a script merely *mentioned* in
  // another file's comment is still orphaned, and counting that as a reference
  // let a dead module (with a dangling execSync to a deleted file) pass.
  // verify.mjs is excluded from the corpus: it names scripts in order to ASSERT
  // things about them (check 16's required list), which is not a call site. Left
  // in, the verifier would keep any file it mentions permanently "reachable".
  const corpus = [...SKILL_MDS, ...FILES.filter((f) => f.startsWith("skills/") && f.endsWith(".md")), ...MJS]
    .filter((f) => f !== "tools/verify.mjs")
    .map((f) => {
      try {
        return f.endsWith(".mjs") ? stripComments(read(f)) : read(f);
      } catch {
        return "";
      }
    })
    .join("\n");
  for (const s of FILES.filter((f) => f.startsWith("scripts/"))) {
    const base = path.posix.basename(s);
    // Count references outside the file's own source. `own` must be stripped the
    // same way the corpus is, or a file whose header comment names itself
    // subtracts more than the corpus counted and looks falsely orphaned.
    //
    // Only subtract when the file is actually IN the corpus. The corpus holds
    // .md and .mjs; a .sh script's self-mentions were never counted, so
    // subtracting them drives refs negative and reports a false orphan. That
    // stayed hidden while no shell script happened to name itself.
    const inCorpus = s.endsWith(".mjs") || (s.startsWith("skills/") && s.endsWith(".md"));
    let own = "";
    if (inCorpus) {
      try {
        own = s.endsWith(".mjs") ? stripComments(read(s)) : read(s);
      } catch {}
    }
    const refs = corpus.split(base).length - 1 - (own.split(base).length - 1);
    if (refs <= 0) fails.push({ file: s, detail: "not referenced by any skill or script" });
  }
  return fails;
});

define("11", "Data safety: destructive ops guarded, deletion unreachable", () => {
  const fails = [];

  // (a) the guard module must exist and refuse generic overrides
  const guard = "scripts/scaleway/_destructive-guard.mjs";
  if (!exists(guard)) {
    fails.push({ file: guard, detail: "destructive guard module is missing" });
  } else {
    const src = read(guard);
    if (!/BAUDRIER_ALLOW_DESTRUCTIVE/.test(src)) {
      fails.push({ file: guard, detail: "guard does not reference BAUDRIER_ALLOW_DESTRUCTIVE" });
    }
  }

  // (b) deleteDatabase / deleteBucket must call the guard before any API call
  for (const [file, fn] of [
    ["scripts/scaleway/sdb.mjs", "deleteDatabase"],
    ["scripts/scaleway/object-storage.mjs", "deleteBucket"],
  ]) {
    if (!exists(file)) continue;
    const src = read(file);
    const at = src.indexOf(`function ${fn}`);
    if (at < 0) continue;
    const body = src.slice(at, at + 900);
    if (!/assertDestructiveAllowed/.test(body)) {
      fails.push({ file, detail: `${fn}() does not call assertDestructiveAllowed` });
    }
  }

  // (c) nothing outside the scaleway modules may CALL these functions -
  //     /delete-project must have no code path to them. Comments are stripped
  //     first: several files legitimately mention the names to explain that they
  //     deliberately do not call them.
  for (const f of MJS) {
    if (f.startsWith("scripts/scaleway/")) continue;
    const code = stripComments(read(f));
    for (const fn of ["deleteDatabase", "deleteBucket"]) {
      if (new RegExp(`\\b${fn}\\s*\\(`).test(code)) {
        fails.push({ file: f, detail: `calls ${fn}() - data deletion must stay unreachable outside the guarded module` });
      }
    }
  }

  // (d) bucket creation must enable versioning: it is the only backup of file data
  const os = "scripts/scaleway/object-storage.mjs";
  if (exists(os)) {
    const src = read(os);
    if (!/Versioning/i.test(src)) fails.push({ file: os, detail: "no bucket versioning support found" });
    if (!/Lifecycle/i.test(src)) fails.push({ file: os, detail: "no lifecycle configuration support found" });
  }
  return fails;
});

define("12", "Access control: proxy fails closed", () => {
  const fails = [];
  const mw = "templates/deploy/proxy.ts";
  if (!exists(mw)) return [{ file: mw, detail: "access middleware is missing" }];
  const src = read(mw);

  // Next 16 renamed middleware.ts to proxy.ts; the exported function must
  // keep the name Next 16 requires.
  if (!/export function proxy\(/.test(src)) {
    fails.push({ file: mw, detail: "Next 16 renamed middleware.ts to proxy.ts and the export must be named proxy" });
  }

  // Fail-closed means the bypass is gated on an explicit "false", never on
  // `!== "true"` (which would publish the app whenever the var is unset).
  if (/ACCESS_RESTRICTED\s*!==\s*["']true["']/.test(src)) {
    fails.push({ file: mw, detail: 'fails OPEN: bypass gated on ACCESS_RESTRICTED !== "true"; an unset var would publish the app' });
  }
  if (!/ACCESS_RESTRICTED\s*===\s*["']false["']/.test(src)) {
    fails.push({ file: mw, detail: 'expected the bypass to require ACCESS_RESTRICTED === "false"' });
  }
  for (const must of ["acme-challenge", "ALWAYS_ALLOWED"]) {
    if (!src.includes(must)) fails.push({ file: mw, detail: `missing "${must}" - ACME and health-check paths must be exempt in every state` });
  }

  // The harness token bypass (CONTRACT.md §6) must exist AND fail closed: an
  // unset or short ACCESS_BYPASS_TOKEN means no bypass path at all. The
  // length guard is what refuses an accidentally empty/weak configured value.
  for (const must of ["ACCESS_BYPASS_TOKEN", "x-baudrier-access-token", "MIN_BYPASS_TOKEN_LENGTH"]) {
    if (!src.includes(must)) {
      fails.push({ file: mw, detail: `missing "${must}" - the harness token bypass (CONTRACT.md §6) is gone or lost its fail-closed length guard` });
    }
  }
  // Runtime-agnostic constraint: proxy.ts must not import node:crypto for
  // the compare - the hand-rolled XOR loop is the sanctioned form. Comment-
  // stripped: the file's own comment names node:crypto to explain the rule.
  if (stripComments(src).includes("node:crypto")) {
    fails.push({ file: mw, detail: "imports node:crypto - proxy.ts must stay runtime-agnostic; use the hand-rolled XOR compare (CONTRACT.md §6)" });
  }

  // No built-in allowlist: a hardcoded address ships every new project
  // reachable only from one operator's machine (verified on a live run -
  // the two literals below were the original author's VPN endpoints).
  // bootstrap-init.mjs seeds ACCESS_ALLOWED_IPS with the detected egress
  // address instead. Comment-stripped so prose examples cannot trip it.
  const mwCode = stripComments(src);
  for (const leftover of ["163.172.162.25", "2001:bc8:711"]) {
    if (mwCode.includes(leftover)) fails.push({ file: mw, detail: `hardcodes the original author's VPN address ${leftover} - the allowlist must come from ACCESS_ALLOWED_IPS only` });
  }
  if (/DEFAULT_ALLOWED_IPS/.test(mwCode)) {
    fails.push({ file: mw, detail: "reintroduces a DEFAULT_ALLOWED_IPS fallback - unset ACCESS_ALLOWED_IPS must mean an empty allowlist (fail closed)" });
  }
  // The generated app lints this file: Array(n).fill() is any[] and trips
  // no-unsafe-argument (verified on a live `pnpm lint`).
  if (/Array\(\s*\w+\s*\)\.fill\(/.test(mwCode)) {
    fails.push({ file: mw, detail: "Array(n).fill() is any[] and fails the generated app's lint - use Array.from({length: n}, ...)" });
  }
  if (!read("scripts/bootstrap-init.mjs").includes("ACCESS_ALLOWED_IPS")) {
    fails.push({ file: "scripts/bootstrap-init.mjs", detail: "no longer seeds ACCESS_ALLOWED_IPS - with no built-in allowlist, every restricted app would reject its own operator" });
  }

  // ACCESS_RESTRICTED must never go through the plain env channel, which
  // also replaces the whole map on write (same v1 write-replaces-map
  // behaviour as the secret channel, see container.mjs's header comment) -
  // it belongs in the secret channel, which syncContainerSecrets() rebuilds
  // whole from Secret Manager.
  for (const f of MJS) {
    const src2 = read(f);
    if (/environmentVariables:\s*\{[^}]*ACCESS_RESTRICTED/s.test(src2)) {
      fails.push({ file: f, detail: "writes ACCESS_RESTRICTED to the plain env channel, which replaces the whole map; use syncContainerSecrets" });
    }
  }
  return fails;
});

define("13", "No stale --target flag (push-env-vars takes --env)", () => {
  const fails = [];
  for (const f of FILES) {
    if (PROVIDER_DOC_ALLOWLIST.has(f) || f.startsWith("tools/")) continue;
    let src;
    try {
      src = read(f);
    } catch {
      continue;
    }
    // Only a --target passed TO push-env-vars is a bug. deploy.mjs, scale.mjs
    // and rotate-secret.mjs each have their own legitimate --target flag.
    for (const line of src.split("\n")) {
      if (/push-env-vars/.test(line) && /--target/.test(line)) {
        fails.push({ file: f, detail: "passes --target to push-env-vars, which only parses --env; this writes a literal '--target' secret" });
        break;
      }
    }
  }
  return fails;
});

define("14", "Code hygiene: argv-spawn, main-module guard, LF everywhere", () => {
  const fails = [];

  for (const f of MJS) {
    // This file necessarily contains the very patterns it forbids, as regexes
    // and message text. It has no CLI guard of its own to get wrong.
    if (f === "tools/verify.mjs") continue;

    const src = read(f);
    const code = stripComments(src);

    // 1. `file://${process.argv[1]}` never matches import.meta.url on Windows.
    //    argv[1] is `C:\a\b.mjs`, so the template yields `file://C:\a\b.mjs`
    //    while import.meta.url is `file:///C:/a/b.mjs`. The CLI entry point then
    //    silently never fires - the script becomes a no-op when run directly.
    if (/file:\/\/\$\{process\.argv\[1\]/.test(code)) {
      fails.push({
        file: f,
        detail: 'main-module guard uses `file://${process.argv[1]}` - never matches on Windows; use pathToFileURL(process.argv[1] ?? "").href',
      });
    }

    // 2. exec/execSync with an interpolated command string: cmd.exe and POSIX
    //    shells disagree on quoting, and it is an injection vector.
    if (/\b(?:execSync|exec)\s*\(\s*[`"']/.test(code)) {
      fails.push({ file: f, detail: "exec/execSync with an interpolated string - use spawn(cmd, argsArray)" });
    }

    // 3. Binaries that do not exist on Windows, spawned directly.
    for (const bin of ["dig", "nslookup", "diff", "sed", "awk", "which", "chmod", "grep"]) {
      const re = new RegExp(`spawn(?:Sync)?\\(\\s*["'\`]${bin}["'\`]`);
      if (re.test(code)) {
        fails.push({ file: f, detail: `spawns "${bin}", which does not exist on Windows` });
      }
    }
  }

  // 4. .gitattributes must pin LF, or a checkout converts everything to CRLF
  //    and every generated shell script's shebang breaks in the Linux VM.
  if (!exists(".gitattributes")) {
    fails.push({ file: ".gitattributes", detail: "missing - a checkout could convert to CRLF and break generated shell script shebangs" });
  } else {
    const ga = read(".gitattributes");
    if (!/eol=lf/.test(ga)) fails.push({ file: ".gitattributes", detail: "does not pin eol=lf" });
    // Comment lines may explain WHY LF matters (that mentions CRLF); only an
    // attribute line that sets eol=crlf is a real exemption coming back.
    for (const line of ga.split("\n")) {
      if (line.trimStart().startsWith("#")) continue;
      if (/crlf/i.test(line)) fails.push({ file: ".gitattributes", detail: `crlf rule resurfaced: "${line.trim()}" - the repo is web-only, no file may check out as CRLF` });
    }
  }

  // 5. Nothing tracked may already contain CRLF.
  for (const f of FILES) {
    let buf;
    try {
      buf = fs.readFileSync(path.join(ROOT, f));
    } catch {
      continue;
    }
    if (buf.includes(Buffer.from("\r\n"))) fails.push({ file: f, detail: "contains CRLF line endings" });
  }

  return fails;
});

define("15", "Deps: one resolver, no reimplemented data directory", () => {
  const fails = [];
  const RESOLVER = "tools/deps-dir.mjs";
  if (!exists(RESOLVER)) {
    fails.push({ file: RESOLVER, detail: "the shared dependency resolver is missing" });
    return fails;
  }
  // Every consumer must route through the resolver. ${CLAUDE_PLUGIN_DATA} is
  // exported to hook processes but NOT to Bash tool calls, so a script that
  // resolves the directory on its own silently disagrees with the installer
  // and every Scaleway call fails with "dependencies not installed".
  for (const f of ["scripts/scaleway/_deps.mjs", "tools/bootstrap-deps.mjs", "tools/check-deps-health.mjs"]) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "expected dependency consumer is missing" });
      continue;
    }
    if (!/deps-dir\.mjs/.test(read(f))) {
      fails.push({ file: f, detail: `does not import ${RESOLVER} - it must not resolve the deps directory itself` });
    }
  }
  // The data directory is named "<plugin>-<marketplace>", which is only known
  // at install time. Any hardcoded path is a guess, and the wrong guess is
  // exactly the bug this check exists to prevent from coming back.
  for (const f of MJS) {
    // verify.mjs necessarily contains the forbidden pattern, as a regex.
    if (f === RESOLVER || f === "tools/verify.mjs") continue;
    const src = stripComments(read(f));
    if (/plugins[/\\]+data|["']plugins["']\s*,\s*["']data["']/.test(src)) {
      fails.push({ file: f, detail: `hardcodes a plugins/data path - resolve through ${RESOLVER} instead` });
    }
  }
  return fails;
});

define("16", "Preflight: web-only flow wired, native-OS paths stay dead", () => {
  const fails = [];
  const f = "skills/_preflight/SKILL.md";
  if (!exists(f)) return [{ file: f, detail: "the preflight skill is missing" }];
  const src = read(f);

  // The linear web-only flow: every step's script must actually be invoked,
  // and the guard must stop a non-web session with the French marker phrase.
  // The tool audit, the dockerd probe and the git identity all left with
  // /start: the platform preinstalls the tools, /bootstrap and /deploy start
  // dockerd lazily, and the sandbox commits as the `claude` user.
  const required = {
    "setup-clis-web.sh": "web sandbox setup script",
    "bootstrap-deps.mjs": "dependency gate (Step 2)",
    "check-scw-permissions.mjs": "organization-member permission probe",
    "CLAUDE_CODE_REMOTE": "web-session guard",
  };
  for (const [needle, what] of Object.entries(required)) {
    if (!src.includes(needle)) fails.push({ file: f, detail: `never invokes ${needle} (${what})` });
  }
  if (!src.includes("uniquement sur Claude Code web")) {
    fails.push({ file: f, detail: 'missing the French stop marker "uniquement sur Claude Code web" - a non-web session must be told to stop, in French' });
  }

  // Native-OS paths must stay dead: no skill may reference a deleted
  // installer, a deleted script, or a native-OS package manager.
  const FORBIDDEN = [
    "setup-clis-linux", "setup-clis-mac", "setup-clis-windows",
    "_ensure-tools-path", "ensure-pnpm-globalbin", "setup-gitleaks-global",
    "update-global-claude-md", "brew install", "winget install",
    /powershell/i, /\bWSL\b/,
  ];
  for (const skillMd of FILES.filter((x) => /^skills\/.*\.md$/.test(x))) {
    const s = read(skillMd);
    for (const needle of FORBIDDEN) {
      const hit = typeof needle === "string" ? s.includes(needle) : needle.test(s);
      if (hit) fails.push({ file: skillMd, detail: `references the dead native-OS path "${needle}" - web-only, this must not survive` });
    }
  }

  // The Scaleway step used to shell out to the scw binary through an inline
  // `node -e`. It now goes through the SDK, so the preflight never needs that
  // binary here.
  if (/scw\s+account\s+project/.test(src)) {
    fails.push({ file: f, detail: "still calls `scw account project` - the Scaleway step must use the SDK, not the scw CLI" });
  }

  // getSecret()'s CLI prints the value it resolves. BAUDRIER_DB_KEY holds raw
  // key material, so no SKILL.md may shell out to `secrets.mjs get` for it -
  // that would print the pair straight into the chat. Checked on every
  // skill, not just start: setup-db.mjs's delegated fallback reads this
  // secret, and any skill could be tempted to inspect it the same way.
  //
  // A line is only a leak if it tells the reader to RUN the command. A line
  // that warns the reader away from it (this repo's convention: a "never"
  // before the pattern, e.g. skills/add-db/SKILL.md) is the fix, not the bug.
  const LEAK_RE = /secrets\.mjs[^\n]*\bget\b[^\n]*BAUDRIER_DB_KEY/;
  for (const skillMd of SKILL_MDS) {
    for (const line of read(skillMd).split("\n")) {
      const hit = LEAK_RE.exec(line);
      if (hit && !/\bnever\b/i.test(line.slice(0, hit.index))) {
        fails.push({ file: skillMd, detail: "shells out to secrets.mjs get for BAUDRIER_DB_KEY - this prints the key material into the chat" });
        break;
      }
    }
  }

  // The shared harness Project design must not creep back in.
  for (const dir of ["skills", "scripts"]) {
    for (const rel of FILES.filter((x) => x.startsWith(`${dir}/`))) {
      let s;
      try {
        s = read(rel);
      } catch {
        continue;
      }
      if (/SCW_HARNESS_PROJECT_ID|ensure-shared-project/.test(s)) {
        fails.push({ file: rel, detail: "references the removed shared-Project design (SCW_HARNESS_PROJECT_ID / ensure-shared-project)" });
      }
    }
  }

  return fails;
});

define("17", "Docs: one French README carries the install chapter; deleted files stay deleted", () => {
  const fails = [];

  const adminDoc = "docs/ADMIN-SCALEWAY.md";
  if (!exists(adminDoc)) fails.push({ file: adminDoc, detail: "missing" });
  if (!exists("README.md")) {
    fails.push({ file: "README.md", detail: "missing" });
  } else {
    const src = read("README.md");
    if (exists(adminDoc) && !src.includes(adminDoc)) {
      fails.push({ file: "README.md", detail: `does not link ${adminDoc}` });
    }
    // Decision (2026-08-08): a single FRENCH README. The audience is
    // non-technical French users; the bilingual mirror was dropped.
    for (const needle of ["## Installation", "Cas A", "Cas B", "SCW_DEFAULT_PROJECT_ID"]) {
      if (!src.includes(needle)) fails.push({ file: "README.md", detail: `missing "${needle}" - the web-only Installation chapter must carry the admin/member fork` });
    }
  }

  // The three OS-specific install guides were absorbed into the README and
  // deleted outright; the English README mirror was dropped with them.
  for (const g of ["docs/INSTALL-WEB.md", "docs/INSTALL-LINUX.md", "docs/INSTALL-WINDOWS.md", "README.fr.md"]) {
    if (exists(g)) fails.push({ file: g, detail: "still exists - the README.md Installation chapter (French, single file) replaced it" });
  }

  // Neither the deleted install guides nor the dropped French mirror may be
  // referenced anywhere - CHANGELOG.md records history and this file's own
  // literals name them.
  for (const f of FILES) {
    if (f === "CHANGELOG.md" || f === "tools/verify.mjs") continue;
    let src;
    try {
      src = read(f);
    } catch {
      continue;
    }
    if (src.includes("docs/INSTALL-")) {
      fails.push({ file: f, detail: 'references "docs/INSTALL-" - the OS-specific install guides are deleted, this must not survive' });
    }
    if (src.includes("README.fr")) {
      fails.push({ file: f, detail: 'references "README.fr" - the French mirror was folded into README.md (single French README, 2026-08-08)' });
    }
  }

  return fails;
});

define("18", "Node floor: the required version is stated once and agrees everywhere", () => {
  const fails = [];
  if (!exists("package.json")) return [{ file: "package.json", detail: "missing" }];
  const engines = JSON.parse(read("package.json"))?.engines?.node || "";
  const floor = (engines.match(/(\d+\.\d+\.\d+)/) || [])[1];
  if (!floor) return [{ file: "package.json", detail: `engines.node ("${engines}") has no concrete minimum` }];

  // Several files carry a hardcoded fallback for when package.json cannot be
  // read. A drifting fallback is worse than none: it would silently accept a
  // Node that the harness rejects elsewhere. Debian trixie ships 20.19.2,
  // which is why this floor is load-bearing rather than cosmetic.
  for (const f of FILES.filter((x) => x.endsWith(".mjs") || x.endsWith(".sh"))) {
    if (f === "tools/verify.mjs") continue;
    let src;
    try {
      src = read(f);
    } catch {
      continue;
    }
    for (const line of src.split(/\r?\n/)) {
      if (!/floor|minimum/i.test(line)) continue;
      for (const m of line.matchAll(/\b(\d+\.\d+\.\d+)\b/g)) {
        // Skip 0.x.y: no Node release has a zero major, so such a number is
        // prose about a version *difference* (e.g. "below our floor by 0.0.3"),
        // not a floor being declared.
        if (m[1].startsWith("0.")) continue;
        if (m[1] !== floor) {
          fails.push({ file: f, detail: `states ${m[1]} where package.json engines.node requires ${floor}` });
        }
      }
    }
  }
  return fails;
});

define("19", "Delegation: the adoption and fingerprint layers stay deleted", () => {
  const fails = [];
  const src = "scripts/scaleway/iam.mjs";
  if (!exists(src)) return [{ file: src, detail: "iam.mjs is missing" }];
  const m = read(src).match(/export const DELEGATED_DB_KEY_SECRET_NAME\s*=\s*"([A-Z0-9_]+)"/);
  if (!m) {
    fails.push({ file: src, detail: "does not export DELEGATED_DB_KEY_SECRET_NAME as a string literal" });
    return fails;
  }
  // The Cas A path still mints this key, so CONTRACT.md must still name it.
  // The admin guide no longer does: an administrator provisions one IAM
  // application per Project now, not one secret per service.
  const name = m[1];
  if (!read("CONTRACT.md").includes(name)) {
    fails.push({ file: "CONTRACT.md", detail: `does not mention the delegated DB secret name "${name}"` });
  }

  // Each caller must go through the exported constant, never a hardcoded
  // copy of the literal - a rename in iam.mjs would then silently half-land.
  for (const f of ["scripts/setup-db.mjs", "scripts/deploy.mjs", "scripts/rotate-secret.mjs"]) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "expected delegated-fallback caller is missing" });
      continue;
    }
    if (!/DELEGATED_DB_KEY_SECRET_NAME/.test(read(f))) {
      fails.push({ file: f, detail: "does not reference DELEGATED_DB_KEY_SECRET_NAME - it must import the constant, not hardcode the secret name" });
    }
  }

  // Credentials are env-only (CONTRACT.md §2): the CLI that used to collect a
  // Scaleway key in chat and persist it is gone outright, not merely rewired.
  if (exists("scripts/collect-scw-credentials.mjs")) {
    fails.push({
      file: "scripts/collect-scw-credentials.mjs",
      detail: "still exists - credentials are env-only now (CONTRACT.md §2), nothing may collect a Scaleway key in chat again",
    });
  }

  // Two rejected designs must never creep back: the all-powerful operator
  // handover, and the BAUDRIER_APP_KEY adoption that /publish used to run.
  // Adoption went with the two-shape model: a Cas B key IS the app credential
  // from the start, so there is no key to adopt and no gate to pass.
  const DEAD_DESIGNS = /CALOPSYS_OPERATOR_CREDENTIALS|adopt-provisioned-credentials|adoptAppKey|APP_KEY_SECRET_NAME|BAUDRIER_APP_KEY|recordDevFingerprint|DEV_FINGERPRINTS_SECRET_NAME/;
  for (const f of FILES) {
    if (f === "tools/verify.mjs" || f === "CHANGELOG.md") continue;
    let s;
    try {
      s = read(f);
    } catch {
      continue;
    }
    if (DEAD_DESIGNS.test(s)) {
      fails.push({ file: f, detail: "references a deleted delegation mechanism (operator handover, BAUDRIER_APP_KEY adoption, or the dev-fingerprint manifest)" });
    }
  }

  // The dev-credential module was renamed when it stopped describing a
  // temporary state: in Cas B the operator key IS the app credential.
  if (exists("scripts/scaleway/dev-credentials.mjs")) {
    fails.push({
      file: "scripts/scaleway/dev-credentials.mjs",
      detail: "still exists - it is renamed app-credentials.mjs, since the credential it serves is permanent in Cas B, not a dev fallback",
    });
  }

  // /publish now does exactly one thing. The gate it used to run is gone, so
  // the flip is the whole skill and must still be there.
  const publishSkill = "skills/publish/SKILL.md";
  if (!exists(publishSkill)) {
    fails.push({ file: publishSkill, detail: "publish skill is missing" });
  } else {
    const pSrc = read(publishSkill);
    if (!pSrc.includes('ACCESS_RESTRICTED: "false"')) {
      fails.push({ file: publishSkill, detail: 'never flips ACCESS_RESTRICTED: "false" - that flip is now the entire purpose of /publish' });
    }
    if (/dev-credentials\.mjs|swap-all|devBacked/.test(pSrc)) {
      fails.push({ file: publishSkill, detail: "still runs the deleted dev-backed-credentials gate" });
    }
  }

  // BAUDRIER_CI_KEY: the whole CI-key IAM machinery was deleted outright
  // (CONTRACT.md §5's flagged fallout, now cleaned up) - no code path, admin
  // recipe, or skill prose may reintroduce any trace of it.
  const appCredsFile = "scripts/scaleway/app-credentials.mjs";
  if (exists(appCredsFile)) {
    const appCredsSrc = read(appCredsFile);
    if (/CI_KEY_ENTRY_NAME/.test(appCredsSrc)) {
      fails.push({ file: appCredsFile, detail: "still references CI_KEY_ENTRY_NAME - the CI-key machinery was deleted outright" });
    }
    if (/swapCiKey|case ["\'`]swap-ci["\'`]/.test(appCredsSrc)) {
      fails.push({ file: appCredsFile, detail: "still has swapCiKey/swap-ci - the CI-key swap was deleted outright" });
    }
  }
  const rotateSecretFile = "scripts/rotate-secret.mjs";
  if (exists(rotateSecretFile)) {
    const rotateSrc = read(rotateSecretFile);
    if (/rotateCi|case ["\'`]rotate-ci["\'`]/.test(rotateSrc)) {
      fails.push({ file: rotateSecretFile, detail: "still has rotateCi/rotate-ci - the CI-key rotation was deleted outright" });
    }
  }

  return fails;
});

define("20", "Repo-local credentials: the file-based tier is deleted, not merely hidden", () => {
  const fails = [];

  // CONTRACT.md §7: ".baudrier/" does not exist in the env-only model -
  // credentials are environment variables only, never written to a
  // repo-local file. This check used to require every leak-guard ignore file
  // to EXCLUDE ".baudrier/"; now that the directory itself is gone, the
  // opposite is true - a surviving ".baudrier/" special case would mean some
  // new code started writing repo-local secrets again.
  for (const f of ["templates/deploy/.dockerignore", "templates/agent/.dockerignore", "scripts/bootstrap-init.mjs"]) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "missing" });
      continue;
    }
    if (read(f).includes(".baudrier/")) {
      fails.push({ file: f, detail: 'still special-cases ".baudrier/" - the env-only model has no repo-local credentials directory to ignore or seed' });
    }
  }

  const auth = "scripts/scaleway/_scw-auth.mjs";
  if (!exists(auth)) {
    fails.push({ file: auth, detail: "missing" });
  } else if (read(auth).includes("credentials.json")) {
    fails.push({ file: auth, detail: 'references "credentials.json" - credentials are env-only now (CONTRACT.md §2), there is no repo-local tier left to read' });
  }

  // The direct-write CLI and its helper are the other half of the deleted
  // tier (check 19 guards scripts/collect-scw-credentials.mjs specifically;
  // this repeats the guard for its companion so either one reappearing alone
  // is still caught).
  if (exists("scripts/_persist-scw-credentials.mjs")) {
    fails.push({
      file: "scripts/_persist-scw-credentials.mjs",
      detail: "still exists - credentials are env-only now (CONTRACT.md §2), nothing may persist one to a repo-local file",
    });
  }

  return fails;
});

define("21", "Bootstrap: the image is built before the container is created", () => {
  const fails = [];
  const file = "scripts/bootstrap-init.mjs";
  if (!exists(file)) return [{ file, detail: "missing" }];
  const src = read(file);

  // Comments are stripped before the token search: this file legitimately
  // explains, in prose, the rejected "bootstrap-pending" placeholder tag and
  // the deleted "firstDeploy" step it used to need. Flagging that explanatory
  // history would be a false positive (same convention as stripComments'
  // other callers, e.g. check 6 and check 15).
  const code = stripComments(src);
  if (/bootstrap-pending/.test(code)) {
    fails.push({
      file,
      detail: 'the "bootstrap-pending" placeholder tag is live code again - Scaleway rejects a registryImage tag that has not been pushed yet',
    });
  }
  if (/firstDeploy/.test(code)) {
    fails.push({ file, detail: '"firstDeploy" still appears as live code - it was folded into scwContainer()' });
  }

  // Anchor on the literal `await step(...)` call sites in the MAIN sequence,
  // not on function declaration order, which does not decide run order.
  // "firstBuild" (GitHub Actions dispatch) was renamed to "dockerBuildPush"
  // when the pipeline became direct docker build + push (CONTRACT.md §5).
  const buildAt = src.indexOf('await step("dockerBuildPush"');
  const containerAt = src.indexOf('await step("scwContainer"');
  if (buildAt < 0) fails.push({ file, detail: 'no `await step("dockerBuildPush", ...)` call found' });
  if (containerAt < 0) fails.push({ file, detail: 'no `await step("scwContainer", ...)` call found' });
  if (buildAt >= 0 && containerAt >= 0 && buildAt > containerAt) {
    fails.push({
      file,
      detail: "scwContainer runs before dockerBuildPush - Scaleway validates the registry image at container creation, so the image must be pushed first (CONTRACT.md §1)",
    });
  }

  // Wait-write-wait: a container in a transient state refuses writes (409
  // TransientStateError, CONTRACT.md §1). scwContainer() no longer writes
  // the container's secrets itself (a partial write via setContainerSecrets
  // is destructive - see container.mjs's doc comment); it hands off to
  // syncContainerSecrets(), which owns the full wait-write-wait around the
  // actual PATCH (checked below, against container.mjs). scwContainer()'s
  // own job here is only to wait once before that hand-off, so the sync
  // does not start while the container is still in its creation state.
  // Comments are stripped (using `code`, already computed above) so the
  // header comment naming setContainerSecrets() in prose - explaining
  // exactly this history - is not mistaken for a live call.
  const bodyStart = code.indexOf("async function scwContainer()");
  const bodyEnd = bodyStart >= 0 ? code.indexOf("\nasync function", bodyStart + 1) : -1;
  if (bodyStart < 0) {
    fails.push({ file, detail: "scwContainer() not found" });
  } else {
    const body = code.slice(bodyStart, bodyEnd > 0 ? bodyEnd : undefined);
    const firstWait = body.indexOf("waitForContainerReady(");
    const sync = body.indexOf("syncContainerSecrets(");
    if (sync < 0) {
      fails.push({ file, detail: "scwContainer no longer syncs the container's secrets via syncContainerSecrets()" });
    } else if (firstWait < 0 || firstWait > sync) {
      fails.push({ file, detail: "scwContainer hands off to syncContainerSecrets() without waiting for the container to leave its transient state first (409 TransientStateError, CONTRACT.md §1)" });
    }
  }

  // syncContainerSecrets() (container.mjs) is where the wait-write-wait
  // rhythm actually lives now: a waitForContainerReady call must come
  // BEFORE the setContainerSecrets write, and another one after it (the
  // write triggers a redeploy). Every caller (bootstrap-init.mjs above,
  // deploy.mjs, push-env-vars.mjs, rotate-secret.mjs, dev-credentials.mjs,
  // skills/publish, skills/unpublish) depends on this single definition
  // getting it right.
  const containerFile = "scripts/scaleway/container.mjs";
  if (!exists(containerFile)) {
    fails.push({ file: containerFile, detail: "missing" });
  } else {
    const cSrc = read(containerFile);
    const syncAt = cSrc.indexOf("export async function syncContainerSecrets(");
    if (syncAt < 0) {
      fails.push({ file: containerFile, detail: "syncContainerSecrets is not exported" });
    } else {
      const nextExportAt = cSrc.indexOf("\nexport async function", syncAt + 1);
      const syncBody = cSrc.slice(syncAt, nextExportAt > 0 ? nextExportAt : undefined);
      const firstWait = syncBody.indexOf("waitForContainerReady(");
      const write = syncBody.indexOf("setContainerSecrets(");
      const secondWait = write >= 0 ? syncBody.indexOf("waitForContainerReady(", write) : -1;
      if (write < 0) {
        fails.push({ file: containerFile, detail: "syncContainerSecrets no longer writes the secrets via setContainerSecrets" });
      } else if (firstWait < 0 || firstWait > write) {
        fails.push({ file: containerFile, detail: "syncContainerSecrets writes secrets without waiting for the container to leave its transient state first (409 TransientStateError, CONTRACT.md §1)" });
      } else if (secondWait < 0) {
        fails.push({ file: containerFile, detail: "syncContainerSecrets does not wait for the redeploy its secret write triggers" });
      }
    }
  }
  return fails;
});

define("22", "Image build: the pnpm approvals travel with the lockfile", () => {
  const fails = [];
  const file = "templates/deploy/Dockerfile";
  if (!exists(file)) return [{ file, detail: "missing" }];
  const src = read(file);
  // Order-agnostic: both names must appear on the same COPY line, in either order.
  const RE = /^COPY(?=[^\n]*\bpnpm-lock\.yaml\b)(?=[^\n]*\bpnpm-workspace\.yaml\b)[^\n]*$/m;
  if (!RE.test(src)) {
    fails.push({
      file,
      detail: "no COPY line carries both pnpm-lock.yaml and pnpm-workspace.yaml - pnpm 11 reads allowBuilds: from pnpm-workspace.yaml and fails the install without it (ERR_PNPM_IGNORED_BUILDS)",
    });
  }
  return fails;
});

define("23", "copy-assets.js survives checkJs", () => {
  const fails = [];
  const file = "templates/deploy/copy-assets.js";
  if (!exists(file)) return [{ file, detail: "missing" }];
  const src = read(file);
  if (!src.includes("@param {string} src")) fails.push({ file, detail: 'missing JSDoc "@param {string} src" on copy()' });
  if (!src.includes("@param {string} dest")) fails.push({ file, detail: 'missing JSDoc "@param {string} dest" on copy()' });
  if (/\{any\}/.test(src)) fails.push({ file, detail: "uses {any} in a JSDoc type - name the real type instead" });
  if (/@ts-nocheck/.test(src)) fails.push({ file, detail: "suppresses checkJs with @ts-nocheck instead of typing the function" });
  if (/@ts-ignore/.test(src)) fails.push({ file, detail: "suppresses checkJs with @ts-ignore instead of typing the function" });
  // create-t3-app sets "type": "module", so a bare `node copy-assets.js` in
  // the Docker builder stage treats the file as ESM and `require` throws
  // (verified on a live build).
  if (/\brequire\s*\(/.test(stripComments(src))) {
    fails.push({ file, detail: "uses require() - the generated app is an ES module, use import (verified on a live build)" });
  }
  return fails;
});

define("24", "Toolchain: no gh auth login survives - git ls-remote is the repo-access gate", () => {
  const fails = [];

  // `gh` is dropped from the toolchain entirely (CONTRACT.md §7): repo access
  // is native git auth, gated on `git ls-remote origin`, never a `gh`-based
  // login. This check used to require the login carry the workflow scope;
  // now the login itself must not exist anywhere - not even scoped.
  // tools/verify.mjs is excluded: it necessarily contains the literal below,
  // as this very check's own string to search for. CHANGELOG.md is excluded:
  // it is history, describing a login flow that existed at the time.
  for (const f of FILES) {
    if (f === "tools/verify.mjs" || f === "CHANGELOG.md") continue;
    let src;
    try {
      src = read(f);
    } catch {
      continue;
    }
    for (const [i, line] of src.split("\n").entries()) {
      // "never" must sit immediately before THIS occurrence (a short window,
      // matching the "never **" / "never `" markdown shapes actually used) -
      // not merely appear anywhere on the line, or an unrelated "never" earlier
      // in a long line would excuse a real invocation added later on it.
      for (const m of line.matchAll(/gh auth login/g)) {
        const before = line.slice(Math.max(0, m.index - 20), m.index);
        if (!/\bnever\b/i.test(before)) {
          fails.push({ file: f, detail: `line ${i + 1}: "gh auth login" survives - gh is not part of the toolchain (CONTRACT.md §7)` });
        }
      }
    }
  }

  // The skill-level copy of this gate is gone with /start: the platform hands
  // the session an already-cloned repo, so bootstrap-init.mjs's own gate below
  // is the one that decides whether the harness can reach the remote.
  const bootstrap = "scripts/bootstrap-init.mjs";
  if (!exists(bootstrap)) {
    fails.push({ file: bootstrap, detail: "missing" });
  } else if (!read(bootstrap).includes("git ls-remote origin")) {
    fails.push({ file: bootstrap, detail: 'preflight() never runs "git ls-remote origin" - the repo-access gate is missing' });
  }

  // The dedicated-window installers and the native-OS-only helper scripts
  // used to run `gh auth login` as a real command, or exist only to support
  // the native-OS install paths; they are deleted outright, not merely
  // rewritten (web-only decision).
  for (const f of [
    "scripts/setup-clis-windows.ps1",
    "scripts/setup-clis-mac.sh",
    "scripts/setup-clis-linux.sh",
    "scripts/_ensure-tools-path.sh",
    "scripts/_ensure-tools-path.mjs",
    "scripts/ensure-pnpm-globalbin.mjs",
    "scripts/setup-gitleaks-global.mjs",
    "scripts/update-global-claude-md.mjs",
  ]) {
    if (exists(f)) fails.push({ file: f, detail: "still exists - deleted with the native-OS install paths (web-only decision)" });
  }

  return fails;
});

define("25", "Scaleway config: no code writes a scw config file at all", () => {
  const fails = [];

  // Credentials are env-only now (CONTRACT.md §2): the harness never writes
  // ~/.config/scw (or any scw CLI config file) itself. This check used to pin
  // the direct-0600-write helper as the safe way to do that write;
  // scripts/_persist-scw-credentials.mjs - the file it pinned - is deleted
  // outright, not merely hidden behind a mode flag, so the new invariant is
  // that NO code performs this write at all, by any means.
  if (exists("scripts/_persist-scw-credentials.mjs")) {
    fails.push({
      file: "scripts/_persist-scw-credentials.mjs",
      detail: "still exists - credentials are env-only now (CONTRACT.md §2), nothing may write a scw config file",
    });
  }

  for (const f of MJS) {
    if (f === "tools/verify.mjs") continue;
    const code = stripComments(read(f));
    if (/\bscw\s+config\s+set\b/.test(code)) {
      fails.push({ file: f, detail: 'invokes "scw config set" - the scw CLI has no login/config step in the env-only model' });
    }
    if (/\bupsertScwConfigFields\b|\bpersistScwConfig\b/.test(code)) {
      fails.push({ file: f, detail: "references the deleted scw-config-write helper (upsertScwConfigFields/persistScwConfig)" });
    }
  }

  return fails;
});

define("26", "Name collision: the unavailable note does not blame env vars only", () => {
  const fails = [];
  const file = "scripts/check-name-collision.mjs";
  if (!exists(file)) return [{ file, detail: "missing" }];
  const src = read(file);
  if (src.includes("SCW_ACCESS_KEY/SCW_SECRET_KEY")) {
    fails.push({
      file,
      detail: 'still contains the misleading "SCW_ACCESS_KEY/SCW_SECRET_KEY" fragment - loadCredentials() also reads the repo-local file and the scw config file, not only env vars',
    });
  }
  if (!/\bloadCredentials\b/.test(src)) {
    fails.push({ file, detail: "does not reference loadCredentials - the shared credential resolver routing may have regressed" });
  }
  return fails;
});

define("27", "Jobs: definitions carry local storage and idempotent secrets", () => {
  const fails = [];
  const file = "scripts/scaleway/jobs.mjs";
  if (!exists(file)) return [{ file, detail: "missing" }];
  const src = read(file);

  const fnAt = src.indexOf("export async function ensureJobDefinition");
  if (fnAt < 0) return [{ file, detail: "ensureJobDefinition is not exported" }];
  const nextFnAt = src.indexOf("\nexport async function", fnAt + 1);
  const body = src.slice(fnAt, nextFnAt > 0 ? nextFnAt : undefined);

  // (a) Scaleway rejects local_storage_capacity <= 0. Anchor on each SDK
  // call's own argument block, not "appears twice anywhere in the file", so
  // fixing only one of create/update still fails this check.
  for (const call of ["updateJobDefinition", "createJobDefinition"]) {
    const at = body.indexOf(`jobs.${call}({`);
    if (at < 0) {
      fails.push({ file, detail: `no jobs.${call}(...) call found` });
      continue;
    }
    const argBlock = body.slice(at, body.indexOf("})", at));
    if (!/localStorageCapacity/.test(argBlock)) {
      fails.push({ file, detail: `${call} call does not pass localStorageCapacity - Scaleway rejects local_storage_capacity <= 0` });
    }
  }

  // (b) a second deploy 409s ("secret path or env_var_name is duplicated")
  // unless existing Job secrets are cleared first. indexOf ordering: both
  // listSecrets and deleteSecret must precede createSecrets.
  const listAt = body.indexOf("jobs.listSecrets(");
  const deleteAt = body.indexOf("jobs.deleteSecret(");
  const createSecretsAt = body.indexOf("jobs.createSecrets(");
  if (listAt < 0) fails.push({ file, detail: "ensureJobDefinition never calls jobs.listSecrets - a second deploy will 409 on duplicated secrets" });
  if (deleteAt < 0) fails.push({ file, detail: "ensureJobDefinition never calls jobs.deleteSecret - a second deploy will 409 on duplicated secrets" });
  if (createSecretsAt < 0) fails.push({ file, detail: "ensureJobDefinition never calls jobs.createSecrets" });
  if (listAt >= 0 && createSecretsAt >= 0 && listAt > createSecretsAt) {
    fails.push({ file, detail: "jobs.listSecrets runs AFTER jobs.createSecrets - existing secrets must be listed before new ones are created" });
  }
  if (deleteAt >= 0 && createSecretsAt >= 0 && deleteAt > createSecretsAt) {
    fails.push({ file, detail: "jobs.deleteSecret runs AFTER jobs.createSecrets - existing secrets must be deleted before new ones are created" });
  }
  return fails;
});

define("28", "Migrations: the runner ships in the image and runs only in the Job", () => {
  const fails = [];

  // (a) the runner reproduces drizzle-orm's own migration bookkeeping and
  // safely no-ops on a brand-new project with an empty journal (CONTRACT.md §5).
  const runner = "templates/deploy/migrate.mjs";
  if (!exists(runner)) {
    fails.push({ file: runner, detail: "missing - the migration Job has nothing to run inside the app image" });
  } else {
    const src = read(runner);
    for (const literal of ["__drizzle_migrations", "statement-breakpoint", "_journal.json"]) {
      if (!src.includes(literal)) fails.push({ file: runner, detail: `missing literal "${literal}"` });
    }
  }

  // (b)/(c) the runner + its migrations directory must ship in the runner
  // stage, or the Job's `node migrate.mjs` fails with MODULE_NOT_FOUND - but
  // the container's own CMD/ENTRYPOINT must never reference it (CONTRACT.md
  // §1): migrations run exactly once, in the /deploy Job, never at container
  // start or on a scale-up.
  const dockerfile = "templates/deploy/Dockerfile";
  if (!exists(dockerfile)) {
    fails.push({ file: dockerfile, detail: "missing" });
  } else {
    const dSrc = read(dockerfile);
    if (!/^COPY[^\n]*\bmigrate\.mjs\b/m.test(dSrc)) {
      fails.push({ file: dockerfile, detail: "no COPY line ships migrate.mjs into the runner stage" });
    }
    if (!/^COPY[^\n]*\bdrizzle\b/m.test(dSrc)) {
      fails.push({ file: dockerfile, detail: "no COPY line ships drizzle/ into the runner stage" });
    }
    const cmdLine = dSrc.match(/^(?:CMD|ENTRYPOINT)\s*\[[^\]]*\]/m);
    if (cmdLine && /migrate\.mjs/.test(cmdLine[0])) {
      fails.push({
        file: dockerfile,
        detail: "CMD/ENTRYPOINT references migrate.mjs - migrations must run only in the /deploy Serverless Job, never at container start",
      });
    }
  }

  // (d) the Job's command must be the in-image runner, not the devDependency
  // drizzle-kit binary the production image does not carry (CONTRACT.md §1) -
  // comment-stripped, since the file legitimately explains the old breakage
  // in prose.
  const deployFile = "scripts/deploy.mjs";
  if (!exists(deployFile)) {
    fails.push({ file: deployFile, detail: "missing" });
  } else {
    const code = stripComments(read(deployFile));
    if (code.includes('"drizzle-kit migrate"')) {
      fails.push({
        file: deployFile,
        detail: 'still runs the Job with command "drizzle-kit migrate" - not in the production image, fails at container start',
      });
    }
    if (!code.includes("node migrate.mjs")) {
      fails.push({ file: deployFile, detail: 'does not run the migration Job with command "node migrate.mjs"' });
    }
  }

  // (e)/(f) bootstrap-init.mjs must render the runner and guarantee the
  // journal file into every new project, strip T3's tablesFilter (each app
  // has its own database, CONTRACT.md §4), and ship the pnpm 11 transitive-
  // advisory fix as pnpm-workspace.yaml overrides.
  const bootstrap = "scripts/bootstrap-init.mjs";
  if (!exists(bootstrap)) {
    fails.push({ file: bootstrap, detail: "missing" });
  } else {
    const bSrc = read(bootstrap);
    if (!bSrc.includes("deploy/migrate.mjs")) {
      fails.push({ file: bootstrap, detail: 'does not render "deploy/migrate.mjs" into new projects' });
    }
    if (!bSrc.includes("_journal.json")) {
      fails.push({ file: bootstrap, detail: "does not guarantee drizzle/meta/_journal.json exists - the Dockerfile's COPY drizzle/ would fail on a fresh project" });
    }
    if (!bSrc.includes("tablesFilter")) {
      fails.push({ file: bootstrap, detail: "no longer strips tablesFilter from the generated drizzle.config.ts" });
    }
    if (!bSrc.includes("overrides:") || !bSrc.includes(">=8.5.18")) {
      fails.push({ file: bootstrap, detail: "no longer ships the postcss/sharp overrides: block in pnpm-workspace.yaml" });
    }
  }

  // (g) the audit step must point at the same fix, not the pnpm 11-broken
  // `pnpm update` path for a transitive advisory.
  const bootstrapSkill = "skills/bootstrap/SKILL.md";
  if (!exists(bootstrapSkill)) {
    fails.push({ file: bootstrapSkill, detail: "missing" });
  } else if (!read(bootstrapSkill).includes("pnpm-workspace.yaml")) {
    fails.push({ file: bootstrapSkill, detail: "audit step no longer mentions fixing transitive advisories via pnpm-workspace.yaml overrides" });
  }

  // (7) the stale "update-privacy-policy has no catalog entry" note must not
  // survive in either skill that calls it - CATALOG carries both keys.
  for (const f of ["skills/add-db/SKILL.md", "skills/add-storage/SKILL.md"]) {
    if (exists(f) && /will fail until the catalog/.test(read(f))) {
      fails.push({ file: f, detail: "still claims update-privacy-policy.mjs's CATALOG lacks this provider's entry - it does not" });
    }
  }

  return fails;
});

define("29", "Container secrets: writes are full-map, reads are hashes", () => {
  const fails = [];

  // (a) container.mjs must ship the argon2 drop and the three exported
  // building blocks of the full-map-write architecture. The "$argon2" anchor
  // is checked against mergedSecrets()'s own body (comment-stripped), not
  // the whole file: the header comment quotes a live-verified example hash
  // ("$argon2id$v=19$...") to document the API's behaviour, and a bare
  // file-wide substring search would still pass with that comment alone
  // even if the actual drop in mergedSecrets() were deleted.
  const containerFile = "scripts/scaleway/container.mjs";
  if (!exists(containerFile)) {
    fails.push({ file: containerFile, detail: "missing" });
  } else {
    const src = read(containerFile);
    const mergedAt = src.indexOf("export async function mergedSecrets(");
    const mergedEnd = mergedAt >= 0 ? src.indexOf("\nexport ", mergedAt + 1) : -1;
    if (mergedAt < 0) {
      fails.push({ file: containerFile, detail: "mergedSecrets is not exported" });
    } else {
      const mergedBody = stripComments(src.slice(mergedAt, mergedEnd > 0 ? mergedEnd : undefined));
      if (!mergedBody.includes("$argon2")) {
        fails.push({
          file: containerFile,
          detail: 'mergedSecrets() no longer drops "$argon2"-prefixed values - a read-back hash could be written back as if it were a real secret',
        });
      }
    }
    for (const token of ["CONTAINER_EXCLUDED_SECRETS", "syncContainerSecrets", "buildContainerSecretMap"]) {
      if (!src.includes(token)) fails.push({ file: containerFile, detail: `does not define/export ${token}` });
    }
  }

  // (b) THE BAN: setContainerSecrets() is destructive on a partial map (see
  // its own doc comment) - only syncContainerSecrets(), which always builds
  // the COMPLETE map from Secret Manager first, may call it. Comments are
  // stripped for .mjs sources, same convention as check 11(c): a file may
  // legitimately name the function in prose to explain that it does not
  // call it.
  for (const f of MJS) {
    if (f === containerFile) continue;
    if (!f.startsWith("scripts/") && !f.startsWith("skills/")) continue;
    const code = stripComments(read(f));
    if (/\bsetContainerSecrets\s*\(/.test(code)) {
      fails.push({ file: f, detail: "calls setContainerSecrets() directly - a partial write deletes every key it omits; go through syncContainerSecrets() instead" });
    }
  }
  for (const f of SKILL_MDS) {
    if (read(f).includes("setContainerSecrets(")) {
      fails.push({ file: f, detail: "calls setContainerSecrets() directly - a partial write deletes every key it omits; go through syncContainerSecrets() instead" });
    }
  }

  // (c) no skill may read secret_environment_variables as if it were
  // plaintext. A GET only ever returns an argon2 hash (container.mjs's
  // header comment) - the old gsc/eco-audit/seo-perf pattern found the
  // ACCESS_RESTRICTED entry and read its .value straight off the container,
  // which is always a hash and so always compares false. Anchor on the
  // shape of that bug (a same-line .find(...) or .value comparison after
  // the field name), not the bare field name, which also appears in
  // legitimate prose describing the write-only channel (e.g.
  // skills/bootstrap/SKILL.md, skills/rotate-secret/SKILL.md).
  const BAD_SECRET_READ_RE = /secret_environment_variables[^\n]*\.find\(|secret_environment_variables[^\n]*\.value\s*===/;
  for (const f of SKILL_MDS) {
    read(f)
      .split("\n")
      .forEach((line, i) => {
        if (BAD_SECRET_READ_RE.test(line)) {
          fails.push({
            file: f,
            detail: `line ${i + 1}: reads secret_environment_variables as if it were plaintext - a GET only ever returns an argon2 hash, read the value from Secret Manager instead`,
          });
        }
      });
  }

  // (d) /publish and /unpublish are the canonical flip: they must go
  // through both syncContainerSecrets (the container write) and putSecret
  // (making the value canonical in Secret Manager, for production).
  for (const f of ["skills/publish/SKILL.md", "skills/unpublish/SKILL.md"]) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "missing" });
      continue;
    }
    const src = read(f);
    if (!src.includes("syncContainerSecrets")) fails.push({ file: f, detail: "does not reference syncContainerSecrets" });
    if (!src.includes("putSecret")) fails.push({ file: f, detail: "does not reference putSecret - ACCESS_RESTRICTED must become canonical in Secret Manager, not just written to the container" });
  }

  // (e) preview fail-closed: a preview sync must always override
  // ACCESS_RESTRICTED to "true", never inherit production's value from
  // Secret Manager (CONTRACT.md §2).
  for (const f of ["scripts/deploy.mjs", "scripts/push-env-vars.mjs", "scripts/rotate-secret.mjs"]) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "missing" });
      continue;
    }
    if (!read(f).includes('ACCESS_RESTRICTED: "true"')) {
      fails.push({
        file: f,
        detail: 'does not force ACCESS_RESTRICTED: "true" on a preview sync - a preview container must fail closed regardless of production\'s value',
      });
    }
  }

  return fails;
});

define("30", "IP gate diagnosability", () => {
  const fails = [];

  const mw = "templates/deploy/proxy.ts";
  if (!exists(mw)) {
    fails.push({ file: mw, detail: "access middleware is missing" });
  } else if (!read(mw).includes("x-baudrier-client-ip")) {
    fails.push({
      file: mw,
      detail: 'does not send an "x-baudrier-client-ip" header on a 403 - a locked-out operator has no way to see which address the gate rejected',
    });
  }

  const bootstrap = "scripts/bootstrap-init.mjs";
  if (!exists(bootstrap)) return [...fails, { file: bootstrap, detail: "missing" }];
  const src = read(bootstrap);

  // smokeTest must read the header the middleware sends, or a 403 during
  // onboarding gets no explanation of which address the gate saw.
  const smokeAt = src.indexOf("async function smokeTest()");
  const smokeEnd = smokeAt >= 0 ? src.indexOf("\nasync function", smokeAt + 1) : -1;
  if (smokeAt < 0) {
    fails.push({ file: bootstrap, detail: "smokeTest() not found" });
  } else if (!src.slice(smokeAt, smokeEnd > 0 ? smokeEnd : undefined).includes("x-baudrier-client-ip")) {
    fails.push({
      file: bootstrap,
      detail: "smokeTest() does not read the x-baudrier-client-ip header - a 403 during onboarding gets no explanation of which address the gate saw",
    });
  }

  // detectEgressIps' caller (scwContainer) must warn when only one address
  // family was detected - an operator machine commonly egresses both IPv4
  // and IPv6, and a client that prefers the undetected family would
  // otherwise get a silent 403 with no clue why.
  const containerAt = src.indexOf("async function scwContainer()");
  const containerEnd = containerAt >= 0 ? src.indexOf("\nasync function", containerAt + 1) : -1;
  if (containerAt < 0) {
    fails.push({ file: bootstrap, detail: "scwContainer() not found" });
  } else if (!/was detected for this machine, so ACCESS_ALLOWED_IPS only allows/.test(src.slice(containerAt, containerEnd > 0 ? containerEnd : undefined))) {
    fails.push({
      file: bootstrap,
      detail: "scwContainer() no longer warns when only one address family was detected - a client on the other family would get a silent 403",
    });
  }

  // ACCESS_ALLOWED_IPS is production's own access list, projected into every
  // container from ONE Secret Manager entry (CONTRACT.md §6). Anything that
  // writes it - a putSecret, or an `ACCESS_ALLOWED_IPS:` key in a
  // syncContainerSecrets `overrides` object - changes who can reach
  // PRODUCTION. A preview or per-branch flow that adds a reviewer's address
  // grants that address production access the moment the gate is restored by
  // /unpublish, silently. bootstrap-init.mjs seeds it once, at project
  // creation, and is the only legitimate writer.
  const WRITE_PATTERNS = [/putSecret\s*\(\s*["'`]ACCESS_ALLOWED_IPS/, /ACCESS_ALLOWED_IPS\s*:/];
  const skillFiles = FILES.filter((f) => f.endsWith("SKILL.md"));
  for (const f of [...MJS, ...skillFiles]) {
    if (f === bootstrap) continue;
    // Comments are stripped from code: several files name this secret in prose
    // precisely to explain that they must not write it.
    const body = f.endsWith(".mjs") ? stripComments(read(f)) : read(f);
    for (const line of body.split(/\r?\n/)) {
      if (WRITE_PATTERNS.some((re) => re.test(line))) {
        fails.push({
          file: f,
          detail: "writes ACCESS_ALLOWED_IPS - that secret is production's access list, and only bootstrap-init.mjs may seed it (CONTRACT.md §6)",
        });
        break;
      }
    }
  }

  return fails;
});

define("31", "Builds direct: no dispatch workflow, one pipeline call in each caller", () => {
  const fails = [];

  // (a) the GitHub Actions build-dispatch workflow is deleted outright, not
  // reworked (CONTRACT.md §5): the machine running the harness builds and
  // pushes the image itself now, so there is nothing left to dispatch.
  const wf = "templates/deploy/build.yml";
  if (exists(wf)) {
    fails.push({ file: wf, detail: "still exists - the direct build pipeline (CONTRACT.md §5) replaced it, no GitHub Actions workflow scaffolds into new projects" });
  }

  // (b) both callers must call the one shared direct-build helper, and
  // neither may dispatch a GitHub Actions workflow to do it instead.
  for (const [f, fnName] of [
    ["scripts/bootstrap-init.mjs", "dockerBuildPush"],
    ["scripts/deploy.mjs", "buildPush"],
  ]) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "missing" });
      continue;
    }
    const src = read(f);
    const fnAt = src.indexOf(`async function ${fnName}(`);
    if (fnAt < 0) {
      fails.push({ file: f, detail: `${fnName}() not found` });
      continue;
    }
    const nextFnAt = src.indexOf("\nasync function", fnAt + 1);
    const body = src.slice(fnAt, nextFnAt > 0 ? nextFnAt : undefined);
    if (!/\bbuildAndPushImage\s*\(/.test(body)) {
      fails.push({ file: f, detail: `${fnName}() does not call buildAndPushImage() - the direct build/push pipeline may have regressed` });
    }
    const code = stripComments(body);
    if (/gh\s+workflow\s+run|workflow_dispatch/.test(code)) {
      fails.push({ file: f, detail: `${fnName}() still dispatches a GitHub Actions workflow - CONTRACT.md §5 removed Actions from the pipeline entirely` });
    }
  }

  // (c) Turbopack panics live in this environment, and not only under
  // `pnpm dev`: `next build` panics too, so a dev-only strip is not enough.
  // The fix rewrites every script with a webpack flag instead.
  const bootstrap = "scripts/bootstrap-init.mjs";
  if (exists(bootstrap)) {
    const code = stripComments(read(bootstrap));
    if (code.includes("pkg.scripts.dev = pkg.scripts.dev.replace(")) {
      fails.push({ file: bootstrap, detail: "still strips --turbo from pkg.scripts.dev only - Turbopack also panics at `next build`; the dev-only strip is not enough" });
    }
    if (!code.includes("next $1 --webpack")) {
      fails.push({ file: bootstrap, detail: 'no scripts-wide webpack rewrite found (expected the replacement string "next $1 --webpack")' });
    }
  }

  return fails;
});

define("32", "Local-first loop: dev bypass, tryDb, deploy policy", () => {
  const fails = [];

  // (a) the IP gate must not block a local `pnpm dev`: there is no
  // X-Forwarded-For locally, and ACCESS_ALLOWED_IPS is a deployment secret,
  // not something a local .env carries.
  const mw = "templates/deploy/proxy.ts";
  if (!exists(mw)) {
    fails.push({ file: mw, detail: "missing" });
  } else {
    const src = read(mw);
    const at = src.indexOf('process.env.NODE_ENV === "development"');
    if (at < 0) {
      fails.push({ file: mw, detail: 'no NODE_ENV === "development" bypass - local `pnpm dev` would 403 on every request behind the IP gate' });
    } else if (!src.slice(at, at + 200).includes("NextResponse.next()")) {
      fails.push({ file: mw, detail: 'NODE_ENV === "development" check does not return NextResponse.next() nearby' });
    }
  }

  // (b) the DB-outage degradation story: tryDb() must exist and every new
  // project must get it wired in.
  const safeTs = "templates/db/safe.ts";
  if (!exists(safeTs)) {
    fails.push({ file: safeTs, detail: "missing - the DB-outage degradation helper was not shipped" });
  } else if (!/export\s+async\s+function\s+tryDb\b/.test(read(safeTs))) {
    fails.push({ file: safeTs, detail: "does not export tryDb" });
  }
  const setupDb = "scripts/setup-db.mjs";
  if (!exists(setupDb)) {
    fails.push({ file: setupDb, detail: "missing" });
  } else if (!read(setupDb).includes("db/safe.ts")) {
    fails.push({ file: setupDb, detail: "does not reference db/safe.ts - swapDriver() may no longer render it into new projects" });
  }

  // (c) the generated CLAUDE.md must teach the local-first loop and name
  // tryDb by name, or a fresh session has no way to learn either.
  const claudeMdCore = "templates/bootstrap/claude-md-core.md";
  if (!exists(claudeMdCore)) {
    fails.push({ file: claudeMdCore, detail: "missing" });
  } else {
    const src = read(claudeMdCore);
    if (!src.includes("Boucle de développement")) {
      fails.push({ file: claudeMdCore, detail: 'missing the "Boucle de développement" section' });
    }
    if (!src.includes("tryDb")) {
      fails.push({ file: claudeMdCore, detail: "does not mention tryDb" });
    }
  }

  // (d) /deploy must read the canonical ACCESS_RESTRICTED value before
  // steering, and a published app must never walk straight into a
  // production deploy without an explicit, risk-named confirmation - the
  // private-preview-or-production menu below is that confirmation.
  const deploySkill = "skills/deploy/SKILL.md";
  if (!exists(deploySkill)) {
    fails.push({ file: deploySkill, detail: "missing" });
  } else {
    const src = read(deploySkill);
    if (!/getSecret/.test(src) || !/ACCESS_RESTRICTED/.test(src)) {
      fails.push({ file: deploySkill, detail: "does not read ACCESS_RESTRICTED via getSecret - the published-app steer cannot tell whether the app is already public" });
    }
    if (!src.includes("aperçu privé")) {
      fails.push({ file: deploySkill, detail: 'missing the private-preview wording ("aperçu privé") - a published app must be offered a private preview, not walked straight into production' });
    }
    // The menu is the product decision: a published app (or a non-main
    // branch) is offered private preview alongside production, never
    // production alone. Anchored on the option-LIST lines, not on a bare
    // substring: other headings below quote the same labels, so a looser
    // match stays green even when the question itself has lost an option.
    for (const label of ["Non, un aperçu privé d’abord", "Oui, déploie en production"]) {
      if (!new RegExp(`^\\s*-\\s*\`${label}\``, "m").test(src)) {
        fails.push({ file: deploySkill, detail: `no longer offers "${label}" as an option` });
      }
    }
  }

  return fails;
});

define("33", "Workflow: fail-fast project, background deploy, honest docs", () => {
  const fails = [];

  // (a) scwProject must run right after preflight, before scaffoldT3 writes a
  // single local file. Anchored on the literal `await step(...)` call sites in
  // the MAIN sequence (same convention as check 21), not on function
  // declaration order, which does not decide run order. What this prevents,
  // live: a ProjectManager 403 used to strike only after create-t3-app + pnpm
  // install had already spent about five minutes building the local project
  // directory, with no idempotent way to recover short of deleting it and
  // starting over.
  const bootstrap = "scripts/bootstrap-init.mjs";
  if (!exists(bootstrap)) {
    fails.push({ file: bootstrap, detail: "missing" });
  } else {
    const src = read(bootstrap);
    const preflightAt = src.indexOf('await step("preflight"');
    const scwProjectAt = src.indexOf('await step("scwProject"');
    const scaffoldAt = src.indexOf('await step("scaffoldT3"');
    if (preflightAt < 0) fails.push({ file: bootstrap, detail: 'no `await step("preflight", ...)` call found' });
    if (scwProjectAt < 0) fails.push({ file: bootstrap, detail: 'no `await step("scwProject", ...)` call found' });
    if (scaffoldAt < 0) fails.push({ file: bootstrap, detail: 'no `await step("scaffoldT3", ...)` call found' });
    if (preflightAt >= 0 && scwProjectAt >= 0 && scwProjectAt < preflightAt) {
      fails.push({ file: bootstrap, detail: "scwProject runs before preflight - preflight's credential/tooling checks must come first" });
    }
    if (scwProjectAt >= 0 && scaffoldAt >= 0 && scwProjectAt > scaffoldAt) {
      fails.push({
        file: bootstrap,
        detail:
          "scwProject runs after scaffoldT3 - a ProjectManager 403 would then strike only after create-t3-app + pnpm install " +
          "already spent about five minutes building the local project directory, with no idempotent way to recover short of " +
          "deleting it and starting over",
      });
    }
  }

  // (b) the deploy skill must describe the background-Bash + LOG_FILE +
  // Monitor pattern, anchored on deploy.mjs's own final JSON line, and must
  // not carry the impossible "stream through live" instruction a synchronous
  // Bash call cannot honor.
  const deploySkill = "skills/deploy/SKILL.md";
  if (!exists(deploySkill)) {
    fails.push({ file: deploySkill, detail: "missing" });
  } else {
    const src = read(deploySkill);
    for (const needle of ["run_in_background", "Monitor", '{"success"']) {
      if (!src.includes(needle)) {
        fails.push({ file: deploySkill, detail: `does not mention "${needle}" - the background-Bash + Monitor execution pattern may have regressed` });
      }
    }
    for (const bad of ["no capture", "stream through live"]) {
      if (src.toLowerCase().includes(bad)) {
        fails.push({ file: deploySkill, detail: `contains the impossible "${bad}" instruction - a synchronous Bash call buffers all output until the command exits, it cannot stream it live` });
      }
    }

    // (c) `drizzle-kit migrate` may appear only right next to an explanation
    // that it CANNOT run in the production image - never as an instruction to
    // actually invoke it as the Job's command. This file writes each step as
    // one long paragraph-line, so a per-line test is too coarse: the
    // legitimate "cannot run inside it" explanation later in the same
    // paragraph would make an unrelated, earlier bad mention look negated
    // too. Require the marker within a tight window of each occurrence
    // instead (empirically: the legitimate mention has "cannot" ~20
    // characters after it; an injected "run the Job with drizzle-kit
    // migrate" instruction sits ~450 characters from the nearest "cannot").
    const NEG_RE = /\bcannot\b|\bcan['’]t\b|ne peut pas/i;
    const WINDOW = 150;
    for (const m of src.matchAll(/drizzle-kit migrate/g)) {
      const start = Math.max(0, m.index - WINDOW);
      const end = Math.min(src.length, m.index + m[0].length + WINDOW);
      if (!NEG_RE.test(src.slice(start, end))) {
        fails.push({
          file: deploySkill,
          detail: `"drizzle-kit migrate" at offset ${m.index} has no nearby negation (cannot/can't/ne peut pas) within ${WINDOW} characters - it must read as an explanation of why the runner exists, not an instruction to run it`,
        });
      }
    }
  }

  // (d) the local placeholder DATABASE_URL rule must state the required
  // literal, not just that no real value exists, in the two technical docs
  // that own the rule; the two prose docs (CLAUDE.md's one-line hard-rules
  // bullet, and the generated project's own CLAUDE.md core, which states the
  // rule in French without repeating the raw connection string) only need to
  // still say "placeholder".
  const PLACEHOLDER = "postgresql://placeholder:placeholder@localhost:5432/placeholder";
  for (const f of ["skills/add-db/SKILL.md", "CONTRACT.md"]) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "missing" });
      continue;
    }
    if (!read(f).includes(PLACEHOLDER)) {
      fails.push({ file: f, detail: `does not carry the placeholder literal "${PLACEHOLDER}" - the rule must state the required value, not just the absence of a real one` });
    }
  }
  for (const f of ["CLAUDE.md", "templates/bootstrap/claude-md-core.md"]) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "missing" });
    } else if (!/placeholder/i.test(read(f))) {
      fails.push({ file: f, detail: "no longer mentions a placeholder DATABASE_URL" });
    }
  }
  if (exists("skills/add-db/SKILL.md") && read("skills/add-db/SKILL.md").includes("There is no `DATABASE_URL` in any local")) {
    fails.push({
      file: "skills/add-db/SKILL.md",
      detail:
        'still contains the old absolute phrase "There is no `DATABASE_URL` in any local" - the rule must instead require ' +
        "the syntactically valid placeholder (env validation and drizzle-kit generate need it), not simply deny any local DATABASE_URL exists",
    });
  }

  return fails;
});

define("34", "Costs: scoped to the app's Project only", () => {
  const fails = [];

  // A live run showed listConsumptions' server-side projectId filter
  // returning Organization-wide rows. The client-side filter is what
  // actually keeps other Projects' spend out of the user's table.
  const billing = "scripts/scaleway/billing.mjs";
  if (!exists(billing)) {
    fails.push({ file: billing, detail: "missing" });
  } else if (!read(billing).includes(".filter((item) => item.projectId === proj)")) {
    fails.push({ file: billing, detail: "no client-side projectId filter - the user would see Organization-wide billing rows again" });
  }

  // /costs must report the APP's Project, not the operator's default one.
  // .scaleway/container.json is deleted from the design (CONTRACT.md §2, §7 -
  // app repos carry no Scaleway metadata at all); the app's Project now
  // resolves by name, through the shared _scw-auth.mjs helper.
  const costs = "scripts/costs.mjs";
  if (!exists(costs)) {
    fails.push({ file: costs, detail: "missing" });
  } else {
    const src = read(costs);
    if (src.includes(".scaleway/container.json")) {
      fails.push({ file: costs, detail: '.scaleway/container.json is deleted from the design (CONTRACT.md §2, §7) - resolve the Project by name instead' });
    }
    if (!/resolveProjectId\s+as\s+resolveScwProjectId/.test(src) && !/from\s+["'`]\.\/scaleway\/_scw-auth\.mjs["'`]/.test(src)) {
      fails.push({ file: costs, detail: "does not resolve the app's Project through _scw-auth.mjs's resolveProjectId (name-based lookup)" });
    }
    if (!src.includes("projectSource")) {
      fails.push({ file: costs, detail: "does not report projectSource - the skill cannot warn on a default-project fallback" });
    }
  }
  if (exists("skills/costs/SKILL.md") && !read("skills/costs/SKILL.md").includes("projectSource")) {
    fails.push({ file: "skills/costs/SKILL.md", detail: "does not handle projectSource - a default-project figure would be presented as the app's costs" });
  }
  return fails;
});

define("35", "Database: 0-5 vCPU autoscaling default, adjustable via /scale", () => {
  const fails = [];
  const sdb = "scripts/scaleway/sdb.mjs";
  if (!exists(sdb)) return [{ file: sdb, detail: "missing" }];
  const sdbSrc = read(sdb);
  // The bound is a cost guard: the API's own cpu_max default is 15, three
  // times what /scale shows the user as the cap.
  if (!/DB_CPU_MAX_DEFAULT\s*=\s*5/.test(sdbSrc)) {
    fails.push({ file: sdb, detail: "DB_CPU_MAX_DEFAULT is not 5 - new databases would autoscale to the API default of 15 vCPU" });
  }
  if (!/maxCpu\s*=\s*DB_CPU_MAX_DEFAULT/.test(sdbSrc)) {
    fails.push({ file: sdb, detail: "ensureDatabase does not default maxCpu to DB_CPU_MAX_DEFAULT" });
  }
  if (!sdbSrc.includes("setDatabaseCpuBounds")) {
    fails.push({ file: sdb, detail: "setDatabaseCpuBounds is gone - /scale cannot change the database bounds" });
  }
  // The CLI's own flag defaults must read the same constants, not a copy of
  // their current numeric value: a numeric literal drifts silently the next
  // time DB_CPU_MIN_DEFAULT/DB_CPU_MAX_DEFAULT change, and `ensure` (run with
  // no flags) would then apply the OLD bound while every other caller already
  // moved to the new one.
  if (!/flag\("min-cpu",\s*DB_CPU_MIN_DEFAULT\)/.test(sdbSrc)) {
    fails.push({ file: sdb, detail: '`ensure`\'s --min-cpu flag does not default to DB_CPU_MIN_DEFAULT - it is a numeric literal instead' });
  }
  if (!/flag\("max-cpu",\s*DB_CPU_MAX_DEFAULT\)/.test(sdbSrc)) {
    fails.push({ file: sdb, detail: '`ensure`\'s --max-cpu flag does not default to DB_CPU_MAX_DEFAULT - it is a numeric literal instead, today 15, the API default this check exists to cap' });
  }
  const scale = "scripts/scale.mjs";
  if (!exists(scale)) {
    fails.push({ file: scale, detail: "missing" });
  } else {
    const src = read(scale);
    for (const needle of ["db-current", "db-apply", "setDatabaseCpuBounds"]) {
      if (!src.includes(needle)) fails.push({ file: scale, detail: `missing "${needle}" - the /scale database path is broken` });
    }
  }
  if (exists("skills/scale/SKILL.md") && !read("skills/scale/SKILL.md").includes("db-apply")) {
    fails.push({ file: "skills/scale/SKILL.md", detail: "never invokes db-apply - the database section is gone" });
  }
  return fails;
});

define("36", "Next 16 baseline: scaffold version overrides", () => {
  const fails = [];
  const file = "scripts/bootstrap-init.mjs";
  if (!exists(file)) return [{ file, detail: "missing" }];
  const code = stripComments(read(file));

  // (a) the version-override map must pin every dependency the Next 16 /
  // node:24 / zod 4 baseline depends on, or a scaffold keeps installing the
  // old versions T3 itself resolves.
  const mapAt = code.indexOf("const NEXT16_VERSIONS");
  if (mapAt < 0) {
    fails.push({ file, detail: "no NEXT16_VERSIONS map - the Next 16 / zod 4 / node 24 versions are not pinned anywhere" });
  } else {
    const closeAt = code.indexOf("};", mapAt);
    const block = code.slice(mapAt, closeAt >= 0 ? closeAt + 2 : undefined);
    const PAIRS = [
      /next:\s*"\^16\.0\.0"/,
      /zod:\s*"\^4\.0\.0"/,
      /"@t3-oss\/env-nextjs":\s*"\^0\.13\.0"/,
      /"@types\/node":\s*"\^24\.0\.0"/,
      /typescript:\s*"\^5\.9\.0"/,
      /eslint:\s*"\^9\.0\.0"/,
      /"eslint-config-next":\s*"\^16\.0\.0"/,
    ];
    for (const re of PAIRS) {
      if (!re.test(block)) fails.push({ file, detail: `NEXT16_VERSIONS is missing a pinned version matching ${re.source}` });
    }
  }

  // (b) the override must apply before `pnpm install` runs, or the install
  // resolves the pre-pin versions and the override never takes effect.
  const scaffoldAt = code.indexOf("function scaffoldT3()");
  if (scaffoldAt < 0) {
    fails.push({ file, detail: "scaffoldT3() not found" });
  } else {
    const nextFnAt = code.indexOf("\nfunction ", scaffoldAt + 1);
    const body = code.slice(scaffoldAt, nextFnAt > 0 ? nextFnAt : undefined);
    const overrideAt = body.indexOf("applyNext16VersionOverrides(");
    const installAt = body.indexOf("pnpm install");
    if (overrideAt < 0) fails.push({ file, detail: "scaffoldT3() never calls applyNext16VersionOverrides()" });
    if (installAt < 0) fails.push({ file, detail: 'scaffoldT3() no longer runs "pnpm install"' });
    if (overrideAt >= 0 && installAt >= 0 && overrideAt > installAt) {
      fails.push({ file, detail: "applyNext16VersionOverrides() runs AFTER pnpm install - the override has no effect on the versions actually installed" });
    }
  }

  // (c) the unversioned eslintCli() fallback installs whatever eslint major
  // is latest today (10), not the pinned Next 16 baseline (9). Raw source,
  // not `code`: eslintCli() writes a literal "node_modules/**" glob string,
  // which stripComments' block-comment alternative misreads as an opening
  // /*, then swallows everything up to the next real */ it finds - a JSDoc
  // comment further down the file, past this function's real body.
  const raw = read(file);
  const eslintAt = raw.indexOf("function eslintCli(");
  if (eslintAt < 0) {
    fails.push({ file, detail: "eslintCli() not found" });
  } else {
    const nextFnAt = raw.indexOf("\nfunction ", eslintAt + 1);
    const body = raw.slice(eslintAt, nextFnAt > 0 ? nextFnAt : undefined);
    if (body.includes('pnpm add -D ${missing.join(" ")}')) {
      fails.push({ file, detail: 'eslintCli() still falls back to the unversioned `pnpm add -D ${missing.join(" ")}` - installs eslint 10 today' });
    }
  }

  return fails;
});

define("37", "Next 16 traps: client-bundle leak, proxy rename", () => {
  const fails = [];

  // (a) `import { type AppRouter }` still imports the value binding at
  // runtime - only `import type` is erased by the compiler. Left as a value
  // import, the server router (and its Node-only imports) leaks into the
  // client bundle through src/trpc/react.tsx. Raw source, not stripComments:
  // cleanupDemo() writes the schema.ts placeholder as a series of `"//` ...
  // string literals - the intended file content is a comment, but as text
  // IN THIS FILE it is a string, and stripComments' line-comment alternative
  // cannot tell the two apart.
  const bootstrap = "scripts/bootstrap-init.mjs";
  if (!exists(bootstrap)) {
    fails.push({ file: bootstrap, detail: "missing" });
  } else {
    const raw = read(bootstrap);
    const at = raw.indexOf("function cleanupDemo()");
    if (at < 0) {
      fails.push({ file: bootstrap, detail: "cleanupDemo() not found" });
    } else {
      const nextFnAt = raw.indexOf("\nfunction ", at + 1);
      const body = raw.slice(at, nextFnAt > 0 ? nextFnAt : undefined);
      if (!body.includes("src/trpc/react.tsx")) {
        fails.push({ file: bootstrap, detail: "cleanupDemo() no longer patches src/trpc/react.tsx" });
      }
      if (!body.includes('import { type AppRouter } from "~/server/api/root";')) {
        fails.push({ file: bootstrap, detail: "cleanupDemo() no longer looks for the old AppRouter value-import to replace" });
      }
      if (!body.includes('import type { AppRouter } from "~/server/api/root";')) {
        fails.push({ file: bootstrap, detail: "cleanupDemo() does not write the type-only AppRouter import" });
      }
      if (!body.includes("warn(")) {
        fails.push({ file: bootstrap, detail: "cleanupDemo() has no warn() tolerance branch for when the trpc/react.tsx patch does not apply" });
      }
    }
  }

  // (b) Next 16 renamed middleware.ts to proxy.ts.
  const proxy = "templates/deploy/proxy.ts";
  if (!exists(proxy)) {
    fails.push({ file: proxy, detail: "missing - Next 16 requires proxy.ts, not middleware.ts" });
  } else if (!/export function proxy\(/.test(read(proxy))) {
    fails.push({ file: proxy, detail: "does not export a proxy() function" });
  }
  if (exists("templates/deploy/middleware.ts")) {
    fails.push({ file: "templates/deploy/middleware.ts", detail: "old middleware.ts still ships alongside proxy.ts - Next 16 uses proxy.ts only" });
  }

  // (c) reintroduction guard: nothing may write src/middleware.ts into a new
  // project again. Comments are stripped, same convention as check 15's
  // reintroduction guard.
  for (const f of MJS.filter((m) => m.startsWith("scripts/"))) {
    const code = stripComments(read(f));
    if (code.includes("src/middleware.ts")) {
      fails.push({ file: f, detail: 'references "src/middleware.ts" - Next 16 renamed it to src/proxy.ts' });
    }
  }

  // (d) eslint-config-next 16 ships native flat configs; the scaffolded
  // FlatCompat route crashes eslint 9 with "Converting circular structure to
  // JSON" - verified on a local scaffold. eslintCli() must rewire the config
  // to the native import. Raw source for the same reason as (a).
  if (exists(bootstrap)) {
    const raw = read(bootstrap);
    if (!raw.includes("patchFlatCompatToNative(")) {
      fails.push({ file: bootstrap, detail: "no patchFlatCompatToNative() - the scaffolded FlatCompat eslint config crashes eslint 9 with eslint-config-next 16" });
    }
    if (!raw.includes("eslint-config-next/core-web-vitals")) {
      fails.push({ file: bootstrap, detail: 'never imports "eslint-config-next/core-web-vitals" - the native flat config replaces the FlatCompat extend' });
    }
  }

  return fails;
});

define("38", "Deploy image baseline: node:24-alpine, no Actions workflow", () => {
  const fails = [];

  // (a) both Dockerfiles must pin the same Node image at every build stage.
  for (const [file, count] of [
    ["templates/deploy/Dockerfile", 3],
    ["templates/agent/Dockerfile", 2],
  ]) {
    if (!exists(file)) {
      fails.push({ file, detail: "missing" });
      continue;
    }
    const src = read(file);
    const matches = [...src.matchAll(/^FROM node:\S+/gm)].map((m) => m[0]);
    if (matches.length !== count) {
      fails.push({ file, detail: `expected ${count} "FROM node:..." line(s), found ${matches.length}` });
    }
    for (const line of matches) {
      if (line !== "FROM node:24-alpine") {
        fails.push({ file, detail: `"${line}" - the Next 16 baseline requires FROM node:24-alpine` });
      }
    }
  }

  // (b) the build workflow this check used to pin Actions versions for is
  // deleted outright (CONTRACT.md §5, check 31): a version-pinned Actions
  // workflow with no Actions in the pipeline at all would just be dead
  // supply-chain surface to keep patched for nothing.
  if (exists("templates/deploy/build.yml")) {
    fails.push({
      file: "templates/deploy/build.yml",
      detail: "still exists - the direct build pipeline (CONTRACT.md §5) replaced it, there is no GitHub Actions workflow left to pin versions on",
    });
  }

  return fails;
});

define("39", "Branding: Calopsys is the company, Baudrier is the product", () => {
  const fails = [];

  // Calopsys is the company (author, copyright, fork attribution) and stays
  // named that way in these docs. Everywhere else, "Calopsys" naming the
  // product is a leftover of the pre-rename name.
  // package.json is allowed for its "by Calopsys" attribution; its "name"
  // field is pinned to the product name by the guard below regardless.
  const BRAND_ALLOWLIST = new Set([
    "NOTICE", "CHANGELOG.md", "README.md",
    "tools/verify.mjs", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json",
    "package.json",
  ]);

  const inScope = (f) =>
    f.startsWith("skills/") || f.startsWith("docs/") || f.startsWith("templates/") ||
    f.startsWith("scripts/") || f.startsWith("tools/") ||
    (!f.includes("/") && /\.(?:md|json)$/i.test(f));

  for (const f of FILES) {
    if (BRAND_ALLOWLIST.has(f) || !inScope(f)) continue;
    let src;
    try {
      src = read(f);
    } catch {
      continue;
    }
    const lines = src.split("\n");
    let count = 0;
    let firstLine = -1;
    lines.forEach((l, i) => {
      // "calopsys/baudrier" is the GitHub org/repo slug used by `/plugin
      // marketplace add` - the same attribution the two plugin manifests
      // already carry in their github.com/calopsys/ URL, just spelled as a
      // marketplace command instead of a URL.
      const stripped = l.replace(/calopsys\/baudrier/gi, "");
      const n = (stripped.match(/calopsys/gi) || []).length;
      if (n) {
        count += n;
        if (firstLine < 0) firstLine = i + 1;
      }
    });
    if (count) {
      fails.push({ file: f, detail: `"calopsys" x${count}, first at line ${firstLine} - Calopsys is the company, rename the product name to Baudrier` });
    }
  }

  // The two plugin manifests may keep "Calopsys" as author/owner and in the
  // github.com/calopsys/ URL, but their "name" fields are the product name.
  for (const f of [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"]) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "missing" });
      continue;
    }
    let m;
    try {
      m = JSON.parse(read(f));
    } catch (e) {
      fails.push({ file: f, detail: `invalid JSON: ${e.message}` });
      continue;
    }
    if (/calopsys/i.test(m.name || "")) {
      fails.push({ file: f, detail: `"name": "${m.name}" - the plugin/marketplace name must be "baudrier"` });
    }
    for (const p of m.plugins || []) {
      if (/calopsys/i.test(p.name || "")) {
        fails.push({ file: f, detail: `plugins[].name "${p.name}" - the plugin name must be "baudrier"` });
      }
    }
  }

  // Coupling guard: package.json's name and deps-dir.mjs's MANIFEST_NAME name
  // the same data directory. A rename that lands on only one side would make
  // every Scaleway call fail with "dependencies not installed", silently.
  const pkgName = exists("package.json") ? JSON.parse(read("package.json")).name : undefined;
  const manifestName = exists("tools/deps-dir.mjs")
    ? read("tools/deps-dir.mjs").match(/MANIFEST_NAME\s*=\s*"([^"]+)"/)?.[1]
    : undefined;
  if (pkgName && manifestName && pkgName !== manifestName) {
    fails.push({ file: "package.json", detail: `name "${pkgName}" != tools/deps-dir.mjs MANIFEST_NAME "${manifestName}" - the two must never drift` });
  }

  // Product-name guard: the rename's actual deliverable.
  if (pkgName !== "baudrier") {
    fails.push({ file: "package.json", detail: `name is "${pkgName}", expected "baudrier"` });
  }

  return fails;
});

define("40", "Skills: no orphans", () => {
  const fails = [];
  const hooksSrc = exists("hooks/hooks.json") ? read("hooks/hooks.json") : "";
  for (const dir of SKILL_DIRS) {
    if (exists(`skills/${dir}/DOC.md`)) continue; // public skill - always fine
    if (!dir.startsWith("_")) {
      fails.push({ file: `skills/${dir}`, detail: "not public (no DOC.md) and not _-prefixed - it is neither reachable nor internal" });
      continue;
    }
    // An internal skill must be named, at least once, in another SKILL.md or
    // in hooks/hooks.json - otherwise nothing ever invokes it.
    const nameRe = new RegExp(`(?<![A-Za-z0-9_-])${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`);
    let referenced = nameRe.test(hooksSrc);
    if (!referenced) {
      for (const skillMd of SKILL_MDS) {
        if (skillMd === `skills/${dir}/SKILL.md`) continue; // self-mentions do not count
        if (nameRe.test(read(skillMd))) {
          referenced = true;
          break;
        }
      }
    }
    if (!referenced) {
      fails.push({ file: `skills/${dir}`, detail: `internal skill "${dir}" is not referenced by name in any other SKILL.md or hooks/hooks.json` });
    }
  }
  return fails;
});

define("41", "Marketplace slug: the real fork, not a placeholder", () => {
  const fails = [];
  for (const f of FILES) {
    // CHANGELOG.md is history. verify.mjs necessarily contains the banned
    // string once, as this very check's own literal to search for.
    if (f === "CHANGELOG.md" || f === "tools/verify.mjs") continue;
    let src;
    try {
      src = read(f);
    } catch {
      continue;
    }
    if (src.includes("baudrier/baudrier")) {
      fails.push({ file: f, detail: '"baudrier/baudrier" is a placeholder marketplace slug - use "calopsys/baudrier"' });
    }
  }
  return fails;
});

define("42", "Hooks: every command hook declares a timeout", () => {
  const fails = [];
  const file = "hooks/hooks.json";
  if (!exists(file)) return [{ file, detail: "missing" }];
  let json;
  try {
    json = JSON.parse(read(file));
  } catch (e) {
    return [{ file, detail: `invalid JSON: ${e.message}` }];
  }
  for (const [event, entries] of Object.entries(json.hooks || {})) {
    for (const [i, entry] of (entries || []).entries()) {
      for (const [j, hook] of (entry.hooks || []).entries()) {
        if (hook.type !== "command") continue;
        if (typeof hook.timeout !== "number") {
          fails.push({ file, detail: `hooks.${event}[${i}].hooks[${j}] ("${hook.command}") has no numeric "timeout" - Claude Code's default can kill a slow install` });
        }
      }
    }
  }
  return fails;
});

define("43", "Scope: no mode env var; a configured Project id short-circuits creation", () => {
  const fails = [];

  // The operator "mode" is gone. It had two values and gated exactly one
  // thing: whether scwProject() may call createProject. The scope is inferred
  // now - a Project id configured through --scw-project-id or
  // SCW_DEFAULT_PROJECT_ID means "use this one",
  // and its absence means "act at organization level", where a 403 already
  // raises the needs_admin error /bootstrap recovers from. A returning
  // variable would put a maturity label ("poc") back on what is really a
  // permission scope, so its tokens must not reappear anywhere.
  // CHANGELOG.md is history and tools/verify.mjs carries the literals below.
  const DEAD = ["BAUDRIER_SCW_MODE", "readScwMode", "poc_needs_project_id", "BAUDRIER_SCW_PROJECTS_IDS", "projectIdFromEnvMap"];
  for (const f of FILES) {
    if (f === "tools/verify.mjs" || f === "CHANGELOG.md") continue;
    let src;
    try {
      src = read(f);
    } catch {
      continue;
    }
    for (const token of DEAD) {
      if (src.includes(token)) {
        fails.push({ file: f, detail: `references "${token}" - the operator-mode env var is deleted (CONTRACT.md §1, §2)` });
      }
    }
  }

  if (exists("scripts/persist-scw-mode.mjs")) {
    fails.push({
      file: "scripts/persist-scw-mode.mjs",
      detail: "still exists - there is no operator mode left to persist (CONTRACT.md §1, §2)",
    });
  }

  const auth = "scripts/scaleway/_scw-auth.mjs";
  if (!exists(auth)) {
    fails.push({ file: auth, detail: "missing" });
  } else {
    const src = stripComments(read(auth));
    if (!/export function projectIdFromEnv\s*\(/.test(src)) {
      fails.push({
        file: auth,
        detail: "does not export projectIdFromEnv() - scwProject() has no env-only way to tell a configured Project from an absent one",
      });
    }
  }

  // Returns the source between a `{` at openBrace and its matching `}`.
  function bracedBodyAt(src, openBrace) {
    let depth = 0;
    for (let i = openBrace; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(openBrace, i + 1);
    }
    return src.slice(openBrace);
  }

  const bootstrapInit = "scripts/bootstrap-init.mjs";
  if (!exists(bootstrapInit)) {
    fails.push({ file: bootstrapInit, detail: "missing" });
  } else {
    const src = stripComments(read(bootstrapInit));
    const m = src.match(/async function scwProject\(\)\s*\{/);
    if (!m) {
      fails.push({ file: bootstrapInit, detail: "scwProject() not found - check needs updating to the function's new shape" });
    } else {
      const body = bracedBodyAt(src, m.index + m[0].length - 1);
      const createAt = body.indexOf("createProject");
      if (createAt === -1) {
        fails.push({ file: bootstrapInit, detail: "scwProject() no longer calls createProject - check is stale, update it" });
      } else if (!/\bprojectIdFromEnv\b/.test(body.slice(0, createAt))) {
        fails.push({
          file: bootstrapInit,
          detail: "scwProject()'s createProject call is reachable without consulting projectIdFromEnv() first - a configured Project id must short-circuit creation",
        });
      }
    }
  }

  return fails;
});

define("44", "GH CLI: dropped from the toolchain - no `gh secret set` survives", () => {
  const fails = [];

  // gh is dropped from the toolchain entirely (CONTRACT.md §7, plan item 5):
  // GitHub Actions is out of the deploy pipeline, so there is no CI secret
  // left to mint or push. bootstrap-init.mjs#ghSecrets() and every `gh secret
  // set` spawn call are deleted outright, not merely made safer - this check
  // used to require stdin-only delivery; now it requires the mechanism not
  // exist at all.
  const bootstrapInit = "scripts/bootstrap-init.mjs";
  if (exists(bootstrapInit) && /async function ghSecrets\s*\(/.test(stripComments(read(bootstrapInit)))) {
    fails.push({
      file: bootstrapInit,
      detail: "ghSecrets() still exists - gh is dropped from the toolchain entirely (CONTRACT.md §7), there is no GitHub Actions secret to provision",
    });
  }

  const callRe = /spawn(?:Sync)?\s*\(\s*["'`]gh["'`]\s*,/;
  for (const f of MJS) {
    if (!f.startsWith("scripts/")) continue;
    const code = stripComments(read(f));
    if (callRe.test(code) && /["'`]secret["'`]\s*,\s*["'`]set["'`]/.test(code)) {
      fails.push({ file: f, detail: "spawns `gh secret set` - gh is dropped from the toolchain entirely (CONTRACT.md §7)" });
    }
  }

  return fails;
});

// Check 45 ("Adoption: the candidate app key never touches a child process's
// argv") was deleted with BAUDRIER_APP_KEY: there is no candidate key to
// adopt any more. Check 19 keeps the token itself from coming back, and
// check 47 still guards every other secret against argv exposure.

define("46", "Agent tools fail safe", () => {
  const fails = [];

  const dbFile = "templates/agent/tools/db-query.ts";
  if (!exists(dbFile)) {
    fails.push({ file: dbFile, detail: "missing" });
  } else {
    const src = stripComments(read(dbFile));
    if (!/READ ONLY/.test(src)) {
      fails.push({ file: dbFile, detail: "no READ ONLY transaction - the lexical SELECT-only check is not backed by a Postgres-level guarantee" });
    }
    if (!/statement_timeout/.test(src)) {
      fails.push({ file: dbFile, detail: "no statement_timeout - a runaway query has no server-side time limit" });
    }
    const finallyAt = src.indexOf("finally");
    if (finallyAt < 0 || !/ROLLBACK/.test(src.slice(finallyAt))) {
      fails.push({ file: dbFile, detail: "no ROLLBACK in a finally block - a query the lexical guard missed could still commit" });
    }
  }

  const httpFile = "templates/agent/tools/http-fetch.ts";
  if (!exists(httpFile)) {
    fails.push({ file: httpFile, detail: "missing" });
  } else {
    const src = stripComments(read(httpFile));
    if (!/redirect:\s*["'`]manual["'`]/.test(src)) {
      fails.push({ file: httpFile, detail: 'no redirect: "manual" - the SSRF guard would be skipped on any hop the runtime follows automatically' });
    }
    const loopMatch = src.match(/for\s*\([^)]*hop[^)]*\)\s*\{/);
    if (!loopMatch) {
      fails.push({ file: httpFile, detail: "no per-hop redirect loop found - cannot confirm the SSRF guard re-runs on every Location target" });
    } else {
      let depth = 0;
      let end = loopMatch.index;
      for (let i = loopMatch.index + loopMatch[0].length - 1; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) {
          end = i;
          break;
        }
      }
      const loopBody = src.slice(loopMatch.index, end + 1);
      if (!/assertUrlIsSafe\s*\(/.test(loopBody)) {
        fails.push({
          file: httpFile,
          detail: "the redirect loop never calls the URL-safety validator - a 302 to a blocked address would not be re-checked",
        });
      }
    }
  }

  const emailFile = "templates/agent/tools/send-email.ts";
  if (!exists(emailFile)) {
    fails.push({ file: emailFile, detail: "missing" });
  } else {
    const src = stripComments(read(emailFile));
    if (!/AGENT_EMAIL_ALLOWED_RECIPIENTS/.test(src)) {
      fails.push({ file: emailFile, detail: "no AGENT_EMAIL_ALLOWED_RECIPIENTS allowlist - the agent could email anyone" });
    }
    if (!/ADMIN_EMAIL/.test(src)) {
      fails.push({ file: emailFile, detail: "no ADMIN_EMAIL fallback - an unset allowlist has no safe default recipient" });
    }
    if (!/MAX_SENDS_PER_RUN|sendCount/.test(src)) {
      fails.push({ file: emailFile, detail: "no per-run send cap - a runaway loop could send unbounded email even to an allowed recipient" });
    }
  }

  return fails;
});

define("47", "No plaintext secret on argv or default stdout", () => {
  const fails = [];

  const secretsFile = "scripts/scaleway/secrets.mjs";
  if (!exists(secretsFile)) {
    fails.push({ file: secretsFile, detail: "missing" });
  } else {
    const src = stripComments(read(secretsFile));
    if (!/reveal\s*\?\s*\{[^}]*\bvalue\b/.test(src)) {
      fails.push({ file: secretsFile, detail: "get's default output does not appear gated on --reveal for the value field" });
    }
    const putAt = src.indexOf('case "put"');
    if (putAt < 0 || !/refused/i.test(src.slice(putAt, putAt + 1200))) {
      fails.push({ file: secretsFile, detail: "put's positional-VALUE refusal message is missing - a caller could still pass the secret on argv" });
    }
  }

  const iamFile = "scripts/scaleway/iam.mjs";
  if (!exists(iamFile)) {
    fails.push({ file: iamFile, detail: "missing" });
  } else {
    const src = stripComments(read(iamFile));
    if (!/reveal\s*\?\s*\{[^}]*\bsecretKey\b[^}]*\}\s*:\s*\{[^}]*secretKeyLength/.test(src)) {
      fails.push({ file: iamFile, detail: "create-key's default output does not appear gated on --reveal for secretKey (must fall back to secretKeyLength)" });
    }
  }

  // No caller may spawn push-env-vars.mjs with a KEY=VALUE secret literal on
  // argv - CONTRACT.md's stdin-only rule (see check 25's spirit, applied to
  // the sibling helper). Scoped to the spawnSync call's ARGV ARRAY only (the
  // array literal that is its own positional argument) - not the whole call,
  // whose options object legitimately carries the same-looking KEY=VALUE text
  // in its `input:` string (that IS the safe stdin path), and not an
  // unrelated line elsewhere in the file (e.g. an error message that happens
  // to mention both "push-env-vars.mjs" and "AUTH_SECRET").
  const SECRET_ARGV_PATTERN = /SECRET|_KEY=|TOTP/;
  for (const f of MJS) {
    if (f.startsWith("tools/")) continue;
    let src;
    try {
      src = stripComments(read(f));
    } catch {
      continue;
    }

    // Every call site resolves the helper path into a variable first
    // (`const helper = join(__dirname, "push-env-vars.mjs")`) rather than
    // inlining the literal into the spawnSync call - collect those variable
    // names so an argv array that references the variable is still
    // recognised as a push-env-vars.mjs spawn.
    const helperVarNames = [...src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*join\([^)]*["'`]push-env-vars\.mjs["'`]\s*\)/g)].map((m) => m[1]);

    for (const spawnMatch of src.matchAll(/spawnSync\s*\(/g)) {
      const openParen = spawnMatch.index + spawnMatch[0].length - 1;
      let depth = 0;
      let closeParen = -1;
      for (let i = openParen; i < src.length; i++) {
        if (src[i] === "(") depth++;
        else if (src[i] === ")" && --depth === 0) {
          closeParen = i;
          break;
        }
      }
      if (closeParen < 0) continue;
      const call = src.slice(spawnMatch.index, closeParen + 1);

      const bracketStart = call.indexOf("[");
      if (bracketStart < 0) continue;
      let bDepth = 0;
      let bracketEnd = -1;
      for (let i = bracketStart; i < call.length; i++) {
        if (call[i] === "[") bDepth++;
        else if (call[i] === "]" && --bDepth === 0) {
          bracketEnd = i;
          break;
        }
      }
      if (bracketEnd < 0) continue;
      const argsArray = call.slice(bracketStart, bracketEnd + 1);

      const isPushEnvVarsCall =
        argsArray.includes("push-env-vars.mjs") || helperVarNames.some((v) => new RegExp(`\\b${v}\\b`).test(argsArray));
      if (isPushEnvVarsCall && SECRET_ARGV_PATTERN.test(argsArray)) {
        fails.push({ file: f, detail: "spawns push-env-vars.mjs with an argv element that looks like a secret KEY=VALUE literal - use --stdin instead" });
      }
    }
  }

  return fails;
});

define("48", "Health check: exact-path only, consumers ping /api/healthz", () => {
  const fails = [];

  const proxyFile = "templates/deploy/proxy.ts";
  if (!exists(proxyFile)) {
    fails.push({ file: proxyFile, detail: "missing" });
  } else {
    const src = stripComments(read(proxyFile));
    if (/\/api\/trpc\/healthcheck/.test(src)) {
      fails.push({
        file: proxyFile,
        detail: "still references /api/trpc/healthcheck - a tRPC batch call bundles paths with a comma, so a prefix exemption on it lets an unauthenticated caller smuggle any procedure into the same batch",
      });
    }
    if (!/pathname\s*===\s*HEALTHZ_PATH/.test(src) && !/pathname\s*===\s*["'`]\/api\/healthz["'`]/.test(src)) {
      fails.push({ file: proxyFile, detail: "no exact (===) pathname comparison against /api/healthz - a startsWith() match would reopen the tRPC-batching hole" });
    }
  }

  const healthzRouteFile = "templates/deploy/healthz-route.ts";
  if (!exists(healthzRouteFile)) {
    fails.push({ file: healthzRouteFile, detail: "missing" });
  }

  // A vitrine has no Next.js route to render /api/healthz - Caddy answers it
  // directly (templates/landing/Caddyfile). This is the landing counterpart of
  // the proxyFile check above: deploy.mjs's smoke test (STACK-agnostic) expects
  // the same exact path and body from either stack.
  const landingCaddyfile = "templates/landing/Caddyfile";
  if (exists(landingCaddyfile)) {
    const csrc = read(landingCaddyfile);
    if (!/handle \/api\/healthz\s*\{/.test(csrc)) {
      fails.push({
        file: landingCaddyfile,
        detail: "no exact `handle /api/healthz {` block - deploy.mjs's smoke test needs the same exact path proxy.ts exempts",
      });
    }
    if (!/"ok":true/.test(csrc)) {
      fails.push({ file: landingCaddyfile, detail: 'the /api/healthz handler does not respond {"ok":true} - smokeTest() asserts this exact body' });
    }
  }

  const bootstrapFile = "scripts/bootstrap-init.mjs";
  if (!exists(bootstrapFile)) {
    fails.push({ file: bootstrapFile, detail: "missing" });
  } else if (!read(bootstrapFile).includes("deploy/healthz-route.ts")) {
    fails.push({ file: bootstrapFile, detail: 'does not render "deploy/healthz-route.ts" - a generated project would have no /api/healthz route for the proxy to exempt' });
  }

  const cronFile = "scripts/setup-cron-worker.mjs";
  if (!exists(cronFile)) {
    fails.push({ file: cronFile, detail: "missing" });
  } else {
    const src = read(cronFile);
    if (/\/api\/trpc\/healthcheck/.test(src)) {
      fails.push({ file: cronFile, detail: "still pings /api/trpc/healthcheck, not the plain /api/healthz route" });
    }
    if (!/\/api\/healthz/.test(src)) {
      fails.push({ file: cronFile, detail: "does not ping /api/healthz" });
    }
  }

  // deploy.mjs's final smoke test is a healthz consumer too. It must target
  // /api/healthz (the homepage 403s on a gated app, which used to fail every
  // production deploy and skip pruneTags), and its healthz 403 branch must
  // fail() with the proxy.ts diagnosis - a broken exemption must never pass.
  const deployFile = "scripts/deploy.mjs";
  if (!exists(deployFile)) {
    fails.push({ file: deployFile, detail: "missing" });
  } else {
    const dsrc = read(deployFile);
    const fnAt = dsrc.indexOf("async function smokeTest(");
    if (fnAt < 0) {
      fails.push({ file: deployFile, detail: "smokeTest() not found" });
    } else {
      const nextFnAt = dsrc.indexOf("\nasync function", fnAt + 1);
      const body = dsrc.slice(fnAt, nextFnAt > 0 ? nextFnAt : undefined);
      if (!body.includes("/api/healthz")) {
        fails.push({ file: deployFile, detail: "smokeTest() does not target /api/healthz - a gated app 403s the homepage, so every production deploy ends failed and pruneTags never runs" });
      }
      if (!body.includes('"ok":true')) {
        fails.push({ file: deployFile, detail: 'smokeTest() does not assert the {"ok":true} healthz body' });
      }
      const s403At = body.indexOf("403");
      const failAt = s403At >= 0 ? body.indexOf("fail(", s403At) : -1;
      if (s403At < 0 || failAt < 0 || !body.includes("proxy.ts")) {
        fails.push({ file: deployFile, detail: "smokeTest()'s healthz 403 branch does not fail() with the src/proxy.ts exemption diagnosis - a broken IP-gate exemption would pass silently" });
      }
      // The homepage probe authenticates with the harness token and asserts
      // 200 (CONTRACT.md §5 step 6, §6) - without the header the probe would
      // silently regress to unauthenticated-and-informational.
      for (const must of ["ACCESS_BYPASS_TOKEN", "x-baudrier-access-token"]) {
        if (!body.includes(must)) {
          fails.push({ file: deployFile, detail: `smokeTest() no longer uses ${must} - the homepage probe cannot pass the IP gate and asserts nothing` });
        }
      }
    }
  }

  const deploySkill = "skills/deploy/SKILL.md";
  if (exists(deploySkill)) {
    const s = read(deploySkill);
    if (!s.includes("/api/healthz")) {
      fails.push({ file: deploySkill, detail: "never mentions /api/healthz - the smoke-test contract is undocumented for the agent" });
    }
    if (s.includes("treat it as success")) {
      fails.push({ file: deploySkill, detail: 'still teaches "403 on smokeTest = treat it as success" - obsolete since the healthz-based smoke test; a healthz 403 is a real failure' });
    }
  }

  return fails;
});

/** Doc files where the literal banned host string is the documentation of
 * the ban itself - the same reasoning as tools/verify.mjs necessarily
 * containing the pattern it checks for. */
const IMAGE_HOST_DOC_ALLOWLIST = new Set(["CHANGELOG.md", "skills/bootstrap/SKILL.md"]);

define("49", "Images: no US placeholder hosts", () => {
  const fails = [];
  const BANNED_HOSTS = [/picsum\.photos/i, /unsplash\.com/i];
  for (const f of FILES) {
    if (IMAGE_HOST_DOC_ALLOWLIST.has(f) || f.startsWith("tools/")) continue;
    let src;
    try {
      src = read(f);
    } catch {
      continue;
    }
    for (const re of BANNED_HOSTS) {
      const n = (src.match(new RegExp(re.source, "gi")) || []).length;
      if (n) {
        fails.push({
          file: f,
          detail: `"${re.source.replace(/\\\./g, ".")}" x${n} - a stock-photo URL sends every visitor's IP to a US company on every page load`,
        });
      }
    }
  }
  return fails;
});

define("50", "Headers: generated apps ship the baseline", () => {
  const fails = [];
  const REQUIRED = [
    ["poweredByHeader: false", /poweredByHeader\s*:\s*false/],
    ["a headers() function or array", /async\s+headers\s*\(\)|headers\s*:\s*\[/],
    ["Strict-Transport-Security", /Strict-Transport-Security/],
    ["X-Content-Type-Options", /X-Content-Type-Options/],
    ["Referrer-Policy", /Referrer-Policy/],
    ["frame-ancestors", /frame-ancestors/],
    ["Content-Security-Policy-Report-Only", /Content-Security-Policy-Report-Only/],
  ];

  for (const file of ["templates/deploy/next.config.js", "scripts/setup-security.mjs"]) {
    if (!exists(file)) {
      fails.push({ file, detail: "missing" });
      continue;
    }
    const src = stripComments(read(file));
    for (const [label, re] of REQUIRED) {
      if (!re.test(src)) {
        fails.push({ file, detail: `missing ${label}` });
      }
    }
  }

  return fails;
});

define("51", "Version: the three manifests and CHANGELOG agree", () => {
  const fails = [];
  const jsonFiles = ["package.json", ".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"];
  const parsed = {};
  for (const f of jsonFiles) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "missing" });
      continue;
    }
    try {
      parsed[f] = JSON.parse(read(f));
    } catch (e) {
      fails.push({ file: f, detail: `invalid JSON: ${e.message}` });
    }
  }
  if (fails.length) return fails;

  const pkgVersion = parsed["package.json"].version;
  const pluginVersion = parsed[".claude-plugin/plugin.json"].version;
  const marketplaceVersion = parsed[".claude-plugin/marketplace.json"].plugins?.[0]?.version;

  if (!pkgVersion) fails.push({ file: "package.json", detail: "no version field" });
  if (!pluginVersion) fails.push({ file: ".claude-plugin/plugin.json", detail: "no version field" });
  if (!marketplaceVersion) fails.push({ file: ".claude-plugin/marketplace.json", detail: "no plugins[0].version field" });
  if (fails.length) return fails;

  if (pluginVersion !== pkgVersion) {
    fails.push({
      file: ".claude-plugin/plugin.json",
      detail: `version "${pluginVersion}" disagrees with package.json's "${pkgVersion}"`,
    });
  }
  if (marketplaceVersion !== pkgVersion) {
    fails.push({
      file: ".claude-plugin/marketplace.json",
      detail: `plugins[0].version "${marketplaceVersion}" disagrees with package.json's "${pkgVersion}"`,
    });
  }

  if (!exists("CHANGELOG.md")) {
    fails.push({ file: "CHANGELOG.md", detail: "missing" });
    return fails;
  }
  // Either "## v0.3.0" or "## 0.3.0" is accepted (both forms appear across
  // this file's own history), as long as the number matches exactly.
  const escaped = pkgVersion.replace(/\./g, "\\.");
  const headingRe = new RegExp(`^##\\s+v?${escaped}\\b`, "m");
  if (!headingRe.test(read("CHANGELOG.md"))) {
    fails.push({
      file: "CHANGELOG.md",
      detail: `no "## v${pkgVersion}" (or "## ${pkgVersion}") heading matching package.json's version`,
    });
  }

  return fails;
});

define("52", "Supply chain: the age floor precedes the first install", () => {
  const fails = [];
  const bootstrap = "scripts/bootstrap-init.mjs";
  if (!exists(bootstrap)) return [{ file: bootstrap, detail: "missing" }];

  // Comments must not count: this check's own rationale comment names
  // minimumReleaseAge twice, which would satisfy every test below while the
  // real setting is gone from the emitted yaml.
  const src = stripComments(read(bootstrap));
  // `pnpm add <pkg>@latest` runs with build scripts enabled in a generated
  // project (dangerously-allow-all-builds, pnpm >= 11), so the release-age
  // floor is the only thing standing between the user and a hours-old
  // poisoned publish.
  const age = src.match(/minimumReleaseAge:\s*(\d+)/);
  if (!age) {
    fails.push({
      file: bootstrap,
      detail: "no minimumReleaseAge written into the generated pnpm-workspace.yaml - a package published minutes ago installs and runs its build script",
    });
  } else if (Number(age[1]) < 4320) {
    fails.push({
      file: bootstrap,
      detail: `minimumReleaseAge is ${age[1]} minutes, below the 3-day (4320) floor`,
    });
  }
  // pnpm defaults minimumReleaseAgeStrict to TRUE once minimumReleaseAge is
  // set explicitly, which turns "the only match is too new" into a failed
  // install in front of a non-technical user.
  if (!/minimumReleaseAgeStrict:\s*false/.test(src)) {
    fails.push({
      file: bootstrap,
      detail: "minimumReleaseAgeStrict is not pinned to false - pnpm defaults it to true and a too-new-only range then fails the install",
    });
  }

  // A prior version of this check asserted the floor lived INSIDE shadcn() -
  // that placement was itself the bug it should have caught. scaffoldT3()
  // runs the project's first `pnpm install` with no floor in effect yet, so
  // the lockfile it produces can pin an exact version published minutes
  // earlier. shadcn() then writes the floor for the first time, after three
  // dependency resolutions (create-t3-app, the version overrides, and that
  // first install) already ran unguarded - and if the lockfile's exact pin is
  // younger than the floor, shadcn's own re-resolve has nothing that
  // satisfies both, so it deadlocks. The floor must exist before
  // scaffoldT3()'s first `pnpm install`, written by a dedicated function.
  const scaffoldAt = src.indexOf("function scaffoldT3");
  if (scaffoldAt < 0) {
    fails.push({ file: bootstrap, detail: "scaffoldT3() not found" });
  } else {
    const nextFnAt = src.indexOf("\nfunction ", scaffoldAt + 1);
    const body = src.slice(scaffoldAt, nextFnAt > 0 ? nextFnAt : undefined);
    const writerAt = body.indexOf("writeSupplyChainWorkspaceYaml(");
    const installAt = body.indexOf("pnpm install");
    if (writerAt < 0) {
      fails.push({
        file: bootstrap,
        detail: "scaffoldT3() never calls writeSupplyChainWorkspaceYaml() - nothing guarantees the age floor exists before the first pnpm install",
      });
    }
    if (installAt < 0) {
      fails.push({ file: bootstrap, detail: 'scaffoldT3() no longer runs "pnpm install"' });
    }
    if (writerAt >= 0 && installAt >= 0 && writerAt > installAt) {
      fails.push({
        file: bootstrap,
        detail: "writeSupplyChainWorkspaceYaml() runs AFTER pnpm install inside scaffoldT3() - the first install still resolves with no age floor in effect",
      });
    }
  }

  const shadcnAt = src.indexOf("function shadcn()");
  if (shadcnAt >= 0) {
    const nextFnAt = src.indexOf("\nfunction ", shadcnAt + 1);
    const shadcnBody = src.slice(shadcnAt, nextFnAt > 0 ? nextFnAt : undefined);
    if (shadcnBody.includes("minimumReleaseAge")) {
      fails.push({
        file: bootstrap,
        detail: "minimumReleaseAge is still written inside shadcn() - the floor belongs to writeSupplyChainWorkspaceYaml(), set once before the first install, not re-asserted here",
      });
    }
  }

  const skill = "skills/security/SKILL.md";
  if (!exists(skill)) {
    fails.push({ file: skill, detail: "missing" });
  } else if (!read(skill).includes("minimumReleaseAge")) {
    fails.push({ file: skill, detail: "the audit step no longer verifies the generated project's minimumReleaseAge floor" });
  }

  return fails;
});

define("53", "Web detection: isRemoteSandbox() exists and is actually consumed", () => {
  const fails = [];

  const platformFile = "scripts/_platform.mjs";
  if (!exists(platformFile)) {
    fails.push({ file: platformFile, detail: "missing" });
  } else {
    const src = read(platformFile);
    if (!/export function isRemoteSandbox\s*\(/.test(src)) {
      fails.push({ file: platformFile, detail: "does not export isRemoteSandbox()" });
    }
    if (!/CLAUDE_CODE_REMOTE/.test(src)) {
      fails.push({ file: platformFile, detail: "isRemoteSandbox() does not read CLAUDE_CODE_REMOTE" });
    }
  }

  // Direct consumers: each must actually call isRemoteSandbox(), not just
  // import _platform.mjs for something else.
  for (const f of [
    "scripts/bootstrap-init.mjs",
    "scripts/save-project/build-snapshot.mjs",
    "scripts/_docker-build.mjs",
  ]) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "missing" });
      continue;
    }
    if (!/isRemoteSandbox\s*\(/.test(read(f))) {
      fails.push({ file: f, detail: "does not consume isRemoteSandbox() - web-sandbox behaviour may have regressed" });
    }
  }

  // deploy.mjs consumes it INDIRECTLY, through ensureDocker() - it never
  // branches on the platform itself, only needs the daemon started lazily
  // when this process can plausibly do so (CONTRACT.md §1, §7).
  const deployFile = "scripts/deploy.mjs";
  const ensureDockerdFile = "scripts/ensure-dockerd.mjs";
  if (!exists(deployFile)) {
    fails.push({ file: deployFile, detail: "missing" });
  } else if (!/ensureDocker\s*\(/.test(read(deployFile))) {
    fails.push({ file: deployFile, detail: "does not call ensureDocker() - has no path to isRemoteSandbox() at all, direct or indirect" });
  }
  if (!exists(ensureDockerdFile)) {
    fails.push({ file: ensureDockerdFile, detail: "missing" });
  } else if (!/isRemoteSandbox\s*\(/.test(read(ensureDockerdFile))) {
    fails.push({ file: ensureDockerdFile, detail: "does not consume isRemoteSandbox() - deploy.mjs's only path to it would be broken" });
  }

  // The two SKILLs that actually branch on the platform must say so - either
  // literally (the preflight's own environment guard) or in the platform-aware
  // prose bootstrap actually carries ("Claude Code web sandbox").
  const WEB_MENTION_RE = /CLAUDE_CODE_REMOTE|OS=web|web sandbox/i;
  for (const f of ["skills/_preflight/SKILL.md", "skills/bootstrap/SKILL.md"]) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "missing" });
    } else if (!WEB_MENTION_RE.test(read(f))) {
      fails.push({ file: f, detail: 'never mentions the web sandbox (CLAUDE_CODE_REMOTE / OS=web / "web sandbox") - the platform split may have regressed' });
    }
  }

  return fails;
});

define("54", "Env-only: no reference to deleted credential-persistence machinery", () => {
  const fails = [];

  // Every mechanism the env-only credential model (CONTRACT.md §2) replaced.
  // "except this file": tools/verify.mjs necessarily names every one of these,
  // as this very check's own literals to search for.
  const BANNED = [
    { name: "_write-user-env", re: /_write-user-env/ },
    { name: "persistScw", re: /persistScw/ },
    { name: "collect-scw-credentials", re: /collect-scw-credentials/ },
    { name: "persist-scw-mode", re: /persist-scw-mode/ },
    { name: ".baudrier/credentials.json", re: /\.baudrier\/credentials\.json/ },
    { name: ".scaleway/container.json", re: /\.scaleway\/container\.json/ },
  ];
  for (const f of FILES) {
    if (f === "tools/verify.mjs") continue;
    if (!(f.startsWith("scripts/") || f.startsWith("tools/") || f.startsWith("skills/") || f.startsWith("templates/"))) continue;
    let src;
    try {
      src = read(f);
    } catch {
      continue;
    }
    for (const b of BANNED) {
      if (b.re.test(src)) {
        fails.push({ file: f, detail: `references "${b.name}" - credentials are env-only now (CONTRACT.md §2), this mechanism is deleted` });
      }
    }
  }

  // The web preflight must never ask the user to paste a secret into
  // chat - it points at the environment dialog and a new session instead.
  const preflightSkill = "skills/_preflight/SKILL.md";
  if (!exists(preflightSkill)) {
    fails.push({ file: preflightSkill, detail: "missing" });
  } else if (!/(nouvelle conversation|NEW session)/i.test(read(preflightSkill))) {
    fails.push({
      file: preflightSkill,
      detail: "never instructs the user to start a new session/conversation after fixing the environment - a running one cannot reread modified env vars",
    });
  }

  // --secret-key-stdin was the old chat-collection CLI's flag; it must not
  // survive anywhere now that nothing collects a secret in chat.
  for (const f of FILES) {
    if (f === "tools/verify.mjs") continue;
    let src;
    try {
      src = read(f);
    } catch {
      continue;
    }
    if (src.includes("--secret-key-stdin")) {
      fails.push({ file: f, detail: "--secret-key-stdin still appears - the chat-collection CLI flag it belonged to is deleted" });
    }
  }

  // A Cas B key is scoped to one Project and cannot list Projects, so
  // SCW_DEFAULT_PROJECT_ID is how it declares which one it owns
  // (CONTRACT.md §2). resolveProjectId() must consult it before falling
  // through to the session cache and the org-level lookup, both of which a
  // Project-scoped key cannot reach.
  const scwAuth = "scripts/scaleway/_scw-auth.mjs";
  if (!exists(scwAuth)) {
    fails.push({ file: scwAuth, detail: "missing" });
  } else {
    const src = read(scwAuth);
    const resolver = src.slice(src.indexOf("export async function resolveProjectId"));
    const envAt = resolver.indexOf("SCW_DEFAULT_PROJECT_ID");
    const lookupAt = resolver.indexOf("listProjects");
    if (envAt === -1) {
      fails.push({ file: scwAuth, detail: "resolveProjectId() no longer consults SCW_DEFAULT_PROJECT_ID - a Project-scoped key has no way to declare its Project (CONTRACT.md §2)" });
    } else if (lookupAt !== -1 && lookupAt < envAt) {
      fails.push({ file: scwAuth, detail: "resolveProjectId() attempts the org-level listProjects lookup before reading SCW_DEFAULT_PROJECT_ID - a Cas B key would 403 on a Project it already declared" });
    }
    if (!src.includes("cache-project")) {
      fails.push({ file: scwAuth, detail: "the cache-project CLI command is gone - a Cas B id given in the chat has no way to reach the session cache (CONTRACT.md §2, §3)" });
    }
  }
  // The per-app Project map is gone: one key now serves one Project, so a
  // Cas B environment declares its Project with SCW_DEFAULT_PROJECT_ID alone.
  for (const f of ["README.md", "skills/_preflight/SKILL.md", "CONTRACT.md"]) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "missing" });
    } else if (!read(f).includes("SCW_DEFAULT_PROJECT_ID")) {
      fails.push({ file: f, detail: "never names SCW_DEFAULT_PROJECT_ID - a Project-scoped key cannot list Projects, so this document leaves it no way to declare its own (CONTRACT.md §2)" });
    }
  }

  return fails;
});

define("55", "In-place bootstrap: ls-remote gate, scratch-scaffold move, no gh invocation", () => {
  const fails = [];

  const bootstrap = "scripts/bootstrap-init.mjs";
  if (!exists(bootstrap)) {
    fails.push({ file: bootstrap, detail: "missing" });
  } else {
    const src = read(bootstrap);
    if (!src.includes("git ls-remote origin")) {
      fails.push({ file: bootstrap, detail: 'preflight() never runs "git ls-remote origin" - the repo-access gate is missing' });
    }
    if (!/function pushToOrigin\s*\(/.test(src)) {
      fails.push({ file: bootstrap, detail: "pushToOrigin() is missing - the in-place bootstrap has no push step" });
    }
    if (!/function moveScaffoldIntoPlace\s*\(/.test(src)) {
      fails.push({ file: bootstrap, detail: "moveScaffoldIntoPlace() is missing - the scratch-scaffold move (create-t3-app under a temp name, then moved into place) may have regressed" });
    }
    // The package.json / src/ test detects a JS scaffold, not a codebase: a
    // Python or Go repo passes it, and moveScaffoldIntoPlace() only fails on a
    // NAME collision, so the T3 app would be merged into that code, committed
    // and deployed. preflight() must therefore also read the tracked files.
    const code = stripComments(src);
    if (!code.includes("git ls-files")) {
      fails.push({
        file: bootstrap,
        detail: 'preflight() never runs "git ls-files" - a repo holding code with no package.json and no src/ would be scaffolded over in place',
      });
    }
  }

  // No `gh` subcommand invocation anywhere in scripts/*.mjs - scoped to .mjs
  // files only, which is where an actual invocation would live.
  const GH_RE = /\bgh (auth|api|repo|secret|workflow|run)\b/;
  for (const f of MJS) {
    if (f === "tools/verify.mjs") continue;
    const code = stripComments(read(f));
    if (GH_RE.test(code)) {
      fails.push({ file: f, detail: "invokes a gh subcommand - gh is dropped from the toolchain entirely (CONTRACT.md §7)" });
    }
  }

  // Skill prose: same regex. skills/_preflight/SKILL.md's own "never gh auth
  // login, never gh auth status" prohibition sentence is the one documented
  // exception - allowed only on a line that actually carries the word
  // "never", never a blanket per-file allowlist.
  for (const f of FILES.filter((x) => x.startsWith("skills/") && x.endsWith(".md"))) {
    for (const line of read(f).split("\n")) {
      if (!GH_RE.test(line)) continue;
      if (f === "skills/_preflight/SKILL.md" && /\bnever\b/i.test(line)) continue;
      fails.push({ file: f, detail: `invokes a gh subcommand in prose: ${line.trim().slice(0, 140)}` });
    }
  }

  return fails;
});

define("56", "Direct pipeline: _docker-build.mjs shared by both callers, no Actions scaffolding", () => {
  const fails = [];

  const dockerBuild = "scripts/_docker-build.mjs";
  if (!exists(dockerBuild)) {
    fails.push({ file: dockerBuild, detail: "missing" });
  } else {
    // Comments are stripped: the file's own header prose names "linux/amd64"
    // to explain the rule, which must not let a changed DOCKER_PLATBORM value
    // hide behind it.
    const code = stripComments(read(dockerBuild));
    if (!/DOCKER_PLATFORM\s*=\s*["'`]linux\/amd64["'`]/.test(code)) {
      fails.push({ file: dockerBuild, detail: 'DOCKER_PLATFORM is not "linux/amd64" - Serverless Containers accept amd64 images only (CONTRACT.md §1)' });
    }
    if (!/args\.push\(\s*["'`]--platform["'`]/.test(code) && !/\[\s*["'`]build["'`]\s*,\s*["'`]--platform["'`]/.test(code)) {
      fails.push({ file: dockerBuild, detail: "docker build is never passed --platform" });
    }
    // The web egress proxy re-terminates TLS and build containers trust
    // neither the 127.0.0.1 proxy nor its CA (CONTRACT.md §1, live-verified
    // 2026-08-06): the pipeline must build on the host network, forward the
    // proxy env, and ship the CA bundle into the build context.
    if (!/["'`]--network["'`]\s*,\s*["'`]host["'`]/.test(code)) {
      fails.push({ file: dockerBuild, detail: "web builds never pass --network host - build RUN steps cannot reach the 127.0.0.1 egress proxy" });
    }
    if (!/HTTPS_PROXY/.test(code)) {
      fails.push({ file: dockerBuild, detail: "never forwards HTTPS_PROXY as a build-arg - build RUN steps cannot use the egress proxy" });
    }
    if (!/proxy-ca\.crt/.test(code)) {
      fails.push({ file: dockerBuild, detail: "never writes proxy-ca.crt into the build context - build TLS fails behind the re-terminating proxy" });
    }
  }

  const deployDockerfile = "templates/deploy/Dockerfile";
  if (exists(deployDockerfile)) {
    const df = read(deployDockerfile);
    const copies = df.match(/^COPY proxy-ca\.crt /gm) || [];
    if (copies.length < 2) {
      fails.push({ file: deployDockerfile, detail: `only ${copies.length} stage(s) COPY proxy-ca.crt - both network-active stages (deps, builder) must trust the web proxy CA` });
    }
    if (!/cat \/tmp\/proxy-ca\.crt >> \/etc\/ssl\/certs\/ca-certificates\.crt/.test(df)) {
      fails.push({ file: deployDockerfile, detail: "never appends proxy-ca.crt to the system CA bundle - apk fails behind the re-terminating proxy" });
    }
    if (!/NODE_EXTRA_CA_CERTS=\/etc\/ssl\/certs\/ca-certificates\.crt/.test(df)) {
      fails.push({ file: deployDockerfile, detail: "NODE_EXTRA_CA_CERTS does not point at the system bundle - corepack/pnpm/next-font fetches fail behind the proxy" });
    }
  }

  for (const f of ["scripts/bootstrap-init.mjs", "scripts/deploy.mjs"]) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "missing" });
      continue;
    }
    const src = read(f);
    if (!/from\s+["'`]\.\/_docker-build\.mjs["'`]/.test(src)) {
      fails.push({ file: f, detail: "does not import ./_docker-build.mjs - the shared direct build/push pipeline may have regressed" });
    }
  }

  const ensureDockerd = "scripts/ensure-dockerd.mjs";
  if (!exists(ensureDockerd)) {
    fails.push({ file: ensureDockerd, detail: "missing" });
  } else if (!/export\s+async\s+function\s+ensureDocker\s*\(/.test(read(ensureDockerd))) {
    fails.push({ file: ensureDockerd, detail: "does not export ensureDocker()" });
  }
  for (const f of ["scripts/bootstrap-init.mjs", "scripts/deploy.mjs"]) {
    // Comments are stripped: both files legitimately narrate "ensureDocker()
    // starts the daemon..." in prose, which must not stand in for a real call.
    if (exists(f) && !/\bensureDocker\s*\(/.test(stripComments(read(f)))) {
      fails.push({ file: f, detail: "never calls ensureDocker() - the Docker daemon may not be started before the first docker command" });
    }
  }

  // No .github/workflows scaffolding anywhere in scripts/ or templates/,
  // with exactly one exception: the dispatch-only branch-cleanup maintenance
  // workflow (clean-merged-branches.yml, CONTRACT.md §5; check 60 pins its
  // shape). No template ships that directory tree, and no script writes any
  // other file into it - the scan covers every string literal, not only
  // render() calls, so writeFileSync destinations are caught too.
  // skills/clean/SKILL.md's mention of a leftover build.yml as a deletion
  // candidate is prose about an older scaffold some project may still carry,
  // not a live write path in this repo, and is explicitly allowed.
  // scripts/rgpd-audit.mjs's own mention is a READ (fileExists check on a
  // scanned project, for GDPR data-flow reporting), not a write, and is
  // exempted the same way.
  for (const f of FILES) {
    if (f === "skills/clean/SKILL.md") continue;
    if (f.startsWith("templates/") && /\.github[\\/]workflows/i.test(f)) {
      fails.push({ file: f, detail: "a template ships a .github/workflows path - the direct build pipeline (CONTRACT.md §5) removed Actions from generated apps" });
    }
  }
  for (const f of MJS) {
    if (!f.startsWith("scripts/") || f === "scripts/rgpd-audit.mjs") continue;
    const code = stripComments(read(f));
    const literals = code.match(/["'`][^"'`\n]*\.github\/workflows[^"'`\n]*["'`]/g) ?? [];
    for (const lit of literals) {
      const inner = lit.slice(1, -1);
      // The bare directory (a mkdirSync target) writes no workflow file.
      if (inner === ".github/workflows" || inner === ".github/workflows/") continue;
      if (!inner.includes("clean-merged-branches.yml")) {
        fails.push({ file: f, detail: `references a .github/workflows path other than clean-merged-branches.yml (${inner}) - the direct build pipeline (CONTRACT.md §5) keeps Actions out of generated apps` });
      }
    }
  }

  return fails;
});

define("57", "Egress IP: web gates before any fetch, ip.me ask, token-authenticated smoke", () => {
  const fails = [];

  const bootstrap = "scripts/bootstrap-init.mjs";
  if (!exists(bootstrap)) return [{ file: bootstrap, detail: "missing" }];
  const src = read(bootstrap);

  const fnAt = src.indexOf("async function detectEgressIps(");
  if (fnAt < 0) {
    fails.push({ file: bootstrap, detail: "detectEgressIps() not found" });
  } else {
    const nextFnAt = src.indexOf("\nasync function", fnAt + 1);
    const body = src.slice(fnAt, nextFnAt > 0 ? nextFnAt : undefined);
    const gateAt = body.indexOf("isRemoteSandbox()");
    const fetchAt = body.indexOf("fetch(");
    if (gateAt < 0) {
      fails.push({ file: bootstrap, detail: "detectEgressIps() no longer checks isRemoteSandbox() - a web sandbox would probe ipify with its own, meaningless address" });
    } else if (fetchAt >= 0 && gateAt > fetchAt) {
      fails.push({ file: bootstrap, detail: "detectEgressIps() calls fetch() before checking isRemoteSandbox() - the web gate must come first" });
    }
  }

  const smokeAt = src.indexOf("async function smokeTest(");
  if (smokeAt < 0) {
    fails.push({ file: bootstrap, detail: "smokeTest() not found" });
  } else {
    const nextFnAt = src.indexOf("\nasync function", smokeAt + 1);
    const body = src.slice(smokeAt, nextFnAt > 0 ? nextFnAt : undefined);
    // The smoke test authenticates with ACCESS_BYPASS_TOKEN (CONTRACT.md §6),
    // so a 403 is a real problem in EVERY environment. The old model treated
    // a web-sandbox 403 as the expected success; asserting `no ok( after the
    // 403 branch` is what keeps that model from quietly coming back.
    for (const must of ["ACCESS_BYPASS_TOKEN", "x-baudrier-access-token"]) {
      if (!body.includes(must)) {
        fails.push({ file: bootstrap, detail: `smokeTest() no longer uses ${must} - it cannot pass the IP gate and a 403 becomes uninterpretable` });
      }
    }
    const status403At = body.indexOf("lastStatus === 403");
    if (status403At < 0) {
      fails.push({ file: bootstrap, detail: "smokeTest() no longer branches on lastStatus === 403 - a deterministic gate rejection would be retried and end inconclusive" });
    } else if (/\bok\(/.test(body.slice(status403At))) {
      fails.push({ file: bootstrap, detail: "smokeTest() treats a 403 as success again - with the token bypass, a 403 always means the bypass is broken, never an expected outcome" });
    }
  }

  const bootstrapSkill = "skills/bootstrap/SKILL.md";
  if (!exists(bootstrapSkill)) {
    fails.push({ file: bootstrapSkill, detail: "missing" });
  } else {
    const bSrc = read(bootstrapSkill);
    if (!/ip\.me/.test(bSrc)) fails.push({ file: bootstrapSkill, detail: "no ip.me ask - a restricted app on web has no way to get allowlisted" });
    if (!/ACCESS_ALLOWED_IPS/.test(bSrc)) fails.push({ file: bootstrapSkill, detail: "never mentions ACCESS_ALLOWED_IPS" });
  }

  return fails;
});

define("58", "README: domains, checkbox, setup script agree; no settings template", () => {
  const fails = [];

  const DOMAINS = [
    "api.scaleway.com",
    "rg.fr-par.scw.cloud",
    "s3.fr-par.scw.cloud",
    "logs.cockpit.fr-par.scw.cloud",
    "api.scaleway.ai",
    "registry-1.docker.io",
    "auth.docker.io",
    "production.cloudfront.docker.com",
    "docker.io",
    "dl-cdn.alpinelinux.org",
    "*.fnc.fr-par.scw.cloud",
    "www.googleapis.com",
    "api.indexnow.org",
  ];

  // The hardened Custom allowlist left the user-facing README (decision
  // 2026-08-08: one recommended setting, no menu) and lives in CONTRACT.md
  // §1 as the documentation of record - the live-verified domain list must
  // not silently evaporate from there.
  const contract = exists("CONTRACT.md") ? read("CONTRACT.md") : "";
  for (const d of DOMAINS) {
    if (!contract.includes(d)) fails.push({ file: "CONTRACT.md", detail: `missing the network-allowlist domain "${d}" - the hardened-option reference list lives in §1 now` });
  }
  if (!contract.includes("Also include default list of common package managers")) {
    fails.push({
      file: "CONTRACT.md",
      detail: 'does not name the "Also include default list of common package managers" checkbox - left unchecked, the custom list REPLACES the Trusted defaults and npm dies',
    });
  }

  // Single French README (decision 2026-08-08).
  if (!exists("README.md")) {
    fails.push({ file: "README.md", detail: "missing" });
  } else {
    const src = read("README.md");
    // Complet (Full) is the recommended level (decision 2026-08-06, live
    // experience: an incomplete Custom list breaks builds with
    // hard-to-read errors).
    if (!src.includes("Accès réseau : Complet")) {
      fails.push({ file: "README.md", detail: 'does not recommend "Accès réseau : Complet" - Full network access is the one recommended setting' });
    }
    if (!src.includes("scripts/setup-clis-web.sh")) {
      fails.push({ file: "README.md", detail: "does not reference scripts/setup-clis-web.sh as the environment Setup script" });
    }
    if (!/ip\.me/.test(src)) {
      fails.push({ file: "README.md", detail: "no ip.me troubleshooting entry for the 403-on-unpublished-app case" });
    }
    if (src.includes(".claude/settings.json")) {
      fails.push({ file: "README.md", detail: "instructs committing a .claude/settings.json - the setup script is the only plugin install path" });
    }
  }

  const setupScript = "scripts/setup-clis-web.sh";
  if (!exists(setupScript)) {
    fails.push({ file: setupScript, detail: "missing" });
  } else {
    const sSrc = read(setupScript);
    if (!sSrc.includes("claude plugin marketplace add")) {
      fails.push({
        file: setupScript,
        detail: 'missing "claude plugin marketplace add" - the settings.json plugin auto-install is half-broken on web (live-verified), this is the only path observed to work',
      });
    }
    if (!sSrc.includes("claude plugin install")) fails.push({ file: setupScript, detail: 'missing "claude plugin install"' });
    if (!sSrc.includes("NODE_USE_ENV_PROXY")) {
      fails.push({
        file: setupScript,
        detail: "no longer exports NODE_USE_ENV_PROXY=1 - node fetch() would leave the sandbox directly again, with a different egress identity than curl (CONTRACT.md §1, live-verified 2026-08-08)",
      });
    }
  }
  if (exists("skills/_preflight/SKILL.md") && !read("skills/_preflight/SKILL.md").includes("setup-clis-web.sh")) {
    fails.push({ file: "skills/_preflight/SKILL.md", detail: "never references setup-clis-web.sh - the web repair path is undocumented" });
  }

  // Decision (2026-08-06): no settings file ships with a generated app. The
  // setup script is the only plugin install path, and web auto-mode behavior
  // is observed live before any permissions.allow template comes back. A
  // reappearing template must revisit that decision explicitly, so its mere
  // existence fails here.
  const settingsFile = "templates/web/settings.json";
  if (exists(settingsFile)) {
    fails.push({
      file: settingsFile,
      detail: "exists - no settings file ships with a generated app (decision 2026-08-06); a settings template must not silently return",
    });
  }

  return fails;
});

define("59", "Commit hygiene: the commit-msg hook exists and session start installs it", () => {
  const fails = [];
  const hook = "scripts/git-hooks/commit-msg";
  if (!exists(hook)) return [{ file: hook, detail: "missing" }];
  const src = read(hook);
  if (!/Co-\[Aa\]uthored-\[Bb\]y: Claude /.test(src)) {
    fails.push({ file: hook, detail: "does not strip the Claude Co-Authored-By trailer" });
  }
  if (!src.includes("^Claude-Session: ")) {
    fails.push({ file: hook, detail: "does not strip the Claude-Session URL trailer" });
  }
  if (!src.includes("baudrier commit-msg hook")) {
    fails.push({ file: hook, detail: "missing the marker line - the installer would refuse to update its own hook" });
  }
  const installer = "tools/bootstrap-deps.mjs";
  if (exists(installer)) {
    const code = stripComments(read(installer));
    // The semicolon requires a call STATEMENT: the function definition alone
    // (`function installCommitMsgHook() {`) must not satisfy this.
    if (!code.includes("installCommitMsgHook();") || !code.includes("git-hooks")) {
      fails.push({ file: installer, detail: "never installs the commit-msg hook - ephemeral web VMs need it re-installed every session" });
    }
  }
  return fails;
});

define("60", "Branch cleanup: dispatch-only maintenance workflow ships and stays inert", () => {
  const fails = [];
  const tpl = "templates/deploy/clean-merged-branches.yml";
  if (!exists(tpl)) {
    return [{ file: tpl, detail: "missing - generated projects have no way to delete merged branches (a session cannot delete a remote ref, CONTRACT.md §5/§7)" }];
  }
  const src = read(tpl);
  if (!src.includes("workflow_dispatch")) {
    fails.push({ file: tpl, detail: "no workflow_dispatch trigger - the maintenance workflow must be dispatch-only" });
  }
  // The colon keeps `git push origin --delete` lines from matching.
  if (/^\s*(push|pull_request|schedule)\s*:/m.test(src)) {
    fails.push({ file: tpl, detail: "has an automatic trigger (push/pull_request/schedule) - the workflow must run only when the owner dispatches it" });
  }
  if (!src.includes("github.actor == github.repository_owner")) {
    fails.push({ file: tpl, detail: "missing the actor == repository_owner guard - anyone with a fork PR path could fire the cleanup" });
  }
  if (!/permissions:\s*\n\s*contents:\s*write/.test(src)) {
    fails.push({ file: tpl, detail: "missing permissions: contents: write - branch deletion needs it, and an implicit broad token is worse" });
  }
  if (src.includes("secrets.")) {
    fails.push({ file: tpl, detail: "references a repo secret - only the default GITHUB_TOKEN is allowed (CONTRACT.md §5)" });
  }
  if (!src.includes("merge-base --is-ancestor")) {
    fails.push({ file: tpl, detail: "no merge-base --is-ancestor guard - an unmerged branch could be deleted" });
  }

  for (const f of ["scripts/bootstrap-init.mjs", "scripts/add-cleanup-workflow.mjs"]) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "missing" });
      continue;
    }
    const code = stripComments(read(f));
    if (!code.includes('render("deploy/clean-merged-branches.yml"')) {
      fails.push({ file: f, detail: "does not render deploy/clean-merged-branches.yml" });
    }
    if (!code.includes(".github/workflows/clean-merged-branches.yml")) {
      fails.push({ file: f, detail: "does not write .github/workflows/clean-merged-branches.yml" });
    }
  }

  // The workflow must land in the initial commit.
  const boot = exists("scripts/bootstrap-init.mjs") ? stripComments(read("scripts/bootstrap-init.mjs")) : "";
  const wfAt = boot.indexOf('step("cleanupWorkflow"');
  const commitAt = boot.indexOf('step("commit"');
  if (wfAt < 0) {
    fails.push({ file: "scripts/bootstrap-init.mjs", detail: 'no step("cleanupWorkflow", ...) in the pipeline' });
  } else if (commitAt >= 0 && wfAt > commitAt) {
    fails.push({ file: "scripts/bootstrap-init.mjs", detail: "cleanupWorkflow runs after commit - the workflow misses the initial commit" });
  }

  return fails;
});

define("61", "Chokepoint: only the credentials module hands the operator key to an app", () => {
  const fails = [];

  // In Cas B the environment's key IS the application's credential. That is
  // safe only because the key is scoped to one Project. An organization key
  // taking the same path would put organization-wide rights inside a
  // container, so exactly one function may perform that hand-off, and it must
  // probe the key's reach before it does.
  const file = "scripts/scaleway/app-credentials.mjs";
  if (!exists(file)) return [{ file, detail: "missing - the credential chokepoint has nowhere to live" }];
  const src = stripComments(read(file));

  for (const fn of ["operatorKeyAsAppCredential", "credentialShape"]) {
    if (!new RegExp(`export (async )?function ${fn}\\s*\\(`).test(src)) {
      fails.push({ file, detail: `does not export ${fn}() - the skills have no sanctioned way to ask for the shape or the pair` });
    }
  }

  // The guard must run BEFORE the credentials are read, not beside it.
  const m = src.match(/export async function operatorKeyAsAppCredential\s*\([^)]*\)\s*\{/);
  if (!m) {
    fails.push({ file, detail: "operatorKeyAsAppCredential() not found as an async function - check needs updating to its new shape" });
  } else {
    let depth = 0;
    let body = src.slice(m.index);
    for (let i = m[0].length - 1; i < body.length; i++) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}" && --depth === 0) {
        body = body.slice(m[0].length - 1, i + 1);
        break;
      }
    }
    const probeAt = body.search(/probeOrgReach|orgReach/);
    const readAt = body.indexOf("loadCredentials");
    if (probeAt === -1) {
      fails.push({ file, detail: "operatorKeyAsAppCredential() never consults the org-reach probe - it would hand out an organization key" });
    } else if (readAt !== -1 && probeAt > readAt) {
      fails.push({ file, detail: "operatorKeyAsAppCredential() reads the credentials before probing - the refusal must come first" });
    }
  }

  // A permission verdict must not outlive the process. The Project-id cache in
  // _scw-auth.mjs is a session file on purpose, because an id is an
  // identifier; this is not the same thing and must stay in memory.
  if (/writeFileSync|tmpdir\s*\(/.test(src)) {
    fails.push({ file, detail: "writes to disk - the org-reach verdict must be memoized in-process only, never cached across runs" });
  }

  // process.env.SCW_SECRET_KEY belongs to loadCredentials() alone. Any other
  // reader is a second hand-off path that bypasses the probe above.
  for (const f of MJS) {
    if (f === "tools/verify.mjs" || f === "scripts/scaleway/_scw-auth.mjs") continue;
    if (/process\.env\.SCW_SECRET_KEY/.test(stripComments(read(f)))) {
      fails.push({ file: f, detail: "reads process.env.SCW_SECRET_KEY directly - it must go through loadCredentials(), and through operatorKeyAsAppCredential() to reach an app" });
    }
  }

  return fails;
});

define("62", "Shapes: every IAM-minting skill carries a Cas B branch", () => {
  const fails = [];

  // A skill that mints a scoped key covers Cas A only. Without a Cas B branch
  // beside it, a Project-scoped operator hits a permission_denied the skill
  // cannot act on, and the addon is simply unreachable for them.
  for (const f of SKILL_MDS) {
    const src = read(f);
    if (!/iam\.mjs["'`]?\s+create-key/.test(src)) continue;
    if (!/operatorKeyAsAppCredential|credentialShape/.test(src)) {
      fails.push({
        file: f,
        detail: "mints an IAM key with no Cas B branch - a Project-scoped key cannot mint, so this addon would be unreachable for that shape",
      });
    }
  }

  return fails;
});

define("63", "Auth self-hosted: trustHost pinned", () => {
  const fails = [];

  // Auth.js rejects the request host by default. Behind the Scaleway
  // Container proxy the app never sees its own public URL directly, so every
  // NextAuth() call must pin trustHost: true or sign-in fails closed.
  const TRUST_HOST_RE = /trustHost:\s*true/;
  for (const f of ["templates/auth/users/auth.ts", "templates/auth/admin/auth.ts", "templates/2fa/auth.ts"]) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "missing" });
      continue;
    }
    if (!TRUST_HOST_RE.test(read(f))) {
      fails.push({ file: f, detail: "NextAuth() does not set trustHost: true - Auth.js rejects the request host behind the Scaleway Container proxy" });
    }
  }
  return fails;
});

define("64", "AUTH_URL shadows APP_URL at the chokepoint", () => {
  const fails = [];

  // (a) buildContainerSecretMap() is the one path that assembles the full
  // secret map every container sync writes; a var missing here never reaches
  // a running container no matter what the rest of the harness declares.
  const containerFile = "scripts/scaleway/container.mjs";
  if (!exists(containerFile)) {
    fails.push({ file: containerFile, detail: "missing" });
  } else {
    const src = read(containerFile);
    const at = src.indexOf("export async function buildContainerSecretMap");
    const end = at >= 0 ? src.indexOf("\nexport ", at + 1) : -1;
    if (at < 0) {
      fails.push({ file: containerFile, detail: "buildContainerSecretMap is not exported" });
    } else {
      const body = stripComments(src.slice(at, end > 0 ? end : undefined));
      if (!body.includes("AUTH_URL")) {
        fails.push({ file: containerFile, detail: "buildContainerSecretMap() never sets AUTH_URL - Auth.js reads a stale host once APP_URL and AUTH_URL diverge" });
      }
    }
  }

  // (b) CONTRACT.md's env-var table is the canonical name list (see "Read
  // this first"); a missing row leaves the next reader with no way to learn
  // AUTH_URL exists.
  if (!/\|\s*`AUTH_URL`\s*\|/.test(read("CONTRACT.md"))) {
    fails.push({ file: "CONTRACT.md", detail: "env-var table has no `AUTH_URL` row" });
  }

  // (c) /delete-project reports any var absent from this list as "added by
  // the user"; a missing entry misreports AUTH_URL on every project deleted.
  const knownVars = "templates/delete-project/known-env-vars.json";
  if (!exists(knownVars)) {
    fails.push({ file: knownVars, detail: "missing" });
  } else {
    let parsed;
    try {
      parsed = JSON.parse(read(knownVars));
    } catch (e) {
      fails.push({ file: knownVars, detail: `invalid JSON: ${e.message}` });
    }
    if (parsed && !parsed.vars?.includes("AUTH_URL")) {
      fails.push({ file: knownVars, detail: "vars array does not include AUTH_URL" });
    }
  }

  return fails;
});

define("65", "Schema convention: plain pgTable, no creator helper", () => {
  const fails = [];
  const CREATOR_RE = /pgTableCreator|\bcreateTable\s*\(/;

  // (a) templates/ ships straight into a user's project, comments included,
  // so no trace of the retired creator-helper convention may survive there -
  // not even as an explanatory comment.
  for (const f of FILES.filter((x) => x.startsWith("templates/"))) {
    if (CREATOR_RE.test(read(f))) {
      fails.push({ file: f, detail: "references pgTableCreator/createTable() - the schema convention is plain pgTable, no creator helper" });
    }
  }

  // (b) the three setup scripts must patch onto plain pgTable, not the T3
  // pgTableCreator baseline. "pgTable" is a positive anchor: deleting the old
  // reference without wiring the new one still fails this check.
  for (const f of ["scripts/setup-auth-users.mjs", "scripts/setup-role.mjs", "scripts/setup-2fa.mjs"]) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "missing" });
      continue;
    }
    const code = stripComments(read(f));
    if (CREATOR_RE.test(code)) {
      fails.push({ file: f, detail: "references pgTableCreator/createTable() - the schema convention is plain pgTable, no creator helper" });
    }
    if (!code.includes("pgTable")) {
      fails.push({ file: f, detail: "never mentions pgTable - deleting the creator-helper reference is not enough, the script must patch onto plain pgTable" });
    }
  }

  // (c) skill prose must not teach the retired convention either. Anchored on
  // the bare word, not just a call site: a skill that tells the reader to
  // "keep the createTable import" is still teaching the wrong convention.
  for (const f of SKILL_MDS) {
    if (/\bcreateTable\b/.test(read(f))) {
      fails.push({ file: f, detail: "mentions createTable - the schema convention is plain pgTable, no creator helper" });
    }
  }

  return fails;
});

define("66", "Operator never opens a DB connection from a setup flow", () => {
  const fails = [];

  // (a) a setup script may explain, in a comment, why it does not shell out
  // to a live-DB command (scripts/setup-db.mjs does exactly this); only real
  // code doing so is a defect. Comments are stripped first, same convention
  // as check 11(c) and check 21.
  //
  // `migrate` joined `push`/`studio` here: it also opens a live connection
  // from wherever it runs, and CONTRACT.md's whole point is that only the
  // migration Serverless Job and the production container may ever do that -
  // never the operator's own machine, not even for the one-shot migrate path.
  const DB_CONN_RE = /drizzle-kit\s+(push|studio|migrate)\b/;
  for (const f of MJS.filter((x) => x.startsWith("scripts/"))) {
    const code = stripComments(read(f));
    if (DB_CONN_RE.test(code)) {
      fails.push({ file: f, detail: "runs drizzle-kit push/studio/migrate - a setup script must never open a live DB connection from the operator's machine" });
    }
    if (code.includes("~/server/db")) {
      fails.push({ file: f, detail: 'imports "~/server/db" - a setup script must never open a live DB connection from the operator\'s machine' });
    }
  }

  // (b) a setup script must never shell out to `tsx`/`ts-node` either: both
  // execute arbitrary project TypeScript directly, including any file that
  // imports "~/server/db" - the same live-connection risk (a) guards against,
  // one script hop away. `\b` after npx/pnpm/yarn plus the mandatory space
  // keeps this off ordinary ".tsx" filename strings, which this file's own
  // sources use freely (e.g. render() targets).
  //
  // Lock, not a fix: nothing in the tree runs `tsx`/`ts-node` this way today.
  // Proven against a synthetic string instead of a real failing site - see
  // CONTRACT.md-style discipline in check 72/73's header comments for the
  // same pattern applied to other locks.
  const TSX_RE = /\b(npx|pnpm|yarn)\s+(tsx|ts-node)\b/;
  for (const f of MJS.filter((x) => x.startsWith("scripts/"))) {
    const code = stripComments(read(f));
    if (TSX_RE.test(code)) {
      fails.push({ file: f, detail: "shells out to tsx/ts-node - a setup script must never execute project TypeScript directly from the operator's machine, the same live-DB risk as drizzle-kit push/studio/migrate" });
    }
  }

  // (c) skill prose must never instruct the reader to run these commands by
  // hand. A negation word right before the match is how this repo marks the
  // legitimate "never do this" explanation (same convention as check 24's
  // "gh auth login" gate and check 33c's drizzle-kit migrate window). The
  // window is checked before the match only: a negation belongs to the
  // sentence it introduces, not to an unrelated sentence that merely lands
  // nearby - a "never" 140 characters after the match, from a different
  // sentence, must not excuse the match.
  const PUSH_RE = /(npx\s+drizzle-kit\s+push|pnpm\s+db:push)/g;
  const NEG_RE = /\bnever\b|\bjamais\b|\bnot\b|ne\s+\S+\s+pas|don['’]t/i;
  const WINDOW = 60;
  const docs = FILES.filter((f) => f.startsWith("skills/") && /(^|\/)(SKILL\.md|DOC.*\.md)$/.test(f));
  for (const f of docs) {
    const src = read(f);
    for (const m of src.matchAll(PUSH_RE)) {
      const before = src.slice(Math.max(0, m.index - WINDOW), m.index);
      if (!NEG_RE.test(before)) {
        fails.push({
          file: f,
          detail: `"${m[0]}" at offset ${m.index} has no negation word in the ${WINDOW} characters before it - it reads as an instruction to run it, not a warning against it`,
        });
      }
    }
  }

  return fails;
});

define("67", "setup-security: the NextConfig JSDoc stays glued to its const", () => {
  const fails = [];
  const file = "scripts/setup-security.mjs";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "baudrier-verify-67-"));
  try {
    // A real T3 next.config.js: a top-of-file JSDoc, an env import, then the
    // `@type` JSDoc glued to `const config = {}`. This is the exact shape
    // setup-security.mjs patches on every fresh bootstrap.
    const fixture = [
      "/**",
      " * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation.",
      " */",
      'import "./src/env.js";',
      "",
      '/** @type {import("next").NextConfig} */',
      "const config = {};",
      "",
      "export default config;",
      "",
    ].join("\n");
    const configPath = path.join(tmp, "next.config.js");
    fs.writeFileSync(configPath, fixture);

    execFileSync(process.execPath, [path.join(ROOT, file)], { cwd: tmp, stdio: "pipe" });

    const patched = fs.readFileSync(configPath, "utf8");
    if (!/\/\*\*\s*@type\s*\{import\("next"\)\.NextConfig\}\s*\*\/\r?\n\s*const\s+\w+\s*=\s*\{/.test(patched)) {
      fails.push({
        file,
        detail: "patched next.config.js separates the @type JSDoc from its const - the JSDoc then types the injected CSP string and pnpm build fails with TS2559 inside the Docker build",
      });
    }
    if (patched.includes("},};")) {
      fails.push({
        file,
        detail: 'patched next.config.js is missing a newline before the original closer - "},};" lands on one line',
      });
    }
  } catch (e) {
    fails.push({ file, detail: e.message });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return fails;
});

define("68", "Setup scripts: schema-matching regexes are line-anchored", () => {
  const fails = [];
  const files = ["scripts/setup-auth-users.mjs", "scripts/setup-role.mjs", "scripts/setup-2fa.mjs"];

  // (a) a regex literal whose body targets a schema.ts shape must anchor with
  // ^ and carry the "m" flag - otherwise it also matches the same shape
  // quoted inside a // comment (setup-db.mjs's schema.ts starter is one big
  // comment for exactly this reason).
  const REGEX_LITERAL_RE = /\/((?:\\.|\[(?:\\.|[^\]\n])*\]|[^/\\\n])+)\/([a-z]*)/g;
  const SCHEMA_SHAPE_RE = /export const|pgTable\\?\(|pgEnum\\?\(|userRoleEnum\\?\(/;

  // (b) a `new RegExp(...)` built from a template that looks for an existing
  // import must anchor the same way - otherwise ensureImport merges names
  // into a commented-out import instead of adding a real one.
  const NEW_REGEXP_RE = /new\s+RegExp\(\s*`([^`]*)`\s*(?:,\s*([^)]*))?\)/g;
  const IMPORT_MARKER = "import\\\\s+"; // two literal backslashes: the raw source text of `\\s+` inside a template literal

  for (const f of files) {
    const code = stripComments(read(f));

    for (const m of code.matchAll(REGEX_LITERAL_RE)) {
      const [, body, flags] = m;
      if (!SCHEMA_SHAPE_RE.test(body)) continue;
      if (!(body.startsWith("^") && flags.includes("m"))) {
        fails.push({
          file: f,
          detail: `regex literal /${body}/${flags} matches a schema.ts shape but is not anchored with ^ and the "m" flag - it also matches the same shape quoted inside a comment`,
        });
      }
    }

    for (const m of code.matchAll(NEW_REGEXP_RE)) {
      const template = m[1];
      if (!template.includes(IMPORT_MARKER)) continue;
      const flagsArg = (m[2] ?? "").trim();
      if (!(template.startsWith("^") && flagsArg.includes("m"))) {
        fails.push({
          file: f,
          detail: "ensureImport's existing-import RegExp is not anchored with ^ and no \"m\" flags argument is passed - it merges names into a commented-out import instead of adding a real one",
        });
      }
    }
  }

  return fails;
});

define("69", "setup-role: auth.ts patches anchor on the sign-in block", () => {
  const fails = [];
  const file = "scripts/setup-role.mjs";
  const code = stripComments(read(file));

  // A lazy [\s\S]*? body ending at "return token;" bites the early return
  // inside the generated jwt callback's own if (user) block, mis-nesting the
  // insertion. Same class of defect for the session callback.
  if (code.includes("return token;\\s*\\}")) {
    fails.push({
      file,
      detail: 'the jwt-callback patch regex ends at "return token;\\s*\\}" - a lazy body also matches the early return inside the generated callback\'s if (user) block and mis-nests the insertion',
    });
  }
  if (code.includes("return session;\\s*\\}")) {
    fails.push({
      file,
      detail: 'the session-callback patch regex ends at "return session;\\s*\\}" - the same lazy-match defect as the jwt-callback patch',
    });
  }
  if (!code.includes("token.roles")) {
    fails.push({
      file,
      detail: "no reference to token.roles survives - deleting the patch is not a fix for the mis-nesting defect",
    });
  }
  if (!code.includes("if\\s*\\(user\\)")) {
    fails.push({
      file,
      detail: "no if (user) anchor (as regex-source text) guards the jwt-callback patch - the match must land after the early return, not swallow it with a lazy body",
    });
  }

  return fails;
});

define("70", "setup-role: admin page requires admin mode; JSON carries the tsc result", () => {
  const fails = [];
  const file = "scripts/setup-role.mjs";
  const code = stripComments(read(file));

  // templates/role/admin-router.ts statically imports isAdmin from
  // ~/server/auth, which only the admin auth mode writes - CREATE_ADMIN_PAGE
  // must never fire without checking the detected auth modes include "admin".
  const COUPLING_WINDOW = 200;
  let coupled = false;
  for (const m of code.matchAll(/CREATE_ADMIN_PAGE/g)) {
    const start = Math.max(0, m.index - COUPLING_WINDOW);
    const end = Math.min(code.length, m.index + COUPLING_WINDOW);
    if (/modes\.includes\(\s*["']admin["']\s*\)/.test(code.slice(start, end))) {
      coupled = true;
      break;
    }
  }
  if (!coupled) {
    fails.push({
      file,
      detail: 'CREATE_ADMIN_PAGE is never coupled with modes.includes("admin") - templates/role/admin-router.ts statically imports isAdmin from ~/server/auth, which only the admin auth mode writes',
    });
  }

  const jsonBlock = code.match(/JSON\.stringify\(\{[\s\S]*?\}\)/);
  if (!jsonBlock || !jsonBlock[0].includes("tscOk")) {
    fails.push({
      file,
      detail: "the final JSON.stringify({...}) result carries no tscOk field - success:true with a failed type check is a lie the calling skill cannot detect",
    });
  }

  const skillFile = "skills/add-role/SKILL.md";
  if (!read(skillFile).includes("tscOk")) {
    fails.push({
      file: skillFile,
      detail: "no mention of tscOk - the skill has no instruction to treat tscOk:false as work-not-done",
    });
  }

  return fails;
});

define("71", "scrypt: one cost everywhere, and it fits preset S", () => {
  const fails = [];

  // Raw read, not stripComments - the params are code, not prose.
  const SITES = [
    "templates/auth/users/password.ts",
    "templates/auth/admin/password.ts",
    "scripts/hash-password.mjs",
    "scripts/setup-2fa.mjs",
  ];
  const PARAMS_RE = /(?:SCRYPT_PARAMS|BACKUP_CODE_SCRYPT_PARAMS)\s*=\s*\{\s*N:\s*(\d+),\s*r:\s*(\d+),\s*p:\s*(\d+),\s*maxmem:\s*(\d+)\s*\*\s*1024\s*\*\s*1024/;

  const parsed = [];
  for (const f of SITES) {
    const m = read(f).match(PARAMS_RE);
    if (!m) {
      fails.push({ file: f, detail: "could not find a SCRYPT_PARAMS / BACKUP_CODE_SCRYPT_PARAMS literal with N/r/p/maxmem in the expected shape" });
      continue;
    }
    parsed.push({ file: f, N: +m[1], r: +m[2], p: +m[3], maxmemMiB: +m[4] });
  }

  if (parsed.length) {
    const [first, ...rest] = parsed;
    for (const p of rest) {
      if (p.N !== first.N || p.r !== first.r || p.p !== first.p) {
        fails.push({
          file: p.file,
          detail: `scrypt cost {N:${p.N},r:${p.r},p:${p.p}} does not match ${first.file}'s {N:${first.N},r:${first.r},p:${first.p}} - a mismatched cost means a hash minted at one site cannot be verified against the params assumed at another`,
        });
      }
    }
  }

  for (const p of parsed) {
    const workingSetBytes = 128 * p.N * p.r;
    const maxmemBytes = p.maxmemMiB * 1024 * 1024;
    if (workingSetBytes > maxmemBytes) {
      fails.push({
        file: p.file,
        detail: `128*N*r = ${Math.round(workingSetBytes / 1024 / 1024)} MiB exceeds maxmem (${p.maxmemMiB} MiB) - scrypt throws "memory limit exceeded"`,
      });
    }
  }

  const containerFile = "scripts/scaleway/container.mjs";
  const presetMatch = read(containerFile).match(
    /S:\s*Object\.freeze\(\{\s*cpuLimit:\s*\d+,\s*memoryLimit:\s*(\d+),\s*maxConcurrency:\s*(\d+)\s*\}\)/,
  );
  if (!presetMatch) {
    fails.push({ file: containerFile, detail: "could not find SCALE_PRESETS.S in the expected { cpuLimit, memoryLimit, maxConcurrency } shape" });
  } else {
    const memoryLimitMiB = +presetMatch[1];
    const maxConcurrency = +presetMatch[2];
    for (const p of parsed) {
      const workingSetBytes = 128 * p.N * p.r;
      const budgetBytes = maxConcurrency * workingSetBytes;
      const limitBytes = memoryLimitMiB * 1024 * 1024;
      if (budgetBytes > limitBytes) {
        fails.push({
          file: p.file,
          detail: `preset S allows ${maxConcurrency} concurrent requests × 128*N*r (${Math.round(workingSetBytes / 1024 / 1024)} MiB) = ${Math.round(budgetBytes / 1024 / 1024)} MiB, over the ${memoryLimitMiB} MiB container limit - an unauthenticated attacker can force this allocation by sending concurrent signin/backup-code attempts`,
        });
      }
    }
  }

  const contractFile = "CONTRACT.md";
  if (!/128\s*\*\s*N\s*\*\s*r/.test(read(contractFile))) {
    fails.push({
      file: contractFile,
      detail: "no mention of the 128*N*r scrypt working-set formula - the scrypt/preset-S coupling is documented nowhere",
    });
  }

  return fails;
});

define("72", "MATURE error is recovered, not fatal", () => {
  const fails = [];
  const bootstrap = "scripts/bootstrap-init.mjs";
  if (!exists(bootstrap)) return [{ file: bootstrap, detail: "missing" }];
  const src = stripComments(read(bootstrap));

  // pnpm 11's age floor (check 52) can reject the only version some
  // transitive dep resolves to - shadcn's internal `pnpm add` then fails with
  // ERR_PNPM_NO_MATURE_MATCHING_VERSION instead of installing. Nothing that
  // catches this code recovers from it today.
  if (!src.includes("ERR_PNPM_NO_MATURE_MATCHING_VERSION")) {
    fails.push({
      file: bootstrap,
      detail: "no reference to ERR_PNPM_NO_MATURE_MATCHING_VERSION - the age floor can make shadcn's own install unrecoverably fail",
    });
  }

  const recoverMatch = src.match(/(?:async\s+)?function\s+recoverFromImmatureLockfile\s*\(/);
  if (!recoverMatch) {
    fails.push({ file: bootstrap, detail: "recoverFromImmatureLockfile() not found" });
  } else {
    const fnAt = recoverMatch.index;
    const nextFnAt = src.indexOf("\nfunction ", fnAt + 1);
    const body = src.slice(fnAt, nextFnAt > 0 ? nextFnAt : undefined);
    if (!/\brmSync\b/.test(body)) {
      fails.push({
        file: bootstrap,
        detail: "recoverFromImmatureLockfile() never calls rmSync - it cannot delete the stale lockfile its name promises to remove",
      });
    }
    if (!body.includes("pnpm-lock.yaml")) {
      fails.push({ file: bootstrap, detail: "recoverFromImmatureLockfile() never mentions pnpm-lock.yaml - unclear what lockfile it recovers from" });
    }
  }

  const runShadcnMatch = src.match(/function runShadcn\s*\(/);
  if (!runShadcnMatch) {
    fails.push({ file: bootstrap, detail: "runShadcn() not found" });
  } else {
    const fnAt = runShadcnMatch.index;
    const nextFnAt = src.indexOf("\nfunction ", fnAt + 1);
    const body = src.slice(fnAt, nextFnAt > 0 ? nextFnAt : undefined);
    if (!body.includes("recoverFromImmatureLockfile")) {
      fails.push({
        file: bootstrap,
        detail: "runShadcn() never calls recoverFromImmatureLockfile() - an ERR_PNPM_NO_MATURE_MATCHING_VERSION failure inside shadcn's pnpm add still aborts bootstrap",
      });
    }
  }

  return fails;
});

define("73", "shadcn hygiene: no leftover prompt-bait, parents exist", () => {
  const fails = [];
  const bootstrap = "scripts/bootstrap-init.mjs";
  if (!exists(bootstrap)) return [{ file: bootstrap, detail: "missing" }];
  const src = stripComments(read(bootstrap));

  // shadcn v4's `init --defaults --yes` still prompts to overwrite an
  // existing components.json, and --yes does not answer that specific
  // prompt - a stale file from a prior attempt silently skips writing
  // src/lib/utils.ts. Clearing it before the FIRST init call removes the
  // prompt; clearing it again inside runShadcn() covers the retry path too.
  const initAt = src.indexOf("shadcn@latest init");
  const firstRm = src.match(/rmSync\([^;]*components\.json/);
  if (!firstRm || initAt < 0 || firstRm.index > initAt) {
    fails.push({
      file: bootstrap,
      detail: 'no rmSync(...components.json...) runs before "npx shadcn@latest init" - a stale components.json blocks the overwrite prompt that --yes does not answer',
    });
  }

  const runShadcnMatch = src.match(/function runShadcn\s*\(/);
  if (!runShadcnMatch) {
    fails.push({ file: bootstrap, detail: "runShadcn() not found" });
  } else {
    const fnAt = runShadcnMatch.index;
    const nextFnAt = src.indexOf("\nfunction ", fnAt + 1);
    const body = src.slice(fnAt, nextFnAt > 0 ? nextFnAt : undefined);
    if (!/rmSync\([^;]*components\.json/.test(body)) {
      fails.push({
        file: bootstrap,
        detail: "runShadcn() never removes components.json before a retry - a retried command hits the same unanswered overwrite prompt",
      });
    }
  }

  // src/lib/utils.ts and src/components/ui/link-button.tsx are written by
  // writeFileSync into directories create-t3-app + shadcn may not have
  // created yet; writeFileSync does not make parent directories itself.
  if (!/mkdirSync\([^;]*"src\/lib"/.test(src)) {
    fails.push({
      file: bootstrap,
      detail: 'no mkdirSync(...\"src/lib\"...) - writing src/lib/utils.ts fails with ENOENT when the scaffold never created src/lib',
    });
  }
  if (!/mkdirSync\([^;]*"src\/components\/ui"/.test(src)) {
    fails.push({
      file: bootstrap,
      detail: 'no mkdirSync(...\"src/components/ui\"...) - writing src/components/ui/link-button.tsx fails with ENOENT when the scaffold never created src/components/ui',
    });
  }

  return fails;
});

define("74", "pnpm resilience: executed fallback + headless purge", () => {
  const fails = [];
  const bootstrap = "scripts/bootstrap-init.mjs";
  if (!exists(bootstrap)) return [{ file: bootstrap, detail: "missing" }];
  const src = stripComments(read(bootstrap));

  // Anchored on `run(` so the existing warn() string that only tells the
  // user to run this by hand cannot satisfy the check - the fallback must
  // execute, not just get suggested to a non-technical operator.
  if (!/run\(\s*["']npm i -g pnpm@latest/.test(src)) {
    fails.push({
      file: bootstrap,
      detail: 'no run("npm i -g pnpm@latest...") - the too-old-pnpm path only warns the user to update it by hand and never runs the fallback itself',
    });
  }

  if (!src.includes("confirm-modules-purge=false")) {
    fails.push({
      file: bootstrap,
      detail: "the generated .npmrc never sets confirm-modules-purge=false - pnpm prompts to confirm a node_modules purge, which hangs forever with no TTY to answer it",
    });
  }

  return fails;
});

define("75", "Registry namespace: suffixed create, prefix discovery, conflict handled", () => {
  const fails = [];

  const registryFile = "scripts/scaleway/registry.mjs";
  if (!exists(registryFile)) {
    fails.push({ file: registryFile, detail: "missing" });
  } else {
    const src = stripComments(read(registryFile));
    if (!src.includes("findRegistryNamespace")) {
      fails.push({
        file: registryFile,
        detail: "no findRegistryNamespace() - nothing discovers an existing <slug>-<8 hex> namespace by prefix",
      });
    }
    if (!src.includes("registry_name_taken")) {
      fails.push({
        file: registryFile,
        detail: 'no "registry_name_taken" ScwError type - a create-time name conflict is not distinguished from any other failure',
      });
    }
    const ensureMatch = src.match(/export\s+async\s+function\s+ensureRegistryNamespace\s*\(/);
    if (!ensureMatch) {
      fails.push({ file: registryFile, detail: "ensureRegistryNamespace() not found" });
    } else {
      const fnAt = ensureMatch.index;
      const nextFnAt = src.indexOf("\nexport ", fnAt + 1);
      const body = src.slice(fnAt, nextFnAt > 0 ? nextFnAt : undefined);
      if (!/\bcatch\b/.test(body)) {
        fails.push({
          file: registryFile,
          detail: "ensureRegistryNamespace() has no catch - a createNamespace name conflict propagates as a raw SDK error instead of being rethrown as registry_name_taken",
        });
      }
    }
  }

  const deployFile = "scripts/deploy.mjs";
  if (!exists(deployFile)) {
    fails.push({ file: deployFile, detail: "missing" });
  } else if (!stripComments(read(deployFile)).includes("findRegistryNamespace")) {
    fails.push({
      file: deployFile,
      detail: "deploy.mjs never calls findRegistryNamespace() - a redeploy only knows the exact name it was given, not a namespace created under a random suffix",
    });
  }

  const skillFile = "skills/deploy/SKILL.md";
  if (!exists(skillFile)) {
    fails.push({ file: skillFile, detail: "missing" });
  } else if (!read(skillFile).includes("Registry namespace:")) {
    fails.push({
      file: skillFile,
      detail: 'no "Registry namespace:" section - the skill does not tell the operator how the suffixed namespace is found again',
    });
  }

  const bootstrapFile = "scripts/bootstrap-init.mjs";
  if (!exists(bootstrapFile)) {
    fails.push({ file: bootstrapFile, detail: "missing" });
  } else if (!stripComments(read(bootstrapFile)).includes("registry-namespace")) {
    fails.push({
      file: bootstrapFile,
      detail: 'no "registry-namespace" flag - bootstrap never records the suffixed namespace name it created',
    });
  }

  return fails;
});

define("76", "Collision guard: the checkout is not its own collision", () => {
  const fails = [];
  const script = "scripts/check-name-collision.mjs";
  if (!exists(script)) return [{ file: script, detail: "missing" }];

  // check-name-collision.mjs requires kebab-case, 2-50 chars (same
  // constraint bootstrap-init.mjs enforces). If this checkout's own folder
  // name does not fit that shape there is nothing to pin here - skip rather
  // than false-fail on an unrelated naming mismatch.
  const name = path.basename(ROOT);
  if (!/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(name)) {
    return fails;
  }

  // Blank the Scaleway credentials: fromScaleway() inside the script
  // catches any failure and soft-fails (sources.scaleway:false), so this
  // exercises only the filesystem-only sibling search, deterministically -
  // no live account state can change what this check sees.
  const result = spawnSync(
    process.execPath,
    [path.join(ROOT, script), "--name", name, "--parent-dir", path.dirname(ROOT)],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        SCW_ACCESS_KEY: "",
        SCW_SECRET_KEY: "",
        SCW_DEFAULT_ORGANIZATION_ID: "",
        SCW_DEFAULT_PROJECT_ID: "",
      },
    },
  );

  if (result.status !== 0) {
    fails.push({
      file: script,
      detail: `exited ${result.status} instead of 0: ${(result.stderr || "").trim().slice(0, 300)}`,
    });
    return fails;
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    fails.push({ file: script, detail: `stdout was not valid JSON: ${result.stdout.trim().slice(0, 300)}` });
    return fails;
  }

  // PARENT_DIR is this checkout's own parent directory, so the sibling
  // search (readdirSync(PARENT_DIR)) lists the checkout's own folder along
  // with any real siblings. Running the guard against its own name and
  // location must not report a collision with itself.
  if (parsed.status === "exact") {
    fails.push({
      file: script,
      detail: `--name ${name} --parent-dir ${path.dirname(ROOT)} reports status "exact" - the sibling search lists this checkout's own folder and the guard collides with itself`,
    });
  }

  return fails;
});

define("77", "cockpit query_range authenticates with X-Token only", () => {
  const fails = [];
  const file = "scripts/scaleway/cockpit.mjs";
  if (!exists(file)) return [{ file, detail: "missing" }];
  const src = stripComments(read(file));

  if (!src.includes("X-Token")) {
    fails.push({
      file,
      detail: 'no "X-Token" header - queryLogs does not authenticate the Loki request with the header Cockpit\'s gateway expects',
    });
  }

  if (/Authorization[^\n]*Bearer/.test(src)) {
    fails.push({
      file,
      detail: 'still sends an "Authorization: Bearer" header - Cockpit\'s Loki gateway does not accept it, and sending an extra unused header on every query is dead weight',
    });
  }

  const queryLogsMatch = src.match(/export\s+async\s+function\s+queryLogs\s*\(/);
  if (!queryLogsMatch) {
    fails.push({ file, detail: "queryLogs() not found" });
  } else {
    const fnAt = queryLogsMatch.index;
    const nextFnAt = src.indexOf("\nexport ", fnAt + 1);
    const body = src.slice(fnAt, nextFnAt > 0 ? nextFnAt : undefined);
    if (body.includes("scwFetch(")) {
      fails.push({
        file,
        detail: "queryLogs() still calls scwFetch() - CONTRACT.md's raw-fetch exception covers this hop only if it is a plain fetch with an explicit X-Token header, not the shared SDK wrapper",
      });
    }
  }

  return fails;
});

define("78", "Cas B: the DB path self-serves on SCW_DEFAULT_APPLICATION_ID", () => {
  const fails = [];

  // (a) the shared credential layer must know the variable name at all.
  const auth = "scripts/scaleway/_scw-auth.mjs";
  if (!exists(auth)) {
    fails.push({ file: auth, detail: "missing" });
  } else if (!stripComments(read(auth)).includes("SCW_DEFAULT_APPLICATION_ID")) {
    fails.push({
      file: auth,
      detail: "never references SCW_DEFAULT_APPLICATION_ID - Cas B's database path has no way to self-serve the IAM Application id without a getAPIKey read",
    });
  }

  // (b) devDbCredentials() must try SCW_DEFAULT_APPLICATION_ID before it ever
  // calls Iam.getAPIKey() - export-anchored slicing, the same convention
  // check 75/77 use for registry.mjs/cockpit.mjs.
  const appCreds = "scripts/scaleway/app-credentials.mjs";
  if (!exists(appCreds)) {
    fails.push({ file: appCreds, detail: "missing" });
  } else {
    const code = stripComments(read(appCreds));
    const fnMatch = code.match(/export\s+async\s+function\s+devDbCredentials\s*\(/);
    if (!fnMatch) {
      fails.push({ file: appCreds, detail: "devDbCredentials() not found" });
    } else {
      const fnAt = fnMatch.index;
      const nextExportAt = code.indexOf("\nexport ", fnAt + 1);
      const body = code.slice(fnAt, nextExportAt > 0 ? nextExportAt : undefined);
      const appIdx = body.indexOf("applicationId");
      const getIdx = body.indexOf("getAPIKey");
      if (!(appIdx >= 0 && getIdx >= 0 && appIdx < getIdx)) {
        fails.push({
          file: appCreds,
          detail: "devDbCredentials() reads applicationId no earlier than the getAPIKey() call - a Project-scoped key with SCW_DEFAULT_APPLICATION_ID set should self-serve the Application id and skip the IAM read entirely",
        });
      }
    }
    if (!code.includes("needs_application_id")) {
      fails.push({
        file: appCreds,
        detail: 'no "needs_application_id" typed error - devDbCredentials() has no dedicated escalation for the case neither SCW_DEFAULT_APPLICATION_ID nor a resolvable IAM principal is available, so a bare catch surfaces a raw SDK error instead',
      });
    }
  }

  // (c) setup-db.mjs must be able to recognise the same typed error and give
  // the operator a message that names the fix.
  const setupDb = "scripts/setup-db.mjs";
  if (!exists(setupDb)) {
    fails.push({ file: setupDb, detail: "missing" });
  } else if (!stripComments(read(setupDb)).includes("needs_application_id")) {
    fails.push({
      file: setupDb,
      detail: 'never references "needs_application_id" - the Cas B database path has no recovery message for the case devDbCredentials() cannot resolve an Application id',
    });
  }

  // (d) CONTRACT.md's env-var table must document the new operator variable.
  if (!exists("CONTRACT.md")) {
    fails.push({ file: "CONTRACT.md", detail: "missing" });
  } else if (!/\|\s*`SCW_DEFAULT_APPLICATION_ID`\s*\|/.test(read("CONTRACT.md"))) {
    fails.push({ file: "CONTRACT.md", detail: "env-var table has no SCW_DEFAULT_APPLICATION_ID row - Cas B's self-serve path is undocumented" });
  }

  // (e) the admin-facing setup guide must tell the administrator to hand the
  // variable to the member.
  const adminDoc = "docs/ADMIN-SCALEWAY.md";
  if (!exists(adminDoc)) {
    fails.push({ file: adminDoc, detail: "missing" });
  } else if (!read(adminDoc).includes("SCW_DEFAULT_APPLICATION_ID")) {
    fails.push({ file: adminDoc, detail: "never mentions SCW_DEFAULT_APPLICATION_ID - the administrator has no instruction to hand it to a Cas B member" });
  }

  // (f) the preflight env-presence check is the operator's first signal that
  // something is missing. Its Step 0 list must include SCW_DEFAULT_PROJECT_ID,
  // the one variable CONTRACT.md §2 calls mandatory for Cas B, or a member
  // missing it sails past Step 0 with no warning. Scoped to the actual
  // `for (const k of [...])` list rather than a whole-file search: the file
  // already names SCW_DEFAULT_PROJECT_ID elsewhere (the Cas B prose further
  // down), so a whole-file check would pass today for the wrong reason.
  const preflight = "skills/_preflight/SKILL.md";
  if (!exists(preflight)) {
    fails.push({ file: preflight, detail: "missing" });
  } else {
    const src = read(preflight);
    const listMatch = src.match(/for \(const k of \[([^\]]*)\]\)/);
    if (!listMatch) {
      fails.push({ file: preflight, detail: "no `for (const k of [...])` env-presence list found - cannot confirm which vars Step 0 checks" });
    } else if (!listMatch[1].includes("SCW_DEFAULT_PROJECT_ID")) {
      fails.push({
        file: preflight,
        detail: "the Step 0 env-presence list omits SCW_DEFAULT_PROJECT_ID - Cas B calls it mandatory (CONTRACT.md §2), but a member missing it gets no warning here",
      });
    }
  }

  return fails;
});

define("79", "sdb ensure: the CLI honors the cost defaults and applies explicit bounds", () => {
  const fails = [];
  const sdb = "scripts/scaleway/sdb.mjs";
  if (!exists(sdb)) return [{ file: sdb, detail: "missing" }];
  const code = stripComments(read(sdb));

  // Anchor on the CLI switch's own `case "ensure"` label, not on the function
  // definitions above it - the CLI is what an "/add-db"-style call actually
  // runs, and it can drift from ensureDatabase()'s own defaults independently.
  const caseAt = code.indexOf('case "ensure"');
  if (caseAt < 0) {
    return [{ file: sdb, detail: 'no `case "ensure"` found in the CLI switch' }];
  }
  const nextCaseAt = code.indexOf('case "get"', caseAt);
  const body = code.slice(caseAt, nextCaseAt > 0 ? nextCaseAt : undefined);

  if (!body.includes("DB_CPU_MIN_DEFAULT")) {
    fails.push({
      file: sdb,
      detail: '`ensure` never references DB_CPU_MIN_DEFAULT - the CLI carries its own copy of the cost floor instead of the one constant every other caller shares',
    });
  }
  if (!body.includes("DB_CPU_MAX_DEFAULT")) {
    fails.push({
      file: sdb,
      detail: '`ensure` never references DB_CPU_MAX_DEFAULT - the CLI carries its own copy of the cost cap instead of the one constant every other caller shares',
    });
  }
  if (/flag\("max-cpu",\s*15\)/.test(body)) {
    fails.push({
      file: sdb,
      detail: '`ensure` still defaults --max-cpu to the literal 15 - the API\'s own default, three times the harness cap DB_CPU_MAX_DEFAULT exists to enforce',
    });
  }
  if (!body.includes("setDatabaseCpuBounds")) {
    fails.push({
      file: sdb,
      detail: "`ensure` never calls setDatabaseCpuBounds - re-running it against an EXISTING database cannot apply an explicit --min-cpu/--max-cpu, since ensureDatabase()'s create path is a no-op once the database already exists",
    });
  }

  return fails;
});

define("80", "Every /add-* setup script reports tscOk", () => {
  const fails = [];

  for (const f of ["scripts/setup-auth-users.mjs", "scripts/setup-2fa.mjs", "scripts/setup-role.mjs"]) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "missing" });
      continue;
    }
    const code = stripComments(read(f));
    // The LAST JSON.stringify({...}) block, not the first: setup-2fa.mjs
    // builds an unrelated intermediate payload earlier in the file, and only
    // the final block is the one printed to stdout as the run's handoff.
    const at = code.lastIndexOf("JSON.stringify({");
    if (at < 0) {
      fails.push({ file: f, detail: "no final JSON.stringify({...}) handoff block found" });
      continue;
    }
    const body = code.slice(at);
    if (!body.includes("tscOk")) {
      fails.push({
        file: f,
        detail: "the final JSON.stringify block does not report tscOk - Claude has no signal the generated code still typechecks after this script's edits",
      });
    }
    if (!body.includes("warnings")) {
      fails.push({ file: f, detail: "the final JSON.stringify block does not report warnings" });
    }
  }

  for (const skill of ["skills/_setup-auth-users/SKILL.md", "skills/_setup-2fa-admin/SKILL.md"]) {
    if (!exists(skill)) {
      fails.push({ file: skill, detail: "missing" });
    } else if (!read(skill).includes("tscOk")) {
      fails.push({ file: skill, detail: 'never mentions "tscOk" - the skill does not tell Claude to check the setup script\'s typecheck result' });
    }
  }

  return fails;
});

define("81", "Gate parity: the Caddyfile/entrypoint match proxy.ts's invariants", () => {
  const fails = [];
  const proxyFile = "templates/deploy/proxy.ts";
  const caddyFile = "templates/landing/Caddyfile";
  const entrypointFile = "templates/landing/docker-entrypoint.sh";
  if (!exists(proxyFile)) return [{ file: proxyFile, detail: "missing" }];
  const proxySrc = read(proxyFile);

  // Extract the literals from proxy.ts itself - the landing gate must never
  // hardcode a copy that can silently drift from the canonical values.
  const healthzMatch = proxySrc.match(/const HEALTHZ_PATH\s*=\s*"([^"]+)"/);
  const acmeMatch = proxySrc.match(/ALWAYS_ALLOWED_PREFIXES\s*=\s*\["([^"]+)"\]/);
  const tokenLenMatch = proxySrc.match(/const MIN_BYPASS_TOKEN_LENGTH\s*=\s*(\d+)/);
  if (!healthzMatch) fails.push({ file: proxyFile, detail: "could not extract HEALTHZ_PATH - gate parity cannot be checked" });
  if (!acmeMatch) fails.push({ file: proxyFile, detail: "could not extract the ACME prefix literal - gate parity cannot be checked" });
  if (!tokenLenMatch) fails.push({ file: proxyFile, detail: "could not extract MIN_BYPASS_TOKEN_LENGTH - gate parity cannot be checked" });
  const healthzPath = healthzMatch?.[1];
  const acmePrefix = acmeMatch?.[1];
  const minTokenLen = tokenLenMatch?.[1];

  if (!exists(caddyFile)) {
    fails.push({ file: caddyFile, detail: "missing" });
  } else {
    const caddySrc = read(caddyFile);
    if (healthzPath && !caddySrc.includes(`handle ${healthzPath} {`)) {
      fails.push({ file: caddyFile, detail: `no "handle ${healthzPath} {" block - must match proxy.ts's HEALTHZ_PATH literal exactly` });
    }
    if (!/"ok":true/.test(caddySrc)) {
      fails.push({ file: caddyFile, detail: 'the healthz handler does not respond {"ok":true} 200' });
    }
    if (acmePrefix && !caddySrc.includes(acmePrefix)) {
      fails.push({ file: caddyFile, detail: `does not exempt "${acmePrefix}" - must match proxy.ts's ALWAYS_ALLOWED_PREFIXES literal` });
    }
    if (!/trusted_proxies/.test(caddySrc)) {
      fails.push({ file: caddyFile, detail: "missing trusted_proxies - Caddy would not trust X-Forwarded-For at all without it" });
    }
    if (!/client_ip_headers\s+X-Forwarded-For/.test(caddySrc)) {
      fails.push({ file: caddyFile, detail: "missing client_ip_headers X-Forwarded-For - parity with proxy.ts's TRUSTED_HOP resolver" });
    }

    // M5: the gate import's POSITION matters as much as its presence - below
    // the catch-all (or outside the route {} block entirely) opens the site
    // to the internet while every other assertion here still passes.
    const routeAt = caddySrc.indexOf("route {");
    const healthzHandleAt = healthzPath ? caddySrc.indexOf(`handle ${healthzPath} {`) : -1;
    const importAt = caddySrc.indexOf("import /etc/caddy/gate.caddy");
    // The bare catch-all is "handle {" with nothing between "handle" and the
    // brace - "handle /api/healthz {" and "handle /.well-known/... {" both
    // have a path token there, so this substring finds only the catch-all.
    const catchAllAt = caddySrc.indexOf("handle {");
    if (importAt < 0) {
      fails.push({ file: caddyFile, detail: 'no "import /etc/caddy/gate.caddy" found - the gate is not wired into the route at all' });
    } else {
      if (routeAt < 0 || importAt < routeAt) {
        fails.push({ file: caddyFile, detail: "the gate import is not inside the route {} block" });
      }
      if (healthzHandleAt >= 0 && importAt < healthzHandleAt) {
        fails.push({ file: caddyFile, detail: "the gate import sits before the /api/healthz handle - healthz must be exempt from the gate" });
      }
      if (catchAllAt >= 0 && importAt > catchAllAt) {
        fails.push({ file: caddyFile, detail: "the gate import sits after the catch-all handle - the site would be reachable before the gate ever runs" });
      }
    }
  }

  if (!exists(entrypointFile)) {
    fails.push({ file: entrypointFile, detail: "missing" });
  } else {
    const epSrcRaw = read(entrypointFile);
    // M4: a comment can name every literal these assertions look for (this
    // file's own header comment quotes {$ACCESS_BYPASS_TOKEN} to explain the
    // invariant) - strip comment lines first so prose alone can never
    // satisfy an assertion the real code must carry out.
    const epSrc = epSrcRaw
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    if (!/ACCESS_RESTRICTED:-\}"\s*=\s*"false"/.test(epSrc)) {
      fails.push({
        file: entrypointFile,
        detail: 'the gate does not open on the literal ACCESS_RESTRICTED = "false" test - must match proxy.ts\'s fail-closed condition',
      });
    }
    for (const bad of [/!=\s*"true"/, /!=\s*'true'/, /!=\s*true\b/]) {
      if (bad.test(epSrc)) {
        fails.push({
          file: entrypointFile,
          detail: `fails OPEN: found a "${bad.source}" construction - an unset/garbage ACCESS_RESTRICTED must stay restricted, never checked against the "open" literal`,
        });
      }
    }
    if (minTokenLen && !epSrc.includes(`-ge ${minTokenLen}`)) {
      fails.push({ file: entrypointFile, detail: `token-length guard does not match proxy.ts's MIN_BYPASS_TOKEN_LENGTH (${minTokenLen})` });
    }
    if (!epSrc.includes("x-baudrier-access-token")) {
      fails.push({ file: entrypointFile, detail: "missing the x-baudrier-access-token header name - must match proxy.ts exactly" });
    }
    if (!epSrc.includes("{$ACCESS_BYPASS_TOKEN}")) {
      fails.push({
        file: entrypointFile,
        detail: "missing the literal {$ACCESS_BYPASS_TOKEN} placeholder - the token must resolve at Caddy config load, never be interpolated into the written gate file",
      });
    }
    // The placeholder must sit inside SINGLE quotes: sh leaves `$` literal
    // there, but expands it inside double quotes - a single-to-double-quote
    // regression on this assignment would write the real token value into
    // gate.caddy instead of the placeholder Caddy resolves at config load.
    if (!/bypass_line='[^']*\{\$ACCESS_BYPASS_TOKEN\}[^']*'/.test(epSrc)) {
      fails.push({
        file: entrypointFile,
        detail: "bypass_line is not assigned with {$ACCESS_BYPASS_TOKEN} inside single quotes - double quotes would let sh expand the real token into gate.caddy",
      });
    }
    // The secret must never touch disk as its own value: every line naming the
    // bypass header must reference the placeholder, not a shell expansion of
    // the token itself.
    for (const line of epSrc.split("\n")) {
      if (line.includes("x-baudrier-access-token") && /\$\{?token\}?/.test(line) && !line.includes("{$ACCESS_BYPASS_TOKEN}")) {
        fails.push({ file: entrypointFile, detail: `interpolates the token value into the gate file instead of the {$ACCESS_BYPASS_TOKEN} placeholder: "${line.trim()}"` });
      }
    }
    // Neither allow source configured -> unconditional 403, never an open gate.
    if (!/-z\s+"\$ip_line"\s*\]\s*&&\s*\[\s*-z\s+"\$bypass_line"/.test(epSrc)) {
      fails.push({ file: entrypointFile, detail: "no combined empty-ip-and-empty-bypass branch found - the fallback when neither allow source exists must be explicit" });
    } else {
      const branchAt = epSrc.search(/-z\s+"\$ip_line"\s*\]\s*&&\s*\[\s*-z\s+"\$bypass_line"/);
      const branchBody = epSrc.slice(branchAt, branchAt + 300);
      if (!/403/.test(branchBody)) {
        fails.push({ file: entrypointFile, detail: "the no-allow-source branch does not respond 403 - it must fail closed, never fail open" });
      }
    }
  }

  return fails;
});

define("82", "Landing image shape: Dockerfile/Caddyfile/.dockerignore invariants", () => {
  const fails = [];
  const dockerfile = "templates/landing/Dockerfile";
  if (!exists(dockerfile)) return [{ file: dockerfile, detail: "missing" }];
  const src = read(dockerfile);

  if (!/FROM node:24-alpine/.test(src)) fails.push({ file: dockerfile, detail: "does not pin node:24-alpine" });
  if (!/FROM caddy:2-alpine/.test(src)) fails.push({ file: dockerfile, detail: "does not pin caddy:2-alpine" });
  if (!/amd64/i.test(src)) fails.push({ file: dockerfile, detail: "missing the amd64 platform comment (parity with templates/deploy/Dockerfile)" });
  if (!/COPY --chmod=755 docker-entrypoint\.sh/.test(src)) {
    fails.push({ file: dockerfile, detail: "does not COPY --chmod=755 docker-entrypoint.sh - a fresh checkout does not guarantee the executable bit" });
  }
  if (!/CMD\s*\[\s*"\/docker-entrypoint\.sh"\s*\]/.test(src)) {
    fails.push({ file: dockerfile, detail: 'CMD is not the exact exec-form CMD ["/docker-entrypoint.sh"]' });
  }
  if (!/EXPOSE\s+8080/.test(src)) fails.push({ file: dockerfile, detail: "missing EXPOSE 8080" });

  // The CA-trust block belongs in both network-active node stages (deps,
  // builder) and must be absent from the caddy runner stage, which makes no
  // outbound HTTPS call of its own (Caddyfile's auto_https is off).
  const runnerAt = src.search(/FROM caddy:2-alpine/);
  if (runnerAt < 0) {
    fails.push({ file: dockerfile, detail: "no caddy:2-alpine runner stage found - cannot check CA-block placement" });
  } else {
    const nodeStagesSrc = src.slice(0, runnerAt);
    const runnerSrc = src.slice(runnerAt);
    const nodeStageCount = (nodeStagesSrc.match(/FROM node:24-alpine/g) || []).length;
    const caBlockCountInNodeStages = (nodeStagesSrc.match(/proxy-ca\.crt/g) || []).length;
    if (nodeStageCount < 2) {
      fails.push({ file: dockerfile, detail: `expected 2 node:24-alpine stages (deps, builder), found ${nodeStageCount}` });
    } else if (caBlockCountInNodeStages < 2) {
      fails.push({ file: dockerfile, detail: "proxy-ca.crt CA-trust block is missing from one or both node stages - apk/corepack/pnpm fail under the web egress proxy without it" });
    }
    if (/proxy-ca\.crt/.test(runnerSrc)) {
      fails.push({ file: dockerfile, detail: "the caddy runner stage carries the proxy-ca.crt CA block - it makes no outbound HTTPS call and must not inherit it" });
    }

    // The runner must not run as root: docker-entrypoint.sh writes
    // /etc/caddy/gate.caddy at container start, so USER must switch before
    // CMD, to a real non-root user.
    const userMatch = runnerSrc.match(/^USER\s+(\S+)/m);
    const cmdAt = runnerSrc.search(/CMD\s*\[/);
    if (!userMatch) {
      fails.push({ file: dockerfile, detail: "runner stage has no USER directive - the container runs as root" });
    } else {
      if (userMatch[1] === "root" || userMatch[1] === "0") {
        fails.push({ file: dockerfile, detail: `runner stage USER is "${userMatch[1]}" - must switch to a non-root user` });
      }
      if (cmdAt >= 0 && runnerSrc.indexOf(userMatch[0]) > cmdAt) {
        fails.push({ file: dockerfile, detail: "USER directive comes after CMD - must switch user before CMD runs" });
      }
    }
  }

  const caddyFile = "templates/landing/Caddyfile";
  if (!exists(caddyFile)) {
    fails.push({ file: caddyFile, detail: "missing" });
  } else if (!/:8080\s*\{/.test(read(caddyFile))) {
    fails.push({ file: caddyFile, detail: "does not listen on :8080 - must match the Dockerfile's EXPOSE 8080" });
  }

  // No migration tooling under a static site's image - a vitrine has no
  // database and the migrate.mjs runner must never ship here (CONTRACT.md §1).
  for (const f of FILES.filter((x) => x.startsWith("templates/landing/"))) {
    let s;
    try {
      s = read(f);
    } catch {
      continue;
    }
    if (/migrate/i.test(s)) {
      fails.push({ file: f, detail: 'contains the token "migrate" - a vitrine has no database and must ship no migration tooling' });
    }
  }

  const dockerignore = "templates/landing/.dockerignore";
  if (!exists(dockerignore)) {
    fails.push({ file: dockerignore, detail: "missing" });
  } else {
    const diSrc = read(dockerignore);
    for (const artifact of ["proxy-ca.crt", "Caddyfile", "docker-entrypoint.sh"]) {
      if (diSrc.split("\n").some((l) => l.trim() === artifact)) {
        fails.push({ file: dockerignore, detail: `excludes "${artifact}" - this deploy artifact must reach the build context` });
      }
    }
  }

  return fails;
});

// Hard-coded per CONTRACT.md/the plan's decision (2026-08-13): a future
// unclassified skill must fail this check loudly rather than silently pass
// through an unowned skill with no gate and no support.
const GATE_SUPPORTED_SKILLS = [
  "deploy", "publish", "unpublish", "add-domain", "costs", "save-project",
  "delete-project", "add-analytics", "add-dark-mode", "seo", "seo-perf",
  "geo", "rotate-secret", "scale", "gsc",
];
const GATE_REFUSING_SKILLS = [
  "add-2fa", "add-agent", "add-agent-dashboard", "add-auth", "add-automation",
  "add-cron", "add-db", "add-email", "add-map", "add-notification-center",
  "add-push-notification", "add-pwa", "add-role", "add-routine", "add-storage",
  "add-workflow", "clean", "eco-audit", "rgpd-audit", "security",
];
const GATE_NON_PROJECT_SKILLS = ["bootstrap", "prof", "spec"];
// The mirror gate: these two refuse an APPLICATION instead of a vitrine (the
// vitrine blog, plan section 6) - same PROJECT_TYPE marker, opposite value,
// opposite sentence.
const GATE_LANDING_ONLY_SKILLS = ["add-blog", "blogpost"];

define("83", "Gate coverage: every public skill is supported, refusing, or non-project", () => {
  const fails = [];
  const supported = new Set(GATE_SUPPORTED_SKILLS);
  const refusing = new Set(GATE_REFUSING_SKILLS);
  const nonProject = new Set(GATE_NON_PROJECT_SKILLS);
  const landingOnly = new Set(GATE_LANDING_ONLY_SKILLS);

  const publicSkills = SKILL_DIRS.filter((d) => !d.startsWith("_") && exists(`skills/${d}/DOC.md`));

  for (const dir of publicSkills) {
    const memberships = [supported.has(dir), refusing.has(dir), nonProject.has(dir), landingOnly.has(dir)].filter(Boolean).length;
    if (memberships === 0) {
      fails.push({ file: `skills/${dir}`, detail: "not classified in any of SUPPORTED/REFUSING/NON_PROJECT/LANDING_ONLY - a future skill must be added to one list explicitly" });
    } else if (memberships > 1) {
      fails.push({ file: `skills/${dir}`, detail: "classified in more than one of SUPPORTED/REFUSING/NON_PROJECT/LANDING_ONLY" });
    }
  }
  const publicSet = new Set(publicSkills);
  for (const [label, list] of [["SUPPORTED", GATE_SUPPORTED_SKILLS], ["REFUSING", GATE_REFUSING_SKILLS], ["NON_PROJECT", GATE_NON_PROJECT_SKILLS], ["LANDING_ONLY", GATE_LANDING_ONLY_SKILLS]]) {
    for (const dir of list) {
      if (!publicSet.has(dir)) fails.push({ file: `skills/${dir}`, detail: `listed in ${label} but is not a public skill directory (no DOC.md, or directory missing)` });
    }
  }

  for (const dir of GATE_REFUSING_SKILLS) {
    const f = `skills/${dir}/SKILL.md`;
    if (!exists(f)) continue;
    if (!read(f).includes("PROJECT_TYPE=landing")) {
      fails.push({ file: f, detail: 'refusing skill has no "PROJECT_TYPE=landing" marker - the shared refusal gate is not wired in' });
    }
  }

  const REFUSAL_SENTENCE = "n’est pas disponible pour un site vitrine";
  const APP_REFUSAL_SENTENCE = "n’est pas disponible pour une application";
  for (const dir of GATE_SUPPORTED_SKILLS) {
    const f = `skills/${dir}/SKILL.md`;
    if (exists(f) && read(f).includes(REFUSAL_SENTENCE)) {
      fails.push({ file: f, detail: "a SUPPORTED skill carries the French refusal sentence - it must actually support a vitrine, not refuse it" });
    }
    if (exists(f) && read(f).includes(APP_REFUSAL_SENTENCE)) {
      fails.push({ file: f, detail: "a SUPPORTED skill carries the mirrored application-refusal sentence - it must actually support both project types, not refuse either" });
    }
  }
  for (const dir of GATE_REFUSING_SKILLS) {
    const f = `skills/${dir}/SKILL.md`;
    if (exists(f) && !read(f).includes(REFUSAL_SENTENCE)) {
      fails.push({ file: f, detail: "a REFUSING skill has no French refusal sentence - PROJECT_TYPE=landing is wired but the operator would see no explanation" });
    }
    if (exists(f) && read(f).includes(APP_REFUSAL_SENTENCE)) {
      fails.push({ file: f, detail: "a REFUSING (vitrine-refusing) skill also carries the mirrored application-refusal sentence - it must refuse exactly one project type" });
    }
  }

  for (const dir of GATE_LANDING_ONLY_SKILLS) {
    const f = `skills/${dir}/SKILL.md`;
    if (!exists(f)) continue;
    const s = read(f);
    if (!s.includes("PROJECT_TYPE=application")) {
      fails.push({ file: f, detail: 'landing-only skill has no "PROJECT_TYPE=application" marker - the mirrored refusal gate is not wired in' });
    }
    if (!s.includes(APP_REFUSAL_SENTENCE)) {
      fails.push({ file: f, detail: "landing-only skill has no French application-refusal sentence - PROJECT_TYPE=application is wired but the operator would see no explanation" });
    }
    if (s.includes(REFUSAL_SENTENCE)) {
      fails.push({ file: f, detail: "a landing-only skill carries the vitrine refusal sentence - it must refuse an application, not a vitrine" });
    }
  }

  const detectFile = "skills/_detect-project-root/SKILL.md";
  if (!exists(detectFile)) {
    fails.push({ file: detectFile, detail: "missing" });
  } else {
    const s = read(detectFile);
    if (!s.includes("PROJECT_TYPE")) fails.push({ file: detectFile, detail: "does not mention PROJECT_TYPE" });
    if (!s.includes("scripts/_stack.mjs")) fails.push({ file: detectFile, detail: "does not mention scripts/_stack.mjs" });
  }

  return fails;
});

define("84", "Landing pipeline invariants: step order, no DB seed, container params", () => {
  const fails = [];

  const bootstrapFile = "scripts/bootstrap-init.mjs";
  if (!exists(bootstrapFile)) {
    fails.push({ file: bootstrapFile, detail: "missing" });
  } else {
    const src = read(bootstrapFile);
    const stepsAt = src.indexOf("const LANDING_STEPS");
    if (stepsAt < 0) {
      fails.push({ file: bootstrapFile, detail: "LANDING_STEPS is not defined" });
    } else {
      const stepsEnd = src.indexOf("];", stepsAt);
      const stepsBlock = src.slice(stepsAt, stepsEnd > 0 ? stepsEnd : undefined);
      if (!/"scaffoldLanding"/.test(stepsBlock)) fails.push({ file: bootstrapFile, detail: "LANDING_STEPS does not include scaffoldLanding" });
      const buildAt = stepsBlock.indexOf('"dockerBuildPush"');
      const containerAt = stepsBlock.indexOf('"scwContainer"');
      if (buildAt < 0) fails.push({ file: bootstrapFile, detail: 'LANDING_STEPS does not include "dockerBuildPush"' });
      if (containerAt < 0) fails.push({ file: bootstrapFile, detail: 'LANDING_STEPS does not include "scwContainer"' });
      if (buildAt >= 0 && containerAt >= 0 && buildAt > containerAt) {
        fails.push({ file: bootstrapFile, detail: 'LANDING_STEPS runs "scwContainer" before "dockerBuildPush" - Scaleway validates the registry image at container-creation time (CONTRACT.md §1)' });
      }
    }

    // writeSupplyChainWorkspaceYaml() must run before the FIRST pnpm install
    // inside the landing scaffold path (check 52's rule, applied to landing).
    const fnAt = src.indexOf("function scaffoldLanding(");
    if (fnAt < 0) {
      fails.push({ file: bootstrapFile, detail: "scaffoldLanding() is not defined" });
    } else {
      const nextFnAt = src.indexOf("\nfunction ", fnAt + 1);
      const body = src.slice(fnAt, nextFnAt > 0 ? nextFnAt : undefined);
      const yamlAt = body.indexOf("writeSupplyChainWorkspaceYaml()");
      const installAt = body.search(/runPnpm\(\s*\n?\s*`pnpm install/);
      if (yamlAt < 0) {
        fails.push({ file: bootstrapFile, detail: "scaffoldLanding() never calls writeSupplyChainWorkspaceYaml()" });
      } else if (installAt >= 0 && yamlAt > installAt) {
        fails.push({ file: bootstrapFile, detail: "scaffoldLanding() calls writeSupplyChainWorkspaceYaml() AFTER the first pnpm install - the age floor must govern it" });
      }

      // The landing branch must never seed a DATABASE_URL placeholder - scoped
      // to scwContainer()'s own body, not the whole file, so an unrelated
      // mention elsewhere (e.g. a comment) cannot trip this.
    }

    const containerFnAt = src.indexOf("async function scwContainer(");
    if (containerFnAt < 0) {
      fails.push({ file: bootstrapFile, detail: "scwContainer() is not defined" });
    } else {
      const nextFnAt = src.indexOf("\nasync function", containerFnAt + 1);
      // Comments are stripped first: this function legitimately explains, in
      // prose, an earlier putSecret("DATABASE_URL", ...) call - flagging that
      // mention would be a false positive (same convention as check 6/15/21).
      const body = stripComments(src.slice(containerFnAt, nextFnAt > 0 ? nextFnAt : undefined));
      for (const m of body.matchAll(/putSecret\(\s*"DATABASE_URL"/g)) {
        const before = body.slice(Math.max(0, m.index - 200), m.index);
        if (!/if\s*\(\s*!isLanding\s*\)/.test(before)) {
          fails.push({ file: bootstrapFile, detail: "scwContainer() seeds a DATABASE_URL placeholder that is not guarded by `if (!isLanding)` - a vitrine must never get one" });
        }
      }
      if (!/LANDING_CONTAINER\.maxConcurrency/.test(body)) {
        fails.push({ file: bootstrapFile, detail: "scwContainer() does not reference LANDING_CONTAINER.maxConcurrency" });
      }
      if (!/LANDING_CONTAINER\.minScaleProduction/.test(body)) {
        fails.push({ file: bootstrapFile, detail: "scwContainer() does not reference LANDING_CONTAINER.minScaleProduction" });
      }
      // M3: allowMissingDatabaseUrl must be opt-in, gated on isLanding - a
      // bare syncContainerSecrets() call here would silently re-globalize
      // the tolerance for every stack, not just landing.
      if (!/allowMissingDatabaseUrl:\s*isLanding/.test(body)) {
        fails.push({ file: bootstrapFile, detail: "scwContainer() does not pass allowMissingDatabaseUrl: isLanding to syncContainerSecrets() (M3)" });
      }
    }
  }

  const deployFile = "scripts/deploy.mjs";
  if (!exists(deployFile)) {
    fails.push({ file: deployFile, detail: "missing" });
  } else {
    const src = read(deployFile);
    if (!/import\s*\{\s*detectStack\s*\}\s*from\s*"\.\/_stack\.mjs"/.test(src)) {
      fails.push({ file: deployFile, detail: "does not import detectStack from ./_stack.mjs" });
    }
    const stepsAt = src.indexOf("const LANDING_STEPS");
    if (stepsAt < 0) {
      fails.push({ file: deployFile, detail: "LANDING_STEPS is not defined" });
    } else {
      const stepsEnd = src.indexOf("];", stepsAt);
      const stepsBlock = src.slice(stepsAt, stepsEnd > 0 ? stepsEnd : undefined);
      for (const forbidden of ["migrate", "agentJobs"]) {
        if (new RegExp(`"${forbidden}"`).test(stepsBlock)) {
          fails.push({ file: deployFile, detail: `LANDING_STEPS includes "${forbidden}" - a vitrine has no database and no agent Jobs` });
        }
      }
    }
    if (!/LANDING_CONTAINER\.scale/.test(src) || !/LANDING_CONTAINER\.maxConcurrency/.test(src)) {
      fails.push({ file: deployFile, detail: "landing container creation does not reference LANDING_CONTAINER's scale/maxConcurrency" });
    }
    if (!/LANDING_CONTAINER\.minScaleProduction/.test(src) || !/LANDING_CONTAINER\.minScalePreview/.test(src)) {
      fails.push({ file: deployFile, detail: "landing container creation does not reference LANDING_CONTAINER's minScaleProduction/minScalePreview" });
    }
    // The landing createParams object must not re-hardcode the numbers
    // LANDING_CONTAINER already carries - scoped to the STACK === "landing"
    // ternary branch specifically, so an unrelated "80"/"1"/"0" elsewhere in
    // the file (timeouts, exit codes, array indices) cannot trip this.
    const landingParamsAt = src.indexOf('STACK === "landing"\n        ? {');
    if (landingParamsAt >= 0) {
      const landingParamsEnd = src.indexOf("}\n        :", landingParamsAt);
      const block = src.slice(landingParamsAt, landingParamsEnd > 0 ? landingParamsEnd : landingParamsAt + 500);
      if (/maxConcurrency:\s*80\b/.test(block)) {
        fails.push({ file: deployFile, detail: "landing container params re-hardcode maxConcurrency: 80 instead of LANDING_CONTAINER.maxConcurrency" });
      }
      if (/minScale:\s*(0|1)\b(?!\w)/.test(block.replace(/LANDING_CONTAINER\.\w+/g, ""))) {
        fails.push({ file: deployFile, detail: "landing container params re-hardcode a numeric minScale instead of LANDING_CONTAINER.minScaleProduction/minScalePreview" });
      }
    } else {
      fails.push({ file: deployFile, detail: "could not locate the landing createParams branch" });
    }

    // M3: allowMissingDatabaseUrl must reach the container exactly where a
    // landing sync happens - a production sync tied to STACK, a preview sync
    // always true (a vitrine preview never has a databaseUrlFrom secret
    // either).
    // Anchored on the sync log line, not a bare `if (TARGET === "production")`
    // - that condition also guards an unrelated DATABASE_URL existence check
    // earlier in the file (resolveDatabaseSecret()).
    const syncLogAt = src.indexOf('log("Syncing container secrets from Secret Manager...")');
    const prodSyncAt = syncLogAt >= 0 ? src.indexOf('if (TARGET === "production") {', syncLogAt) : -1;
    if (prodSyncAt < 0) {
      fails.push({ file: deployFile, detail: 'could not locate the TARGET === "production" secrets sync branch' });
    } else if (!/allowMissingDatabaseUrl:\s*STACK === "landing"/.test(src.slice(prodSyncAt, prodSyncAt + 700))) {
      fails.push({
        file: deployFile,
        detail: 'the TARGET === "production" secrets sync does not pass allowMissingDatabaseUrl: STACK === "landing" (M3)',
      });
    }
    const landingSyncAt = src.indexOf('} else if (STACK === "landing") {');
    if (landingSyncAt < 0) {
      fails.push({ file: deployFile, detail: 'could not locate the STACK === "landing" secrets sync branch' });
    } else if (!/allowMissingDatabaseUrl:\s*true/.test(src.slice(landingSyncAt, landingSyncAt + 500))) {
      fails.push({ file: deployFile, detail: 'the STACK === "landing" preview secrets sync does not pass allowMissingDatabaseUrl: true (M3)' });
    }
  }

  const containerFile = "scripts/scaleway/container.mjs";
  if (!exists(containerFile)) {
    fails.push({ file: containerFile, detail: "missing" });
  } else {
    const src = read(containerFile);
    const m = src.match(/export const LANDING_CONTAINER\s*=\s*Object\.freeze\(\{([^}]*)\}\)/);
    if (!m) {
      fails.push({ file: containerFile, detail: "LANDING_CONTAINER is not exported as an Object.freeze({...}) literal" });
    } else {
      const body = m[1];
      for (const [key, re, label] of [
        ["scale", /scale\s*:\s*"S"/, '"S"'],
        ["maxConcurrency", /maxConcurrency\s*:\s*80\b/, "80"],
        ["minScaleProduction", /minScaleProduction\s*:\s*1\b/, "1"],
        ["minScalePreview", /minScalePreview\s*:\s*0\b/, "0"],
      ]) {
        if (!re.test(body)) {
          fails.push({ file: containerFile, detail: `LANDING_CONTAINER.${key} is not ${label}` });
        }
      }
    }

    // M3: the missing-DATABASE_URL tolerance must be opt-in, not global -
    // defaulting to false means every caller that forgets the flag gets the
    // safe (throwing) behavior instead of silently deleting a secret.
    const buildMapAt = src.indexOf("export async function buildContainerSecretMap(");
    if (buildMapAt < 0) {
      fails.push({ file: containerFile, detail: "buildContainerSecretMap is not exported" });
    } else if (!/allowMissingDatabaseUrl\s*=\s*false/.test(src.slice(buildMapAt, buildMapAt + 400))) {
      fails.push({
        file: containerFile,
        detail: "buildContainerSecretMap does not declare allowMissingDatabaseUrl defaulting to false (M3) - the DATABASE_URL tolerance must be opt-in",
      });
    }
  }

  return fails;
});

// Pinned inventory of templates/landing/ - a missing (or unexpectedly extra)
// file here means the scaffolded vitrine no longer matches what
// scaffoldLanding()/landingDeployArtifacts()/landingClaudeMd() actually write.
const LANDING_TEMPLATE_MANIFEST = [
  "templates/landing/astro.config.mjs",
  "templates/landing/Caddyfile",
  "templates/landing/claude-md-core.md",
  "templates/landing/docker-entrypoint.sh",
  "templates/landing/Dockerfile",
  "templates/landing/.dockerignore",
  "templates/landing/.gitignore",
  "templates/landing/package.json",
  "templates/landing/public/favicon.svg",
  "templates/landing/public/robots.txt",
  "templates/landing/src/components/About.astro",
  "templates/landing/src/components/Contact.astro",
  "templates/landing/src/components/Footer.astro",
  "templates/landing/src/components/Header.astro",
  "templates/landing/src/components/Hero.astro",
  "templates/landing/src/components/Services.astro",
  "templates/landing/src/components/Testimonials.astro",
  "templates/landing/src/env.d.ts",
  "templates/landing/src/layouts/BaseLayout.astro",
  "templates/landing/src/pages/404.astro",
  "templates/landing/src/pages/index.astro",
  "templates/landing/src/pages/mentions-legales.astro",
  "templates/landing/src/pages/politique-de-confidentialite.astro",
  "templates/landing/src/styles/global.css",
  "templates/landing/src/styles/presets/audacieux.css",
  "templates/landing/src/styles/presets/chaleureux.css",
  "templates/landing/src/styles/presets/epure.css",
  "templates/landing/tsconfig.json",
];

define("85", "Template manifest + bootstrap rules: landing inventory, strict tokens", () => {
  const fails = [];

  const actual = new Set(FILES.filter((f) => f.startsWith("templates/landing/")));
  const expected = new Set(LANDING_TEMPLATE_MANIFEST);
  for (const f of LANDING_TEMPLATE_MANIFEST) {
    if (!exists(f)) fails.push({ file: f, detail: "missing from templates/landing/ - the pinned manifest expects it" });
  }
  for (const f of actual) {
    if (!expected.has(f)) fails.push({ file: f, detail: "unexpected file under templates/landing/ - not in the pinned manifest, update it deliberately if this is intentional" });
  }

  const bootstrapSkill = "skills/bootstrap/SKILL.md";
  if (!exists(bootstrapSkill)) {
    fails.push({ file: bootstrapSkill, detail: "missing" });
  } else {
    const s = read(bootstrapSkill);
    if (!/literal token `landing`/.test(s)) {
      fails.push({ file: bootstrapSkill, detail: "no literal-token rule for `landing`" });
    }
    if (!/literal token `application`/.test(s)) {
      fails.push({ file: bootstrapSkill, detail: "no literal-token rule for `application`" });
    }
    if (!/never infer the stack/i.test(s)) {
      fails.push({ file: bootstrapSkill, detail: "no never-infer-the-stack sentence" });
    }
    for (const preset of ["epure", "chaleureux", "audacieux"]) {
      if (!new RegExp("`" + preset + "`").test(s)) {
        fails.push({ file: bootstrapSkill, detail: `preset token \`${preset}\` not named literally` });
      }
    }
  }

  for (const f of FILES.filter((x) => x.startsWith("templates/landing/"))) {
    let s;
    try {
      s = read(f);
    } catch {
      continue;
    }
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(s)) {
      fails.push({ file: f, detail: "references Google Fonts at runtime - RGPD requires the fontsource packages baked at build time instead" });
    }
  }

  return fails;
});

// Pinned inventory of templates/blog/ - a missing (or unexpectedly extra)
// file here means /add-blog's copy step (skills/add-blog/SKILL.md Step 4) no
// longer matches what actually ships.
const BLOG_TEMPLATE_MANIFEST = [
  "templates/blog/src/components/PostCard.astro",
  "templates/blog/src/content/blog/.gitkeep",
  "templates/blog/src/content.config.ts",
  "templates/blog/src/pages/blog/[slug].astro",
  "templates/blog/src/pages/blog/index.astro",
  "templates/blog/src/pages/rss.xml.ts",
];

define("86", "Vitrine blog: template manifest, no typography plugin, no draft field", () => {
  const fails = [];

  const actual = new Set(FILES.filter((f) => f.startsWith("templates/blog/")));
  const expected = new Set(BLOG_TEMPLATE_MANIFEST);
  for (const f of BLOG_TEMPLATE_MANIFEST) {
    if (!exists(f)) fails.push({ file: f, detail: "missing from templates/blog/ - the pinned manifest expects it" });
  }
  for (const f of actual) {
    if (!expected.has(f)) fails.push({ file: f, detail: "unexpected file under templates/blog/ - not in the pinned manifest, update it deliberately if this is intentional" });
  }

  for (const f of FILES.filter((x) => x.startsWith("templates/blog/"))) {
    let s;
    try {
      s = read(f);
    } catch {
      continue;
    }
    if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(s)) {
      fails.push({ file: f, detail: "references Google Fonts at runtime - RGPD requires the fontsource packages baked at build time instead" });
    }
  }

  // @tailwindcss/typography would fight the semantic tokens the rest of the
  // vitrine relies on (and break /add-dark-mode) - forbidden under the
  // template itself. On the two SKILL.mds, scope the scan to an
  // install/import line: prose like "never install @tailwindcss/typography"
  // is the documented reason it stays out, not a violation of it.
  for (const f of FILES.filter((x) => x.startsWith("templates/blog/"))) {
    if (!exists(f)) continue;
    if (read(f).includes("@tailwindcss/typography")) {
      fails.push({ file: f, detail: "references @tailwindcss/typography - its own palette would fight the semantic tokens and break /add-dark-mode (CONTRACT.md's vitrine blog decision)" });
    }
  }
  for (const f of ["skills/add-blog/SKILL.md", "skills/blogpost/SKILL.md"]) {
    if (!exists(f)) continue;
    for (const line of read(f).split("\n")) {
      if (line.includes("@tailwindcss/typography") && (line.includes("pnpm add") || line.includes("import"))) {
        fails.push({ file: f, detail: "installs or imports @tailwindcss/typography - its own palette would fight the semantic tokens and break /add-dark-mode (CONTRACT.md's vitrine blog decision)" });
      }
    }
  }

  const contentConfig = "templates/blog/src/content.config.ts";
  if (exists(contentConfig) && /\bdraft\b/.test(read(contentConfig))) {
    fails.push({ file: contentConfig, detail: "schema declares a `draft` field - the `revue` branch IS the draft state, there must be no draft frontmatter (plan decision 3)" });
  }

  const deploySkill = "skills/deploy/SKILL.md";
  if (!exists(deploySkill)) {
    fails.push({ file: deploySkill, detail: "missing" });
  } else if (!read(deploySkill).includes("/blogpost")) {
    fails.push({ file: deploySkill, detail: "the bootstrap-8b exception area does not mention /blogpost - its two deploys (preview then production) also need the Step 0/Step 1 skip documented" });
  }

  const blogpostSkill = "skills/blogpost/SKILL.md";
  if (!exists(blogpostSkill)) {
    fails.push({ file: blogpostSkill, detail: "missing" });
  } else {
    const s = read(blogpostSkill);
    for (const needle of ["api.indexnow.org", "revue", "ACCESS_RESTRICTED", "deletePreviewContainer", "previewContainerName"]) {
      if (!s.includes(needle)) fails.push({ file: blogpostSkill, detail: `does not mention "${needle}"` });
    }
    // The preview IS the review (user decision 2026-08-14): the flow must
    // never block on a full-text approval in chat before the preview deploy.
    if (s.includes("MANDATORY, NEVER SKIP")) {
      fails.push({ file: blogpostSkill, detail: "reintroduces the blocking chat approval loop - the article deploys straight to the revue preview, the verdict there is the only blocking question" });
    }
  }

  const addBlogSkill = "skills/add-blog/SKILL.md";
  if (!exists(addBlogSkill)) {
    fails.push({ file: addBlogSkill, detail: "missing" });
  } else {
    const s = read(addBlogSkill);
    for (const needle of ["templates/blog/", "@astrojs/rss"]) {
      if (!s.includes(needle)) fails.push({ file: addBlogSkill, detail: `does not mention "${needle}"` });
    }

    // Every template file that still carries a {{SITE_...}} placeholder must
    // be named in add-blog's own substitution instructions, or the skill
    // silently leaves that file's placeholder unfilled (the rss.xml.ts /
    // [slug].astro / index.astro gap this check was written to catch).
    for (const f of FILES.filter((x) => x.startsWith("templates/blog/"))) {
      if (!exists(f) || !read(f).includes("{{SITE_")) continue;
      const basename = f.split("/").pop();
      if (!s.includes(basename) && !s.includes(f)) {
        fails.push({ file: addBlogSkill, detail: `"${f}" carries a {{SITE_...}} placeholder but neither "${f}" nor "${basename}" is named in the substitution instructions` });
      }
    }
  }

  return fails;
});

define("87", "Container names: 34-char bound through one resolver", () => {
  const fails = [];

  const auth = "scripts/scaleway/_scw-auth.mjs";
  if (!exists(auth)) {
    fails.push({ file: auth, detail: "missing" });
  } else {
    const s = read(auth);
    if (!/export const CONTAINER_NAME_MAX = 34\b/.test(s)) {
      fails.push({ file: auth, detail: "does not export CONTAINER_NAME_MAX = 34 - Scaleway rejects longer container names (live-verified 2026-08-14)" });
    }
    const fnAt = s.indexOf("export function previewContainerName(");
    if (fnAt < 0) {
      fails.push({ file: auth, detail: "does not export previewContainerName - the one bounded resolver for preview container names" });
    } else if (!s.slice(fnAt).includes("-preview-")) {
      fails.push({ file: auth, detail: 'previewContainerName no longer builds the "-preview-" prefix check-deps.mjs discovers previews by' });
    }
  }

  // Every script that addresses a preview container resolves the name through
  // the helper - a hand-assembled template literal drifts on long branches
  // and overflows the 34-char limit.
  const CALLERS = ["scripts/deploy.mjs", "scripts/scale.mjs", "scripts/rotate-secret.mjs", "scripts/push-env-vars.mjs"];
  const HAND_ASSEMBLED = /\$\{(?:projectName|PROJECT_NAME|appName)\}-preview-/;
  for (const f of CALLERS) {
    if (!exists(f)) {
      fails.push({ file: f, detail: "missing" });
      continue;
    }
    const s = read(f);
    if (!s.includes("previewContainerName(")) {
      fails.push({ file: f, detail: "does not call previewContainerName - preview container names must go through the one bounded resolver" });
    }
    if (HAND_ASSEMBLED.test(s)) {
      fails.push({ file: f, detail: 'hand-assembles a "<name>-preview-" container name - resolve it with previewContainerName instead (34-char limit)' });
    }
  }

  const bootstrap = "scripts/bootstrap-init.mjs";
  if (exists(bootstrap) && !read(bootstrap).includes("CONTAINER_NAME_MAX")) {
    fails.push({ file: bootstrap, detail: "no longer caps the deploy name from CONTAINER_NAME_MAX - a long name makes '<name>-preview-revue' overflow the 34-char container name limit" });
  }

  const container = "scripts/scaleway/container.mjs";
  if (!exists(container)) {
    fails.push({ file: container, detail: "missing" });
  } else {
    const s = read(container);
    if (!s.includes("previewContainerName")) {
      fails.push({ file: container, detail: "no longer re-exports previewContainerName - skill snippets import the resolver from here" });
    }
    const delAt = s.indexOf("export async function deletePreviewContainer(");
    if (delAt < 0) {
      fails.push({ file: container, detail: "does not export deletePreviewContainer - /blogpost's teardown step needs it" });
    } else if (!s.slice(delAt).includes('includes("-preview-")')) {
      fails.push({ file: container, detail: 'deletePreviewContainer lost its "-preview-" name guard - the harness must never delete a production container' });
    }
  }

  for (const f of ["skills/publish/SKILL.md", "skills/unpublish/SKILL.md"]) {
    if (exists(f) && !read(f).includes("previewContainerName(")) {
      fails.push({ file: f, detail: "resolves a preview container name without previewContainerName - the inline snippet must use the bounded resolver" });
    }
  }

  return fails;
});

define("88", "Bootstrap: the ip.me question ends the turn", () => {
  const fails = [];
  const f = "skills/bootstrap/SKILL.md";
  if (!exists(f)) return [{ file: f, detail: "missing" }];
  const s = read(f);

  const questionAt = s.indexOf("https://ip.me");
  const stopAt = s.indexOf("End your message on that question and stop the turn");
  const step4At = s.indexOf("## Step 4");

  if (questionAt < 0) {
    fails.push({ file: f, detail: "the ip.me question is gone - the user must be asked for their address once" });
  }
  if (stopAt < 0) {
    fails.push({ file: f, detail: 'missing the "End your message on that question and stop the turn" instruction - Step 4\'s spec questions bury the IP question and the allowlist stays empty' });
  } else if (questionAt >= 0 && step4At >= 0 && !(questionAt < stopAt && stopAt < step4At)) {
    fails.push({ file: f, detail: "the stop-the-turn instruction is not between the ip.me question and Step 4 - it must break the flow exactly there" });
  }
  return fails;
});

define("89", "Bootstrap: the description question ends the turn before the style question", () => {
  const fails = [];
  const f = "skills/bootstrap/SKILL.md";
  if (!exists(f)) return [{ file: f, detail: "missing" }];
  const s = read(f);

  const descAt = s.indexOf("1-2 phrases");
  const stopAt = s.indexOf("end the turn on the description question");
  const styleAt = s.indexOf("Quel style visuel");
  const step2At = s.indexOf("## Step 2");

  if (descAt < 0) {
    fails.push({ file: f, detail: "the description question is gone - the user must be asked for a 1-2 sentence description" });
  }
  if (styleAt < 0) {
    fails.push({ file: f, detail: "the style question is gone - the vitrine path must offer the three presets" });
  }
  if (stopAt < 0) {
    fails.push({ file: f, detail: 'missing the "end the turn on the description question" instruction - the style dialog buries the description ask when both share a turn' });
  } else if (descAt >= 0 && styleAt >= 0 && step2At >= 0 && !(descAt < stopAt && stopAt < styleAt && styleAt < step2At)) {
    fails.push({ file: f, detail: "wrong order - Step 1 must ask the description, end the turn, then ask the style, all before Step 2" });
  }
  return fails;
});

/* ------------------------------------------------------------------- runner */

const results = [];
for (const c of checks) {
  if (ONLY && !ONLY.includes(c.id)) continue;
  let fails;
  try {
    fails = c.fn();
  } catch (e) {
    fails = [{ file: "(verifier)", detail: `check crashed: ${e.message}` }];
  }
  results.push({ ...c, fails, fn: undefined });
}

const total = results.reduce((n, r) => n + r.fails.length, 0);

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: total === 0, total, results }, null, 2));
} else {
  for (const r of results) {
    const mark = r.fails.length === 0 ? "PASS" : "FAIL";
    console.log(`\n[${mark}] ${r.id}. ${r.title}${r.fails.length ? `  (${r.fails.length})` : ""}`);
    if (!QUIET) {
      const byFile = new Map();
      for (const f of r.fails) {
        if (!byFile.has(f.file)) byFile.set(f.file, []);
        byFile.get(f.file).push(f.detail);
      }
      for (const [file, details] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
        console.log(`   ${file}`);
        for (const d of details.slice(0, 12)) console.log(`      - ${d}`);
        if (details.length > 12) console.log(`      … ${details.length - 12} more`);
      }
    }
  }
  console.log(`\n${"=".repeat(60)}`);
  console.log(total === 0 ? "ALL CHECKS PASS" : `${total} failures across ${results.filter((r) => r.fails.length).length} checks`);
  console.log(`${"=".repeat(60)}`);
}

process.exit(total === 0 ? 0 : 1);
