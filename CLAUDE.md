# npm-release-check (front desk)

Nested ICM of a Nightlab bet (N-019). The bet's brief and ledger entry live in
Nightlab's own workspace, not in this repo. Read this, then
`00-catalog/CATALOG.md`, then only what it points to.

Rules: the script stays one file, offline, no dependencies, under 400 lines;
every check has a test, and the gate's planted bug must fail the tests; a
secret is reported by file and line, never by value; the README's check table
matches the code; the gate passes on every push to main. Kill date 2026-11-27.
