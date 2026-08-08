---
name: _push-env-vars
description: Internal helper to push environment variables safely to the local .env, to Scaleway Secret Manager, and to a Serverless Container's secret_environment_variables (production and/or preview). Delegates to the bundled scripts/push-env-vars.mjs. Triggered by any skill that needs to set env vars (add-db, add-auth, add-email, add-storage, add-analytics, add-cron…). Not meant to be invoked directly by users.
user-invocable: false
allowed-tools: Bash
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (gh, scw)."
---

# Push Env Vars - Internal helper

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: English). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Push env vars to the local `.env`, to Scaleway Secret Manager, and to a Serverless Container's `secret_environment_variables`. Delegates to a bundled Node script - never reimplement the push logic inline.

## Invocation

From the **project root**, call (values travel over stdin, never argv, so a secret never sits in the process list or shell history):

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/push-env-vars.mjs" --stdin [--env production|preview] <<'EOF'
KEY1=value1
KEY2=value2
EOF
```

One `KEY=VALUE` per line. The script splits each line on the first `=` only, so values containing `=` are preserved.

### `--env` flag

Selects which Serverless Container (CONTRACT.md §5) receives the values via `secret_environment_variables`:
- omitted → best-effort write to **both** the production and preview containers (whichever are currently linked)
- `--env production` → only the production container
- `--env preview` → only the preview container for the **current git branch**

The `.env` write and the Secret Manager write are unconditional (a Secret Manager secret's name IS the env var name - CONTRACT.md §2 - there is one canonical value per key, independent of production/preview).

## Rules

- **Always** use this helper (never write to `.env` by hand, never call `secrets.mjs`/`container.mjs` inline for this purpose).
- The script handles `.env` dedup, `.gitignore` update, and the Secret Manager + container pushes.
- If Scaleway credentials aren't configured yet, or no container exists yet under this app's name (see `_check-deps`'s `container` check - the harness resolves the Project, namespace, and container by name, never from a linkage file), the corresponding steps are **skipped with a warning**, not treated as a failure - the `.env` write still lands. This is expected during early bootstrap, before a container exists.
- If the script exits non-zero, relay the failure message to the caller - don't retry the push logic yourself. A non-zero exit means a Secret Manager or container push genuinely failed (credentials/linkage WERE present but the API call errored), not that they were merely unconfigured.
