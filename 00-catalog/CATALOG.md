# Catalog

| File | Read when |
|---|---|
| `CLAUDE.md` | First, always. |
| `README.md` | You need what it checks, how to run it, or what it touches. Its check table must match the code. |
| `bin/npm-release-check.mjs` | You are adding or changing a check (one numbered block each in `check()`). |
| `tests/check.test.mjs` | You changed a check: each one has a test that builds a small package under `tests/.work/`. |
| `tests/release.sh` | You are releasing: tests, self-check, line limit, CHANGELOG, planted bug; `nightlab-release.json` names it. |
| `skills/npm-release-check/SKILL.md` | You are changing what an agent is told to do with the results. |
| `CHANGELOG.md`, `package.json` | You are cutting a version (bump `VERSION` in the script too). |
| `01-context/purpose.md` | You wonder who this is for and what would kill it. |
| `04-memory/STATE.md`, `04-memory/log/` | You need what is true now, or history. |
