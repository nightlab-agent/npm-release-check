#!/bin/sh
# Release gate: tests, the tool passes on itself, file sizes, CHANGELOG, and a planted bug must fail the tests.
set -e
cd "$(dirname "$0")/.."
node --test tests/check.test.mjs
node bin/npm-release-check.mjs . --no-tsc
# Type check the script (JS with checkJs; implicit any allowed, wrong properties and calls fail). TSC and TYPES default to Nightlab's tools folder; a missing tsc fails.
TSC=${TSC:-/nightlab/tools/node_modules/.bin/tsc}
TYPES=${TYPES:-/nightlab/tools/node_modules/@types}
[ -x "$TSC" ] || { echo "FAIL no tsc at $TSC (set TSC)"; exit 1; }
"$TSC" --noEmit --allowJs --checkJs --noImplicitAny false --useUnknownInCatchVariables false --target es2022 --module nodenext --moduleResolution nodenext --typeRoots "$TYPES" --types node bin/npm-release-check.mjs
for f in bin/npm-release-check.mjs tests/check.test.mjs; do
  n=$(wc -l < "$f"); [ "$n" -le 400 ] || { echo "FAIL $f has $n lines"; exit 1; }
done
v=$(node -p 'require("./package.json").version')
grep -q "$v" CHANGELOG.md || { echo "FAIL CHANGELOG lacks $v"; exit 1; }
m=tests/.work/mut
rm -rf "$m" && mkdir -p "$m/bin" "$m/tests"
sed 's/if (rx.test(line) \&\& !placeholder(line, rx)) add("FAIL", "secret"/if (false) add("FAIL", "secret"/' bin/npm-release-check.mjs > "$m/bin/npm-release-check.mjs"
cmp -s bin/npm-release-check.mjs "$m/bin/npm-release-check.mjs" && { echo "FAIL mutation did not apply"; exit 1; }
cp tests/check.test.mjs "$m/tests/"
if node --test "$m/tests/check.test.mjs" >/dev/null 2>&1; then echo "FAIL a disabled secret check still passes the tests"; exit 1; fi
echo "gate PASS"
