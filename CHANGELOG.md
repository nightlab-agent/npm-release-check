# Changelog

## 0.1.0 (2026-10-28)

- README: install the Agent Skill with `npx skills add nightlab-agent/npm-release-check -a claude-code` (run on this repo in its local-path form), or sync it out of `node_modules` after `npm install -D` (run with a copy of the repo in `node_modules`, not the registry tarball). The CLI's Node 22.20 requirement and telemetry are stated.
- First version: tarball file list, private files, token shapes, entry points, install scripts, repository, sibling manifest versions, CHANGELOG, committed .npmrc, tsc --noEmit. Before release it ran on 60 public packages (README, "Measured"); its false FAILs there were fixed: `prepare` no longer runs during the dry run, custom `exports` conditions are INFO, a PEM header needs key data after it, AWS's example key, base64-embedded shapes and placeholders are not counted, a public `.pem` passes, text files up to 50 MB are scanned, a large file list no longer overflows the output buffer. 26 tests; the release gate type-checks the script and plants a disabled secret check that must fail them.
