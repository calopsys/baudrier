#!/usr/bin/env node
// open-url.mjs - Prints a URL for the user to open (no local browser to launch
// on Claude Code web).
//
// Usage:
//   node open-url.mjs "https://example.com/some/path"
//   node open-url.mjs --json "https://example.com/some/path"
//
// --json prints {"ok":true,"opened":false,"method":"none","url":"..."}. In
// human mode it prints the marker OPEN_URL_MANUAL followed by the URL, so
// Claude can relay a clickable link to the user.
//
// Exit codes:
//   0 = URL printed for the user
//   1 = invalid input (missing / non-http(s) URL)

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const url = args.find((a) => !a.startsWith("--"));

// Scheme validation stays even with no launcher: this value reaches the user's
// clipboard/terminal, and `file://` or `javascript:` must never be relayed.
if (!url || !/^https?:\/\//.test(url)) {
  const usage = "Usage: open-url.mjs [--json] <https-url>";
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, opened: false, method: "none", reason: usage }) + "\n");
  else console.error(usage);
  process.exit(1);
}

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({ ok: true, opened: false, method: "none", url }) + "\n");
} else {
  process.stdout.write(
    "OPEN_URL_MANUAL\n" +
      "Aucun navigateur ne peut être ouvert automatiquement sur cette machine.\n" +
      "Ouvrez ce lien vous-même :\n" +
      `${url}\n`,
  );
}
process.exit(0);
