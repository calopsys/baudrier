---
name: add-dark-mode
description: Add dark mode support (light / dark / system) to an existing Next.js + Tailwind v4 project using next-themes. Configures the dark variant in globals.css, audits existing colors and proposes dark-mode tokens, mounts ThemeProvider in the root layout, and creates a 3-state ThemeToggle component ready to drop in the header / navbar / footer.
argument-hint: ""
compatibility: "Agent Skills standard (Claude Code or Codex). Requires Node.js; most workflows also use pnpm, git, and project CLIs (scw, gh)."
---

# Add Dark Mode - next-themes + Tailwind v4

## Communication
- Detect the user's language from their messages and ALWAYS reply in that language (default: English). This applies to every user-facing message: questions, progress, confirmations, summaries, errors.
- Use plain, non-technical business language. Never expose internal script names (*.mjs) or jargon; describe actions in human terms.
- When generating user-facing content for the scaffolded project (UI labels, emails, copy), write it in the user's language too.
- Show progress as a short natural-language checklist (in-progress and done states).

Adds dark mode support to the current Next.js project with `next-themes` (the standard for Next.js dark mode). 3 states (light / dark / system, default `system`), zero flash on load, persisted in `localStorage`. Configures the Tailwind v4 dark variant in `globals.css`, audits existing colors and proposes dark variants, creates `ThemeProvider` and `ThemeToggle` components, and mounts the provider in the root layout. Can be called by `/bootstrap` or standalone on an existing project.

---

## Step 0 - Preflight: dark mode already configured?

Invoke `_detect-project-root` to get `PROJECT_TYPE`. **If `PROJECT_TYPE=landing`, skip straight to the "Astro branch" section below** - a site vitrine has no `next-themes`, no React, and its own preflight check. Everything from here to Step 12 is the `PROJECT_TYPE=application` (Next.js) flow.

**First of all**, invoke `_check-deps dark-mode` to detect whether `next-themes` is already in place:

```bash
result=$(node "${CLAUDE_SKILL_DIR}/../../scripts/check-deps.mjs" dark-mode)
dm_ok=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8'))['dark-mode'].ok)")
layout_file=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8'))['dark-mode'].layoutFile || '')")
css_file=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8'))['dark-mode'].cssFile || '')")
dark_variant=$(echo "$result" | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8'))['dark-mode'].darkVariantConfigured)")
```

### If `dm_ok = true` -> reconfiguration mode

`next-themes` is already installed and the ThemeProvider is mounted (layout: `$layout_file`). Do NOT recreate the provider or rewrite the layout. Show a menu:

> ## 🌗 Dark mode is already in place on your project
>
> ThemeProvider mounted in `$layout_file`. What do you want to do?
>
> 1. **Change the default mode** (system / light / dark - the one that applies when a visitor arrives with no saved preference)
> 2. **Reinstall the toggle button (ThemeToggle)** - if the component was deleted or is broken
> 3. **Redo the color audit** - I re-read your `globals.css` and propose dark variants for the tokens that don't have any, or to readjust the ones that render poorly
> 4. **Help place the button in the UI** - I detect your existing header/navbar/footer and suggest where to insert `<ThemeToggle />`
> 5. **Uninstall dark mode** - removes `next-themes`, the provider, the toggle and restores the `<html>` without `suppressHydrationWarning` (does NOT touch the `dark:` variants already written in your components - up to you to clean them up if you want)
> 6. **Something else** - tell me what you want

Wait for the answer.

**Depending on the answer**:

| Choice | Action |
|---|---|
| 1 (default mode) | Ask: `system` / `light` / `dark`. Modify the `defaultTheme` prop of the `ThemeProvider` in `$layout_file`. Remind the user that visitors with a preference already stored in `localStorage` are NOT affected (only new visitors). |
| 2 (reinstall toggle) | Re-run only the "Create ThemeToggle component" section (Step 6 of the nominal flow). |
| 3 (color audit) | Re-run only the "Audit existing colors + propose dark variants" section (Step 4 of the nominal flow). |
| 4 (button placement) | Jump directly to **Step 9** (guided placement of the toggle in header/navbar/footer). |
| 5 (uninstall) | Ask for explicit confirmation. Then: `pnpm remove next-themes` (in `WEB_DIR`), remove `<ThemeProvider>` from the layout, remove `suppressHydrationWarning` from `<html>`, delete `ThemeProvider.tsx` and `ThemeToggle.tsx`, remove `@custom-variant dark` from `globals.css`, remove the dark mode section from `CLAUDE.md`. Do NOT purge the `dark:*` variants from the components - that is too invasive and the user may want to keep the work. Tell them to do it by hand with a grep if they want. |
| 6 (something else) | Ask for clarification. Do not launch the full flow by default. |

**If `dark_variant = false` but `dm_ok = true`**: before the menu above, alert the user that the ThemeProvider is mounted BUT that `@custom-variant dark` is missing in `globals.css` (a case where Tailwind v4 will not recognize the `dark:*` classes). Offer to add it automatically before continuing (Step 3 below).

**At the end**, jump directly to the **final summary**.

### If `dm_ok = false` (not configured yet)

Continue normally to Step 1. This is the initial installation flow.

---

## Astro branch (`PROJECT_TYPE=landing`)

No `next-themes`, no React, no `pnpm add`: an Astro landing toggles a `.dark` class on `<html>` with a few lines of vanilla JS, and the dark values live next to the light ones in `theme.css`. The gate at the end is `pnpm build`, not `pnpm tsc --noEmit` (a static site has nothing to type-check the way a Next app does).

### A0 - Preflight: already configured?

```bash
test -f "<WEB_DIR>/src/components/ThemeToggle.astro" && echo configured || echo not_configured
```

If `configured`: show the same kind of menu as the Next.js branch (change default mode, reinstall the toggle, redo the token audit, help place the button, uninstall), adapted to the files below. Uninstalling removes `@custom-variant dark` from `global.css`, the `.dark { ... }` block from `theme.css`, the inline script at the BaseLayout anchor, and `ThemeToggle.astro`.

### A1 - Enable the dark variant in `global.css`

Add, right after `@import "tailwindcss";`:

```css
@custom-variant dark (&:where(.dark, .dark *));
```

Same reasoning as the Next.js branch (Step 3 above): Tailwind v4 reads no JS config, so the variant must be declared in CSS, and `:where()` keeps its specificity at 0-0-0. If already present (re-run case), do not duplicate it.

### A2 - Add dark values for the semantic tokens in `theme.css`

The landing's semantic tokens (`--color-surface`, `--color-ink`, `--color-accent`, etc. - see `templates/landing/src/styles/presets/*.css`) already live in `<WEB_DIR>/src/styles/theme.css`. Redefine them under a `.dark { ... }` block in the same file, right after the `@theme` block - do not create a second file:

```css
.dark {
  --color-surface: oklch(0.16 0.02 250);
  --color-ink: oklch(0.95 0.01 250);
  /* ...one line per existing token, same rules as Step 4.b above (keep the
     accent hue, adjust lightness, subtle dark borders) */
}
```

Present the proposed values to the user before writing them, exactly as the Next.js branch does in Step 4.b.

### A3 - Inject the pre-hydration theme script at the BaseLayout anchor

Astro ships no client runtime by default, so the anti-flash trick is a small inline script, not a provider. Insert it at the theme anchor comment in `<WEB_DIR>/src/layouts/BaseLayout.astro` (the marked comment the template ships specifically for this, right in `<head>` so it runs before paint):

```
<!-- baudrier:theme-script-anchor - /add-dark-mode injects the pre-hydration theme script here -->
```

```astro
<script is:inline>
  (function () {
    const stored = localStorage.getItem("theme");
    const preferDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const dark = stored ? stored === "dark" : preferDark;
    document.documentElement.classList.toggle("dark", dark);
  })();
</script>
```

`is:inline` is required: Astro must not defer or bundle this script, since the whole point is to set the class before the first paint.

### A4 - Create `ThemeToggle.astro` (vanilla JS)

Create `<WEB_DIR>/src/components/ThemeToggle.astro`:

```astro
<button id="theme-toggle" type="button" aria-label="Changer de thème" class="cursor-pointer">
  <span class="theme-toggle-icon">🌓</span>
</button>

<script is:inline>
  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    const isDark = document.documentElement.classList.toggle("dark");
    localStorage.setItem("theme", isDark ? "dark" : "light");
  });
</script>
```

Two states (light/dark), not three: a static site has no server-driven "system" mode to distinguish from - A3's script already resolves `prefers-color-scheme` once, on first load, when nothing is stored yet. Adapt the icon/classes to the project's own header markup and semantic tokens.

### A5 - Propose a location for the toggle

Same idea as Step 9 above: detect `Header.astro`/`Footer.astro` and propose where to insert `<ThemeToggle />`, with the user's confirmation before editing. Add the import to the target file's frontmatter (`---` block): `import ThemeToggle from "../components/ThemeToggle.astro";` (adjust the relative path to the target file's own location).

### A6 - Update CLAUDE.md

Invoke `_update-claude-md` with:
- `stack`: `- **Dark mode**: vanilla JS (light / dark, no next-themes) + Tailwind v4 \`@custom-variant dark\``
- `conventions`:
  - `- Colors: use the semantic tokens from \`theme.css\` (\`--color-surface\`, \`--color-ink\`, etc.) - the \`.dark\` block automatically overrides them, no \`dark:*\` class needed in most components.`
  - `- The pre-hydration script at the BaseLayout theme anchor (\`is:inline\`) must run before paint - do not move it out of \`<head>\` or make it deferred/bundled.`

### A7 - Verify that it builds

```bash
cd "<WEB_DIR>"
pnpm build
```

If there's an error, read it, fix it, re-check. Do not continue until the build succeeds - Astro's `astro check` gate covers type errors, but `pnpm build` is what actually exercises this skill's own inline scripts and CSS.

### A8 - Summary

Tell the user:
- Dark mode installed: 2 modes (light / dark), first load follows the OS preference (`prefers-color-scheme`) unless already changed once
- The theme is persisted in `localStorage` on the client side, no flash on reload (pre-hydration script)
- `<ThemeToggle />` created; mention where it was inserted, or how to import it if the user said "skip"
- To adjust a color in dark: modify the `.dark { ... }` block in `theme.css`, not the components
- To re-run the skill and change the default / re-audit the colors / reposition the toggle: `/add-dark-mode`

---

## Step 1 - Detect the project structure

Invoke the `_detect-project-root` internal skill to get `PROJECT_NAME`, `WEB_DIR`, `IS_NEXTJS`, `IS_MONOREPO`. Abort if `IS_NEXTJS=no`:

> Dark mode via `/add-dark-mode` is designed for Next.js (App Router) + Tailwind v4. Your project is not detected as Next.js - operation cancelled. If this is a mistake, let me know.

Then verify it really is Tailwind v4:

```bash
cd "$WEB_DIR" && node -e "const p=require('./package.json'); const v=p.dependencies?.tailwindcss||p.devDependencies?.tailwindcss||''; process.stdout.write(v)"
```

If the version starts with `^3.` or `~3.` -> display:

> Your project uses Tailwind v3 (not v4). The syntax to enable dark mode is different (JS config via `darkMode: 'class'` instead of `@custom-variant dark` in the CSS). This skill is calibrated for Tailwind v4. Do you want me to continue anyway by adapting it for v3, or would you rather migrate to Tailwind v4 first?

Wait for the answer. If the user says to continue in v3: adapt Step 3 (modify `tailwind.config.js`/`.ts` to add `darkMode: 'class'` instead of touching the CSS) and keep everything else identical. If the user wants to migrate first: abort and tell them to do it by hand (no `/migrate-tailwind` skill available for now).

If tailwindcss is absent from `package.json` -> abort:

> Tailwind is not detected in your project. This skill assumes a Tailwind setup. Install Tailwind first (or check why it's not in your deps) then run again.

## Step 2 - Install next-themes

`cd` into `$WEB_DIR` first - otherwise `pnpm add` creates an orphan `package.json`.

```bash
cd "$WEB_DIR"
pnpm add next-themes
```

## Step 3 - Enable the dark variant in globals.css (Tailwind v4)

Locate `globals.css`. Typical locations:
- `src/app/globals.css`
- `src/styles/globals.css`
- `app/globals.css`
- (with the `apps/web/` prefix in a monorepo)

Read the file. Add (right after the `@import "tailwindcss";`, before the `@theme` blocks):

```css
@custom-variant dark (&:where(.dark, .dark *));
```

**Why this specific syntax:** Tailwind v4 no longer reads `darkMode: 'class'` from a JS config (which no longer exists in v4). The `@custom-variant dark` must target `.dark` AND all its descendants so that `dark:bg-foo` works on any element under `<html class="dark">`. The form `(&:where(.dark, .dark *))` has a specificity of 0-0-0 thanks to `:where()`, which avoids conflicts with other styles.

If the directive is already present (re-run case), do NOT duplicate it.

## Step 4 - Audit existing colors and propose dark variants

This is the most context-dependent step - every project has its own palette. Do two passes:

### 4.a - Read the tokens defined in globals.css

Extract the CSS variables from the `@theme` block (or the other `:root` blocks):

```bash
grep -E "^\s*--color-|^\s*--background|^\s*--foreground" "$globals_css" || true
```

Identify the "semantic" tokens (background, foreground, border, muted, accent, primary, etc.) - the ones for which a dark variant makes sense. Ignore the "raw" tokens that are just colors (e.g. `--color-blue-500`) - they don't need a variant.

**If the project already uses a shadcn/ui pattern** (variables like `--background`, `--foreground`, `--card`, `--card-foreground`, `--primary`, `--primary-foreground`, etc.): great, this is the standard case, we'll just add a `.dark { ... }` block with the overrides.

**If the project uses custom hardcoded colors** (e.g. `bg-[#05060F]` everywhere in the components): display to the user:

> Your project uses quite a few hardcoded colors (e.g. `bg-[#05060F]`, `text-[#F5F2EB]`, ...) rather than tokens. For dark mode to work cleanly, the ideal would be to replace these values with CSS variables we can override in dark.
>
> Do you want me to:
> 1. **Just list the hardcoded colors found** (I'll let you replace them by hand, file by file)
> 2. **Create semantic tokens** (`--background`, `--foreground`, etc.) with your current colors, then list the replacements to make in your components (you validate each replacement)
> 3. **Skip this part for now** - I'll just install the dark mode mechanism (provider + toggle) and you'll handle the colors later

Wait for the answer, process according to the choice.

### 4.b - Propose the .dark block

For the identified tokens (shadcn/ui case or custom case after replacement), propose a `.dark` block with consistent values. Proposal rules:

- `--background` light white/cream -> dark close to `oklch(0.15 0.02 250)` or a very dark gray
- `--foreground` light black/dark -> dark close to `oklch(0.95 0.01 250)` or off-white
- Accent colors: keep the hue but adjust the lightness if necessary (very saturated accents burn the eyes in dark)
- `--border`: switch to a subtle dark gray (e.g. `oklch(0.25 0.01 250)`)

Present the proposals to the user, ask them to validate / adjust:

> Here is what I propose for your `.dark` block (to paste right after your current `@theme` or `:root`):
>
> ```css
> .dark {
>   --background: oklch(0.14 0.02 250);
>   --foreground: oklch(0.96 0.01 250);
>   --card: oklch(0.18 0.02 250);
>   ...
> }
> ```
>
> Do you validate, do you want to adjust some colors, or would you rather define them yourself?

Once validated, write it into `globals.css`.

## Step 5 - Create the ThemeProvider wrapper

Create `$WEB_DIR/src/components/ThemeProvider.tsx` (or `app/components/ThemeProvider.tsx` depending on the project's convention - detect the convention by looking at where the other shared components live):

```tsx
"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ComponentProps } from "react";

export function ThemeProvider({
  children,
  ...props
}: ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
```

**Why these props:**
- `attribute="class"` -> `next-themes` adds/removes the `.dark` class on `<html>`, which Tailwind v4 targets via the `@custom-variant`
- `defaultTheme="system"` -> follows the visitor's OS preference until they click the toggle
- `enableSystem` -> exposes the `"system"` value as a separate mode (useful for the 3-state toggle)
- `disableTransitionOnChange` -> prevents the components' `transition: colors` from animating during the switch (it flashes)

## Step 6 - Create the ThemeToggle component

### 6.a - Copy the template

```bash
PLUGIN_ROOT="${CLAUDE_SKILL_DIR}/../.."
mkdir -p "$WEB_DIR/src/components"
cp "$PLUGIN_ROOT/templates/theme-toggle/plain.tsx" "$WEB_DIR/src/components/ThemeToggle.tsx"
```

The template ships hardcoded French labels (`groupLabel`, `light`, `system`, `dark`) - the app is French-only, no messages to merge.

### 6.b - Check the dependencies

**Check that `lucide-react` is installed** (present by default in most T3 / shadcn projects). Otherwise:

```bash
cd "$WEB_DIR"
pnpm add lucide-react
```

**Adapt the utility classes to the project's tokens**: if the project uses different names (e.g. `bg-card`, `text-primary`, `border-input`), replace them in the component. The idea is that the toggle uses the same tokens as the rest of the UI.

## Step 7 - Mount the ThemeProvider in the root layout

Detect the layout to modify: `src/app/layout.tsx` (or the equivalent path detected in the project, e.g. with the `apps/web/` prefix in a monorepo).

Read the target layout. Add the import:

```tsx
import { ThemeProvider } from "~/components/ThemeProvider";
```

(Adapt the import alias - `~/` or `@/` depending on the project's convention, to be detected in `tsconfig.json`.)

Wrap the `{children}` inside the `<body>`:

```tsx
<body>
  <ThemeProvider>
    {children}
  </ThemeProvider>
</body>
```

**If the `<body>` already contains other providers** (TRPCProvider, SessionProvider, etc.): insert `<ThemeProvider>` **as the outermost provider**. Recommended order (from outside to inside):

```tsx
<body>
  <ThemeProvider>
    <SessionProvider>
      <TRPCProvider>
        {children}
      </TRPCProvider>
    </SessionProvider>
  </ThemeProvider>
</body>
```

Reason: the ThemeProvider is purely presentation-UI, it does not need the context of the other providers, and putting it on the outside guarantees that the toggle works everywhere (including in components that sit above the session, for example).

## Step 8 - Add suppressHydrationWarning to <html>

In the `<html>` of the root layout (`app/layout.tsx`):

```tsx
<html lang="fr" suppressHydrationWarning>
```

**Why it's necessary:** `next-themes` modifies the `class` attribute of the `<html>` on the client side before React hydrates, to apply the right theme instantly (anti-flash). Without `suppressHydrationWarning`, React logs a warning on every load because the server-rendered HTML differs from the client HTML. The `suppressHydrationWarning` only suppresses the warnings on that specific element, not on all its children - it's safe.

If `<html>` already has `suppressHydrationWarning`, do not duplicate it.

## Step 9 - Propose a location for the toggle

Once the mechanism is in place, the `<ThemeToggle />` component exists but is not displayed anywhere. Detect candidate locations in the project:

```bash
# Look for Header, Navbar, Footer, TopBar, AppShell, etc. files
grep -rEl "header|navbar|footer|top.?bar|app.?shell" --include="*.tsx" "$WEB_DIR/src/components" 2>/dev/null
```

List the files found to the user (max 5, the most relevant ones) and propose:

> I've created the `<ThemeToggle />` component. It's ready to be inserted somewhere in your UI - typically in the header or a discreet corner. I found these candidate locations in your project:
>
> 1. `src/components/Header.tsx`
> 2. `src/components/Footer.tsx`
> 3. `src/components/Navbar.tsx`
>
> Where do you want me to insert it? Answer with a number, or with another path if you have a specific spot in mind. Say "skip" if you'd rather insert it yourself.

If the user chooses a location, open the file, add the import, and insert `<ThemeToggle />` at the most natural spot (end of the right-hand zone of the header, or next to the LanguageSwitcher if it exists). Ask for confirmation before modifying.

If the user says "skip": go straight to Step 10, mention in the summary that the component is ready to be imported from `~/components/ThemeToggle`.

## Step 10 - Update CLAUDE.md

Invoke `_update-claude-md` with:
- `stack`: `- **Dark mode**: next-themes (light / dark / system, default system) + Tailwind v4 \`@custom-variant dark\``
- `conventions`:
  - `- Colors: use the semantic tokens (\`bg-background\`, \`text-foreground\`, \`border-border\`, \`bg-card\`, etc.) rather than hardcoded colors (\`bg-[#xxx]\`). The \`.dark\` block in \`globals.css\` automatically overrides the tokens in dark mode - no need for \`dark:*\` classes in the components as long as you stick to the tokens.`
  - `- New component to style: test it in light AND in dark (switch via the \`<ThemeToggle />\`). If a visual renders poorly in dark, either adjust the corresponding token in \`.dark { ... }\`, or use a one-off \`dark:*\` variant in the component (to be avoided if possible - prefer the token).`
  - `- \`suppressHydrationWarning\` is intentionally present on the \`<html>\` (required by next-themes to avoid hydration warnings related to the class switch at boot). Do not remove it.`

## Step 11 - Verify that it builds

```bash
cd "$WEB_DIR"
pnpm tsc --noEmit
```

If there's an error: read it, fix it (typically an import path or a misresolved alias), re-check. Do not continue until it type-checks.

## Step 12 - Summary

Tell the user:
- Dark mode installed: 3 modes (light / system / dark), default **system** (follows the OS)
- The theme is persisted in `localStorage` on the client side, no flash on reload
- Components created: `<ThemeProvider>` (mounted in the layout) and `<ThemeToggle>` (3-states with Sun/Monitor/Moon icons)
- Tailwind v4: `@custom-variant dark` added in `globals.css`, plus the `.dark { ... }` block with the override tokens
- If the toggle was inserted in Step 9: specify where. Otherwise: remind how to import it (`import { ThemeToggle } from "~/components/ThemeToggle"`)
- To test: reload the site, the toggle should appear, click each mode and check that the colors switch
- To adjust a color in dark: modify the `.dark { ... }` block in `globals.css`, not the components
- To re-run the skill and change the default / re-audit the colors / reposition the toggle: `/add-dark-mode`
