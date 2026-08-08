---
name: _pull-env-vars
description: Internal helper to pull environment variables from Scaleway Secret Manager and return them as JSON or merge them into the local .env.local. Delegates to the bundled scripts/pull-env-vars.mjs. Used by skills that need to read current secret state - rotate-secret (verify before rotation), debug flows ("why is this var weird in prod"), disaster recovery (restore .env.local from Secret Manager). Not meant to be invoked directly by users.
user-invocable: false
allowed-tools: Bash
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (gh, scw)."
---

# Pull Env Vars - Internal helper

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: English). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Pull env vars FROM Scaleway Secret Manager for inspection or restoration. Delegates to a bundled Node script - never reimplement the pull logic inline.

Secret Manager holds one canonical value per key (CONTRACT.md §2 "Secret Manager naming": a secret's name IS the env var name, one Scaleway Project per app). There is no per-environment target on the read side - that concept lives on the **write** side (which container gets which value, see `_push-env-vars`), not on read-back.

## Invocation

From the **project root**, call:

```bash
node "${CLAUDE_SKILL_DIR}/../../scripts/pull-env-vars.mjs" [--keys=KEY1,KEY2] [--write-to-local] [--json]
```

### Flags

- `--keys=KEY1,KEY2,...` - optional. Only fetch these secret names. If omitted, lists and pulls every secret in the project's Secret Manager.
- `--write-to-local` - optional. Merge the pulled values into `.env.local` (preserves existing keys not in the pull, adds new ones, updates values for keys present in both).
- `--json` - optional. Output machine-readable JSON `{KEY: value, ...}`. Default is human-readable text suitable for relay to the user (without showing the values for sensitive keys, only key names + presence).

### Output modes

**Default (text, safe to relay):**
```
3 variables pulled from Secret Manager:
  - AUTH_SECRET (present)
  - DATABASE_URL (present)
  - TEM_SENDER_EMAIL (present)
```

**With `--json` (full values, NOT to relay verbatim to chat):**
```json
{"AUTH_SECRET":"xxx","DATABASE_URL":"postgres://..."}
```

⚠️ **If you use `--json`, capture the output into a shell variable, process it, and NEVER relay it in plain text to the user.** The JSON output is meant for programmatic use on the script side (for example: comparing a value before/after rotation, restoring a lost `.env.local`).

## Rules

- **Always** use this helper (never call `scripts/scaleway/secrets.mjs` inline for this purpose) so the merge logic and quoting are uniform.
- Requires Scaleway operator credentials (`SCW_ACCESS_KEY`/`SCW_SECRET_KEY`) - check with `_check-deps`'s `scaleway` check first if unsure.
- The `--write-to-local` merge **never deletes** keys that are present in `.env.local` but absent from the pull. Handle removals by hand if needed.
- Keys requested via `--keys` that don't exist in Secret Manager are silently excluded from the output (noted on stderr only) - not a failure.
- If the script fails, relay the error message - do not try to reimplement it.

## Security

The pulled values are written only:
- To `.env.local` if `--write-to-local` (this file is `.gitignore`d by default)
- To stdout as JSON if `--json` (to be handled with care)

Never displayed in plain text on stderr or in the logs.
