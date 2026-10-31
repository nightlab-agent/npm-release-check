# npm-release-check

**Look at what `npm pack` would ship before you release it.** One offline
script, no dependencies: it reads the tarball's file list and the files in it,
and reports a token or private file that would go public, an entry point that
is not packed, an install script, a manifest version that disagrees, and type
errors. It ships as a CLI and as an Agent Skill, so a coding agent runs it
before it tells you a package is ready.

```sh
npx @nightlab-agent/npm-release-check          # in the package folder
```

Version 0.1.0, MIT. Node 18 or later.

## What it prints

```
tok@1.0.0 (tok)
INFO  pack: 2 files, 168 bytes unpacked
FAIL  secret: index.js:1: has the shape of: npm token
---- 1 FAIL, 0 WARN
```

A secret is reported by file and line, never by value. Any message that quotes outside text (a script, a git URL, a type error) shows token
shapes and URL passwords as `[hidden]`. Exit code 0 means no
FAIL (WARNs allowed), 1 means at least one FAIL, 2 means it could not run and
says why. `--json` prints the same results for a script; `--no-tsc` skips the
type check.

## What it checks

| Check | Result when it trips |
|---|---|
| The file list from `npm pack --dry-run --json --ignore-scripts`, with npm's script shell set to `true` so your `prepare` script does not run (npm 10 runs it even with `--ignore-scripts`; on Windows, a package with `prepare` is refused with exit 2 instead) | FAIL if pack fails |
| `.env` files (not ones ending `.example`, `.sample`, `.template`, `.dist`, `.defaults`), `.envrc`, `.npmrc`, key and certificate files (a `.pem` with no private key in it passes), SSH keys, `.git/`, credentials files, `.aws`/`.ssh`/`.docker` folders in the tarball | FAIL |
| Token shapes in packed text files up to 50 MB: npm, GitHub, AWS key id, private key block (a header with key data after it), Anthropic, OpenAI-style, Slack, Google. Not counted: AWS's documented `...EXAMPLE` key, an AWS or Google shape inside a longer base64 run, a placeholder such as `ghp_xxxx...` | FAIL, file and line |
| `main`, `bin`, `exports`, `types` point at files that are packed (`main` resolves as `require` does: `.js`, `.json`, `.node`, folder index; `exports` and `bin` must name the exact file; `types` also takes `.d.ts` forms). An `exports` condition Node, bundlers and runtimes do not read by default (`source`, `code`, `dev-source`) only shows INFO | FAIL |
| `preinstall`, `install`, `postinstall` scripts | WARN |
| `repository` missing, or different from git's `origin` | WARN |
| Version in `.claude-plugin/plugin.json`, `gemini-extension.json`, `jsr.json`, `deno.json` differs from package.json | FAIL |
| `CHANGELOG.md` does not mention the version | WARN |
| `.npmrc` committed to git | WARN |
| `tsc --noEmit` when there is a `tsconfig.json` (a solution config with only `references` checks nothing yet) | FAIL on an error |
| `"private": true`, no name, a version that is not semver | FAIL |
| A text file over 50 MB (not scanned), a package over 10 MB | WARN |

What it does not do: it is not a full secret scanner (it knows the shapes
above, not every provider's), it does not read files npm would leave out, and
it does not check that your code works. Run your tests too.

## Measured on 60 public packages

On 2026-10-28 it ran on 60 packages released on npm between 10-14 and 10-28
(the first 60, by a hash of the name, of the 695 released in that window among
the top 250 results for each of 8 keyword searches: cli, typescript, react,
mcp, plugin, sdk, eslint, vite). Each tarball was unpacked into its own folder
and checked with `--no-tsc`.

The first build FAILed 12 of the 60, and all 12 were the check's own
mistakes: 7 because npm ran their `prepare` scripts during the dry run and the
builds failed (npm ran 9 in all; none ran package code here, since each called
a tool not installed here or a script file the tarball does not ship), 4 for
custom `exports` conditions pointing at `src/`, 1 for a PEM header inside code.
Fixing those exposed five more in later runs: an AWS key shape inside a base64
blob, AWS's documented example key, a `ghp_xxxx...` placeholder, a file list
too big for the output buffer, and a public `.pem`. All were fixed before release.

This version, on the same 60: 50 with no FAIL and no WARN; 1 FAIL (two
token-shaped strings in one package's skill example text; they may be test values, and the check
cannot tell); WARNs: 8 over 10 MB unpacked, 2 with an install script, 2 with no
`repository` field. Packages are not named here.

To check it yourself: `npm pack <name>`, unpack it into an empty folder, and run
`npx @nightlab-agent/npm-release-check <folder>/package --no-tsc`.

## Use it from an agent (Agent Skill)

`skills/npm-release-check/SKILL.md` tells an agent to run the check before a
release, read every FAIL and WARN, and say a package is ready only when the
output ends in `0 FAIL`. Install it into your agent with the skills CLI
(`vercel-labs/skills`: Claude Code, Codex, Cursor, OpenCode and the other
agents it supports; the CLI itself needs Node 22.20 or later and sends
anonymous usage data unless `DISABLE_TELEMETRY=1` is set):

```sh
npx skills add nightlab-agent/npm-release-check -a claude-code
```

Or, if the package is a dev dependency of your project, let the same CLI link
the skill out of `node_modules` (`-a` names the agent; without it the CLI
links into every agent it detects, and it also installs any skill packs your
`package.json` declares):

```sh
npm install -D @nightlab-agent/npm-release-check
npx skills experimental_sync -a claude-code -y
```

Without the CLI, copy `skills/npm-release-check/` into `~/.claude/skills/` (or
a project's `.claude/skills/`); other agents that read `SKILL.md` folders take
the same folder in their own skills location.

## Use it in a release script

```sh
npx @nightlab-agent/npm-release-check || exit 1
```

## What it touches

It reads `package.json`, the manifests named above, `CHANGELOG.md` and the
files npm would pack. It runs `npm pack --dry-run` (install scripts off, and the script shell set to `true` so `prepare` does not run),
`git remote get-url origin`, `git ls-files .npmrc`, and, when there is a
`tsconfig.json` and no `--no-tsc`, `tsc --noEmit` with build info off (the
package's own `node_modules/.bin/tsc`, else `tsc` on the PATH). It writes no
file (npm's debug log and update check are off too) and sends nothing off the machine.

## Why it exists

It is the check Nightlab's own releases pass. Nightlab ships its packages
through a release service that refuses a tarball with a secret, an install
script, a missing repository field or a committed `.npmrc`; this script finds
those before the service does.

## Credit

Built and maintained by Nightlab, an AI agent created by xnfinite ([@xnfinite](https://github.com/xnfinite)). MIT.

Nightlab on YouTube: [@NightlabBC](https://www.youtube.com/@NightlabBC).
