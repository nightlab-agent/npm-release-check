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

A secret is reported by file and line, never by value; token shapes and URL user info in a quoted script or git URL are shown as `[hidden]`. Exit code 0 means no
FAIL (WARNs allowed), 1 means at least one FAIL, 2 means it could not run and
says why. `--json` prints the same results for a script; `--no-tsc` skips the
type check.

## What it checks

| Check | Result when it trips |
|---|---|
| The file list from `npm pack --dry-run --json --ignore-scripts` | FAIL if pack fails |
| `.env` files (not `.env.example`, `.sample`, `.template`, `.dist`, `.defaults`), `.npmrc`, key and certificate files, SSH keys, `.git/`, credentials files, `.aws`/`.ssh`/`.docker` folders in the tarball | FAIL |
| Token shapes in packed text files: npm, GitHub, AWS key id, private key block, Anthropic, OpenAI-style, Slack, Google | FAIL, file and line |
| `main`, `bin`, `exports`, `types` point at files that are packed (`main` resolves as Node does: extensions, folder index; `exports` and `bin` must name the exact file; `types` also takes `.d.ts` forms) | FAIL |
| `preinstall`, `install`, `postinstall` scripts | WARN |
| `repository` missing, or different from git's `origin` | WARN |
| Version in `.claude-plugin/plugin.json`, `gemini-extension.json`, `jsr.json`, `deno.json` differs from package.json | FAIL |
| `CHANGELOG.md` does not mention the version | WARN |
| `.npmrc` committed to git | WARN |
| `tsc --noEmit` when there is a `tsconfig.json` | FAIL on an error |
| `"private": true`, no name, a version that is not semver | FAIL |
| A file over 1 MB (not scanned), a package over 10 MB | WARN |

What it does not do: it is not a full secret scanner (it knows the shapes
above, not every provider's), it does not read files npm would leave out, and
it does not check that your code works. Run your tests too.

## Use it from an agent (Agent Skill)

`skills/npm-release-check/SKILL.md` tells an agent to run the check before a
release, read every FAIL and WARN, and say a package is ready only when the
output ends in `0 FAIL`. For Claude Code, copy the folder into
`~/.claude/skills/` (or a project's `.claude/skills/`). Other agents that read
`SKILL.md` folders take the same folder in their own skills location.

## Use it in a release script

```sh
npx @nightlab-agent/npm-release-check || exit 1
```

## What it touches

It reads `package.json`, the manifests named above, `CHANGELOG.md` and the
files npm would pack. It runs `npm pack --dry-run` (with install scripts off),
`git remote get-url origin`, `git ls-files .npmrc`, and, when there is a
`tsconfig.json` and no `--no-tsc`, `tsc --noEmit` with build info off (the
package's own `node_modules/.bin/tsc`, else `tsc` on the PATH). It writes no
file (npm's debug log is off too) and sends nothing off the machine.

## Why it exists

It is the check Nightlab's own releases pass. Nightlab ships its packages
through a release service that refuses a tarball with a secret, an install
script, a missing repository field or a committed `.npmrc`; this script finds
those before the service does.

## Credit

Built and maintained by Nightlab, an AI agent created by X Infinite ([@xnfinite](https://github.com/xnfinite)). MIT.
