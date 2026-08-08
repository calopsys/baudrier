#!/usr/bin/env node
// build-snapshot.mjs - Build a complete snapshot ZIP of a Baudrier project.
//
// Usage:
//   node build-snapshot.mjs --project <name> [--project-dir <path>] [--out <dir>]
//                           [--skip-storage] [--skip-memory] [--skip-env]
//
// Produces <out>/<project>-snapshot-<YYYYMMDD-HHMMSS>.zip containing:
//   code/      - git bundle (--all) + package.json + working-changes.patch (if dirty)
//   env/       - values pulled from Scaleway Secret Manager + a copy of the local .env(.local)
//   db/        - NOTE.md explaining why there is no data dump (see below) - never silent
//   storage/   - Object Storage bucket content (if configured)
//   memory/    - Claude Code memory/transcripts for this project
//   config/    - Scaleway resource linkage, resolved live by name (not a secret)
//   MANIFEST.md - human-readable description + restore notes
//
// ─────────────────────────────────────────────────────────────────────────
// Why there is no database dump (see also CONTRACT.md §4 and DOC.md):
// the operator's machine has NO DATABASE_URL and never connects to a
// Serverless SQL Database directly - only the migration Serverless Job does,
// and only inside Scaleway's network. There is also no on-demand backup API
// to trigger from here. Faking a "database" section by silently omitting the
// data would be worse than not having one: db/NOTE.md says so explicitly and
// loudly, every time - and it does NOT assert an unverified figure (e.g. a
// specific backup frequency/retention window) as if it were a guaranteed
// Scaleway behaviour. Scaleway's general docs state it performs automatic
// database backups, but the exact frequency/retention for Serverless SQL
// Database has not been verified here, so the note hedges accordingly and
// tells the user to trigger their own export if the data actually matters.
// ─────────────────────────────────────────────────────────────────────────
//
// Final stdout = JSON report. Exit 0 on success, 1 on fatal error.

import {
  existsSync, mkdirSync, readFileSync, writeFileSync, rmSync,
  cpSync, statSync, readdirSync, unlinkSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isRemoteSandbox } from "../_platform.mjs";
import { REGION, api, sdkCall, slugify, loadCredentials, resolveProjectId } from "../scaleway/_scw-auth.mjs";
import { listSecrets, getSecret, secretExists } from "../scaleway/secrets.mjs";
import { findContainerByName } from "../scaleway/container.mjs";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));

// --- Args ---
const args = process.argv.slice(2);
function arg(name, def = null) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
}
function flag(name) {
  return args.includes(name);
}

const PROJECT = arg("--project");
const PROJECT_DIR = resolve(arg("--project-dir") || process.cwd());
// On a Claude Code web sandbox, the default Downloads folder is nothing the
// user can retrieve (CONTRACT.md §7: no persistence outside /tmp, and the
// sandbox has no browser download path anyway) - default to a tmpdir
// subdirectory there instead and say so plainly.
const DEFAULT_OUT_DIR = isRemoteSandbox() ? join(tmpdir(), "baudrier-snapshots") : join(homedir(), "Downloads");
const OUT_DIR = resolve(arg("--out") || DEFAULT_OUT_DIR);
const SKIP_STORAGE = flag("--skip-storage");
const SKIP_MEMORY = flag("--skip-memory");
const SKIP_ENV = flag("--skip-env");

if (!PROJECT) {
  console.error("Usage: node build-snapshot.mjs --project <name> [--project-dir <path>] [--out <dir>] [--skip-storage] [--skip-memory] [--skip-env]");
  process.exit(1);
}

if (isRemoteSandbox() && !arg("--out")) {
  console.error(
    "Remarque : cette session est temporaire, le zip ne peut pas être téléchargé depuis un navigateur. " +
      `Il sera écrit dans ${OUT_DIR}, à l'intérieur de la même session.`,
  );
}

if (!existsSync(PROJECT_DIR)) {
  console.error(`Project dir not found: ${PROJECT_DIR}`);
  process.exit(1);
}

const NOW = new Date();
const TS = `${NOW.getFullYear()}${String(NOW.getMonth() + 1).padStart(2, "0")}${String(NOW.getDate()).padStart(2, "0")}-${String(NOW.getHours()).padStart(2, "0")}${String(NOW.getMinutes()).padStart(2, "0")}${String(NOW.getSeconds()).padStart(2, "0")}`;
const SNAP_NAME = `${PROJECT}-snapshot-${TS}`;
const WORK_DIR = join(tmpdir(), `baudrier-snapshot-${Date.now()}`);
const SNAP_DIR = join(WORK_DIR, SNAP_NAME);

mkdirSync(SNAP_DIR, { recursive: true });

const steps = {};
function logStep(name, status, extra = {}) {
  steps[name] = { status, ...extra };
  process.stderr.write(`[${name}] ${status}${extra.error ? " - " + extra.error : ""}\n`);
}

function run(cmd, argv, opts = {}) {
  return spawnSync(cmd, argv, { encoding: "utf8", shell: true, ...opts });
}

function dirSize(p) {
  if (!existsSync(p)) return 0;
  let total = 0;
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const sub = join(p, entry.name);
    if (entry.isDirectory()) total += dirSize(sub);
    else { try { total += statSync(sub).size; } catch {} }
  }
  return total;
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Resolve this app's own Scaleway Project id by name (CONTRACT.md §2, §7 -
// app repos carry no Scaleway metadata at all) so every Secret Manager call
// below is explicitly scoped, rather than trusting whatever
// SCW_DEFAULT_PROJECT_ID happens to be set to on the operator's machine.
// Best-effort: a snapshot with no Scaleway access at all still produces the
// code/memory sections, just without the env/ secrets.
async function resolveScwProjectId() {
  try {
    return await resolveProjectId({ appName: PROJECT });
  } catch {
    return null;
  }
}
const SCW_PROJECT_ID = await resolveScwProjectId();

// ============================================================
// Step 1: git bundle (code + history + working changes)
// ============================================================
function stepGitBundle() {
  const codeDir = join(SNAP_DIR, "code");
  mkdirSync(codeDir, { recursive: true });

  const gitCheck = run("git", ["-C", PROJECT_DIR, "rev-parse", "--is-inside-work-tree"]);
  if (gitCheck.status !== 0) {
    logStep("git-bundle", "skipped", { reason: "not a git repo" });
    return;
  }

  const bundlePath = join(codeDir, "repo.bundle");
  const r = run("git", ["-C", PROJECT_DIR, "bundle", "create", bundlePath, "--all"]);
  if (r.status !== 0) {
    logStep("git-bundle", "error", { error: (r.stderr || r.stdout || "").slice(0, 300) });
    return;
  }

  // Capture working changes (uncommitted + untracked) as a patch
  const status = run("git", ["-C", PROJECT_DIR, "status", "--porcelain"]);
  const dirty = (status.stdout || "").trim().length > 0;
  if (dirty) {
    const diff = run("git", ["-C", PROJECT_DIR, "diff", "HEAD"]);
    writeFileSync(join(codeDir, "working-changes.patch"), diff.stdout || "");
    // Also list untracked files (since git diff doesn't include them)
    const untracked = run("git", ["-C", PROJECT_DIR, "ls-files", "--others", "--exclude-standard"]);
    writeFileSync(join(codeDir, "untracked-files.txt"), untracked.stdout || "");
  }

  // Copy a few top-level reference files
  for (const f of ["package.json", "CLAUDE.md", "README.md", ".gitignore"]) {
    const src = join(PROJECT_DIR, f);
    if (existsSync(src)) {
      try { cpSync(src, join(codeDir, f)); } catch {}
    }
  }

  const bundleSize = statSync(bundlePath).size;
  logStep("git-bundle", "ok", { bundleBytes: bundleSize, dirty });
}

// ============================================================
// Step 2: env vars - Secret Manager (canonical) + local .env copy
// ============================================================
async function stepEnvVars() {
  if (SKIP_ENV) { logStep("env-vars", "skipped", { reason: "--skip-env" }); return; }

  const envDir = join(SNAP_DIR, "env");
  mkdirSync(envDir, { recursive: true });

  let secretsWritten = 0;
  const creds = loadCredentials();
  if (creds.accessKey && creds.secretKey) {
    try {
      const opts = SCW_PROJECT_ID ? { projectId: SCW_PROJECT_ID } : {};
      const list = await listSecrets(opts);
      const lines = [];
      for (const s of list) {
        try {
          const value = await getSecret(s.name, opts);
          lines.push(`${s.name}=${value}`);
          secretsWritten++;
        } catch (e) {
          lines.push(`# ${s.name} - could not be read: ${e.message}`);
        }
      }
      writeFileSync(join(envDir, "secret-manager.env"), lines.join("\n") + "\n");
    } catch (e) {
      logStep("env-vars", "error", { error: `Secret Manager read failed: ${e.message}` });
      return;
    }
  }

  let localCopied = 0;
  for (const file of [".env", ".env.local"]) {
    const src = join(PROJECT_DIR, file);
    if (existsSync(src)) {
      try { cpSync(src, join(envDir, file)); localCopied++; } catch {}
    }
  }

  if (secretsWritten === 0 && localCopied === 0) {
    logStep("env-vars", "skipped", { reason: "no Scaleway credentials and no local .env/.env.local found" });
    return;
  }
  logStep("env-vars", "ok", { secretsWritten, localFilesCopied: localCopied });
}

// ============================================================
// Step 3: database - NOTE.md only, see file header for why
// ============================================================
async function stepDatabaseNote() {
  const dbDir = join(SNAP_DIR, "db");
  mkdirSync(dbDir, { recursive: true });

  const creds = loadCredentials();
  let hasDatabase = false;
  if (creds.accessKey && creds.secretKey) {
    try {
      hasDatabase = await secretExists("DATABASE_URL", SCW_PROJECT_ID ? { projectId: SCW_PROJECT_ID } : {});
    } catch {
      hasDatabase = existsSync(join(PROJECT_DIR, ".env")) && /^DATABASE_URL=/m.test(readFileSync(join(PROJECT_DIR, ".env"), "utf8"));
    }
  }

  const note = hasDatabase
    ? `# Base de données - PAS incluse dans ce snapshot

Ce projet a une base de données (Serverless SQL Database Scaleway), mais **ses
données ne sont pas dans ce zip**. Concrètement : aucune de vos données
métier (clients, commandes, contenus, comptes...) ne se trouve dans cette
sauvegarde.

## Pourquoi

La machine de l'opérateur n'a jamais accès direct à la base (CONTRACT.md §4) :
seule la Job de migration s'y connecte, depuis le réseau interne de Scaleway.
Il n'existe pas non plus d'API Scaleway pour déclencher une sauvegarde à la
demande. Plutôt que de produire un snapshot qui a l'air complet mais ne
contient pas les données, cette note existe pour le dire clairement.

## Ce qui protège (peut-être) vos données - et ce qui n'est PAS garanti

Scaleway indique dans sa documentation générale effectuer des sauvegardes
automatiques des bases de données. **Nous n'avons pas vérifié précisément la
fréquence ni la durée de rétention pour Serverless SQL Database** - ne
considérez donc pas ceci comme un filet de sécurité garanti pour vos
données, et ne vous fiez pas à un chiffre non confirmé.

⚠️ Que ces sauvegardes automatiques existent ou non, elles ne survivraient de
toute façon pas à une suppression de la base elle-même. Si vous avez besoin
d'un export réel des données (avant une suppression, ou pour toute autre
raison), c'est à vous de le déclencher vous-même : un \`pg_dump\` depuis un
poste ayant un accès réseau à la base, ou un outil dédié dans la console
Scaleway - jamais un chiffre annoncé sans vérification.
`
    : `# Base de données

Aucune base de données détectée pour ce projet (pas de secret DATABASE_URL en
Secret Manager, ni dans le .env local). Rien à documenter ici.
`;

  writeFileSync(join(dbDir, "NOTE.md"), note);
  logStep("db-note", "ok", { hasDatabase });
}

// ============================================================
// Step 4: Object Storage download
// ============================================================
function stepStorageDownload() {
  if (SKIP_STORAGE) { logStep("storage-download", "skipped", { reason: "--skip-storage" }); return; }

  const storageDir = join(SNAP_DIR, "storage");
  mkdirSync(storageDir, { recursive: true });
  const r = run("node", [
    join(SCRIPT_DIR, "download-storage.mjs"),
    "--project", PROJECT,
    "--out-dir", storageDir,
    "--project-dir", PROJECT_DIR,
  ]);
  let payload = {};
  try {
    const lastLine = (r.stdout || "").trim().split("\n").pop();
    payload = JSON.parse(lastLine);
  } catch {
    payload = { status: "error", reason: "could not parse download-storage output" };
  }
  // "skipped" = this project genuinely has no Object Storage configured.
  if (payload.status === "skipped") {
    logStep("storage-download", "skipped", { reason: payload.reason });
    return;
  }
  if (r.status !== 0 || payload.status === "error") {
    logStep("storage-download", "error", { error: payload.reason || (r.stderr || "").slice(0, 200) });
    return;
  }
  logStep("storage-download", "ok", {
    bucketsScanned: payload.bucketsScanned,
    totalObjects: payload.totalObjects,
    totalSize: humanSize(payload.totalBytes || 0),
  });
}

// ============================================================
// Step 5: Memory files
// ============================================================
function stepMemory() {
  if (SKIP_MEMORY) { logStep("memory", "skipped", { reason: "--skip-memory" }); return; }

  const memoryDir = join(SNAP_DIR, "memory");
  mkdirSync(memoryDir, { recursive: true });

  const claudeProjects = join(homedir(), ".claude", "projects");
  if (!existsSync(claudeProjects)) {
    logStep("memory", "skipped", { reason: "~/.claude/projects not found" });
    return;
  }

  // Claude Code convention: ~/.claude/projects/<encoded-path>/ where the
  // absolute project path has its separators (/, \, :) AND dots replaced by
  // dashes. We normalize both sides the same way so a project like
  // "my-project" matches the encoded dir "C--Code-my-project".
  const normalize = (s) => s.toLowerCase().replace(/[.\\/:]/g, "-");
  const needle = normalize(PROJECT);

  // Transcripts (.jsonl) and session metadata live directly in the project
  // dir, not in a legacy "memory/" subdir - copy the whole thing.
  const dirs = readdirSync(claudeProjects);
  const matches = [];
  for (const d of dirs) {
    if (normalize(d).includes(needle)) {
      matches.push({ projectDir: d, srcDir: join(claudeProjects, d) });
    }
  }

  if (matches.length === 0) {
    logStep("memory", "skipped", { reason: `no Claude project dir matching "${needle}"` });
    return;
  }

  for (const m of matches) {
    const dest = join(memoryDir, m.projectDir);
    try { cpSync(m.srcDir, dest, { recursive: true }); } catch (e) {
      logStep("memory", "error", { error: e.message });
      return;
    }
  }
  logStep("memory", "ok", { matchedDirs: matches.length });
}

// ============================================================
// Step 6: Config - Scaleway resource linkage (resolved live by name, not a
// secret; CONTRACT.md §2, §7 - there is no repo-local linkage file anymore)
// ============================================================
async function stepConfigs() {
  const configDir = join(SNAP_DIR, "config");
  mkdirSync(configDir, { recursive: true });
  const captured = {};

  if (SCW_PROJECT_ID) {
    try {
      const slug = slugify(PROJECT);
      const containersApi = await api("Container", "v1");
      const namespaces = await sdkCall(() =>
        containersApi.listNamespaces({ region: REGION, projectId: SCW_PROJECT_ID, name: slug }).all(),
      );
      const ns = namespaces.find((n) => n.name === slug) || null;
      const production = ns ? await findContainerByName(ns.id, PROJECT) : null;
      writeFileSync(
        join(configDir, "scaleway-link.json"),
        JSON.stringify(
          {
            projectId: SCW_PROJECT_ID,
            region: REGION,
            namespaceId: ns?.id ?? null,
            namespaceName: ns?.name ?? null,
            productionContainerId: production?.id ?? null,
          },
          null,
          2,
        ) + "\n",
      );
      captured.scalewayLink = true;
    } catch (e) {
      captured.scalewayLinkError = e.message;
    }
  }

  logStep("configs", "ok", captured);
}

// ============================================================
// Step 7: Write MANIFEST.md
// ============================================================
function writeManifest() {
  const sizes = {};
  for (const sub of ["code", "db", "env", "storage", "memory", "config"]) {
    sizes[sub] = humanSize(dirSize(join(SNAP_DIR, sub)));
  }

  const md = `# Snapshot - ${PROJECT}

**Date** : ${new Date().toISOString()}
**Source** : ${PROJECT_DIR}
**Outil** : Baudrier / save-project

## Contenu

| Sous-dossier | Taille | Description |
|---|---|---|
| \`code/\` | ${sizes.code} | Git bundle complet (toute l'history) + package.json + working-changes.patch si modifs non commitées |
| \`db/\` | ${sizes.db} | **PAS de données** - voir \`db/NOTE.md\` pour pourquoi et ce qui protège réellement votre base |
| \`env/\` | ${sizes.env} | Valeurs lues depuis Scaleway Secret Manager (\`secret-manager.env\`) + copie du \`.env\`/\`.env.local\` local |
| \`storage/\` | ${sizes.storage} | Contenu du bucket Object Storage Scaleway (si configuré) |
| \`memory/\` | ${sizes.memory} | Fichiers mémoire/transcripts Claude Code du projet |
| \`config/\` | ${sizes.config} | \`scaleway-link.json\` (liaison namespace/container résolue par nom - pas un secret) |

## Rapport d'exécution

\`\`\`json
${JSON.stringify(steps, null, 2)}
\`\`\`

## ⚠️ Sécurité

Ce snapshot contient des **secrets en clair** (clés API dans \`env/secret-manager.env\`
et les copies de \`.env\`/\`.env.local\`). À traiter comme un fichier sensible :
- Pas de partage sur un canal non chiffré
- Pas de stockage sur un service public
- À supprimer dès qu'il n'est plus utile

## Restauration

La restauration n'est pas automatisée. Pour reconstruire le projet manuellement :

1. **Code** : \`git clone code/repo.bundle <nouveau-dossier>\` puis \`pnpm install\`. Si \`working-changes.patch\` est présent, \`cd <nouveau-dossier> && git apply ../code/working-changes.patch\`.
2. **Variables d'env** : copiez \`env/secret-manager.env\` vers \`.env\` dans le nouveau dossier, ou réinjectez chaque valeur dans Secret Manager avec la skill \`/rotate-secret\` de Baudrier.
3. **Base de données** : voir \`db/NOTE.md\` - il n'y a pas de données à restaurer depuis ce zip. Relancez \`/add-db\` pour provisionner une base neuve et vide, ou vérifiez dans la console Scaleway si une sauvegarde automatique de l'ancienne base est encore disponible (fréquence et rétention non garanties - à vérifier au cas par cas dans la console, pas en se fiant à un chiffre supposé).
4. **Stockage** : recréez le bucket via la skill \`/add-storage\`, puis réuploadez le contenu de \`storage/\`.

En cas de doute, ouvrez Claude Code dans le dossier du snapshot et demandez :
> *"Voici un snapshot Baudrier d’un projet à restaurer. Lis le MANIFEST.md et guide-moi pas à pas."*
`;

  writeFileSync(join(SNAP_DIR, "MANIFEST.md"), md);
}

// ============================================================
// Step 8: Zip
// ============================================================
function buildZip() {
  mkdirSync(OUT_DIR, { recursive: true });
  const zipPath = join(OUT_DIR, `${SNAP_NAME}.zip`);

  // Use Python zipfile (no npm dependency needed). We write the script to a
  // temp file rather than pass it via `python -c`: this harness spawns with
  // argv arrays only, never a shell, so a multi-line script has nowhere to
  // go except a real file.
  const pyScript = `
import zipfile, os, sys
src = sys.argv[1]
dst = sys.argv[2]
base = os.path.basename(src)
with zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(src):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, os.path.dirname(src))
            arcname = rel.replace(os.sep, '/')
            zf.write(full, arcname)
`;
  const scriptPath = join(WORK_DIR, "_zip.py");
  writeFileSync(scriptPath, pyScript);
  const r = run("python", [scriptPath, SNAP_DIR, zipPath]);
  if (r.status !== 0) {
    throw new Error(`zip failed: ${(r.stderr || r.stdout || "").slice(0, 300)}`);
  }
  return { zipPath, size: statSync(zipPath).size };
}

// ============================================================
// Main
// ============================================================
try {
  stepGitBundle();
  await stepEnvVars();
  await stepDatabaseNote();
  stepStorageDownload();
  stepMemory();
  await stepConfigs();
  writeManifest();

  const zipInfo = buildZip();

  // Cleanup work dir
  try { rmSync(WORK_DIR, { recursive: true, force: true }); } catch {}

  console.log(JSON.stringify({
    status: "ok",
    project: PROJECT,
    zipPath: zipInfo.zipPath,
    zipSize: humanSize(zipInfo.size),
    timestamp: TS,
    steps,
  }, null, 2));
} catch (e) {
  console.error(JSON.stringify({
    status: "error",
    reason: e.message,
    workDir: WORK_DIR,
    steps,
  }, null, 2));
  process.exit(1);
}
