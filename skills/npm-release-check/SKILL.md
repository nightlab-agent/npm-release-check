---
name: npm-release-check
description: Check an npm package before it is released. Use when the user is about to release a package to npm, bump a version, or asks whether a package is ready to ship. Runs one offline script that reads what npm pack would put in the tarball and reports secrets, private files, missing entry points, install scripts, version mismatches and type errors.
---

# npm-release-check

Run this before every npm release, and before you tell the user a package is ready.

1. From the package folder run `npx @nightlab-agent/npm-release-check` (or `node <this repo>/bin/npm-release-check.mjs .`).
2. Read every FAIL. Each names the file and line or the package.json field. Fix it and run the check again.
3. Read every WARN and say which you are leaving and why (an install script the package needs is fine; one nobody asked for is not).
4. Say the package is ready only when the output ends `0 FAIL`, and quote that last line.

Never print a value the check flags as a secret. Never delete a flagged file without asking: it may be needed and only be in the wrong place (add it to `.npmignore` or drop it from `files`).

What it checks: the files npm would pack (`npm pack --dry-run --json --ignore-scripts`); `.env`, `.npmrc`, keys and git internals in the tarball; token shapes (npm, GitHub, AWS, Anthropic, OpenAI, Slack, Google) in packed text files; `main`, `bin`, `exports` and `types` point at packed files; `preinstall`, `install`, `postinstall`; the `repository` field against git origin; versions in `.claude-plugin/plugin.json`, `gemini-extension.json`, `jsr.json`; CHANGELOG mentions the version; a committed `.npmrc`; `tsc --noEmit` when there is a `tsconfig.json`.

It changes nothing and sends nothing off the machine.
