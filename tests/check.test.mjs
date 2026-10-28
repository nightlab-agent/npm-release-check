// Each test builds a small package under tests/.work, runs the check on it and reads the result.
// Token-shaped strings are assembled at run time so this repo never holds one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { check } from "../bin/npm-release-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const work = join(here, ".work");
const cli = join(here, "..", "bin", "npm-release-check.mjs");
// Fixtures live inside this repo; stop git from finding its origin above them.
process.env.GIT_CEILING_DIRECTORIES = here;

function pkgDir(name, pkg, files = {}) {
  const dir = join(work, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...pkg }, null, 2));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

const ids = (r, status) => r.results.filter((x) => x.status === status).map((x) => x.id);
const good = { main: "index.js", repository: "https://github.com/example/good" };

test("a clean package passes", () => {
  const r = check(pkgDir("clean", good, { "index.js": "module.exports = 1;\n" }));
  assert.deepEqual(ids(r, "FAIL"), []);
  assert.deepEqual(ids(r, "WARN"), []);
  assert.ok(ids(r, "PASS").includes("all"));
});

test("a token inside a packed file fails, and the value is not printed", () => {
  const token = "npm_" + "A".repeat(18) + "b".repeat(18);
  const r = check(pkgDir("tok", good, { "index.js": `const t = "${token}";\n` }));
  const hit = r.results.find((x) => x.id === "secret");
  assert.ok(hit, "secret found");
  assert.match(hit.message, /index\.js:1/);
  assert.ok(!hit.message.includes(token));
});

test("a private key block fails", () => {
  const block = "-----BEGIN " + "RSA PRIVATE KEY-----\nabc\n";
  const r = check(pkgDir("pem", { ...good, files: ["index.js", "notes.txt"] }, { "index.js": "1\n", "notes.txt": block }));
  assert.ok(ids(r, "FAIL").includes("secret"));
});

test("an .env file in the tarball fails", () => {
  const r = check(pkgDir("env", { ...good, files: ["index.js", ".env"] }, { "index.js": "1\n", ".env": "A=1\n" }));
  assert.ok(ids(r, "FAIL").includes("private-file"));
});

test("main pointing at a file that is not packed fails", () => {
  const r = check(pkgDir("nomain", { ...good, main: "dist/index.js" }, { "index.js": "1\n" }));
  assert.ok(ids(r, "FAIL").includes("entry"));
});

test("a bin and an exports map that exist pass; a missing export fails", () => {
  const files = { "cli.js": "#!/usr/bin/env node\n", "lib/a.js": "1\n" };
  const ok = check(pkgDir("binok", { ...good, main: undefined, bin: { x: "./cli.js" }, exports: { ".": "./lib/a.js" } }, files));
  assert.deepEqual(ids(ok, "FAIL"), []);
  const bad = check(pkgDir("expbad", { ...good, main: undefined, exports: { ".": { import: "./lib/missing.mjs" } } }, files));
  assert.ok(ids(bad, "FAIL").includes("entry"));
});

test("an install script warns", () => {
  const r = check(pkgDir("post", { ...good, scripts: { postinstall: "node setup.js" } }, { "index.js": "1\n" }));
  assert.ok(ids(r, "WARN").includes("install-script"));
  assert.deepEqual(ids(r, "FAIL"), []);
});

test("a missing repository field warns", () => {
  const r = check(pkgDir("norepo", { main: "index.js" }, { "index.js": "1\n" }));
  assert.ok(ids(r, "WARN").includes("repository"));
});

test("a plugin.json version that disagrees fails", () => {
  const r = check(
    pkgDir("ver", good, { "index.js": "1\n", ".claude-plugin/plugin.json": JSON.stringify({ name: "ver", version: "0.9.0" }) }),
  );
  assert.ok(ids(r, "FAIL").includes("version-match"));
});

test("a CHANGELOG without the version warns", () => {
  const r = check(pkgDir("cl", good, { "index.js": "1\n", "CHANGELOG.md": "## 0.9.0\n" }));
  assert.ok(ids(r, "WARN").includes("changelog"));
});

test("private: true and a bad version fail", () => {
  const r = check(pkgDir("priv", { ...good, private: true, version: "1.0" }, { "index.js": "1\n" }));
  assert.ok(ids(r, "FAIL").includes("private"));
  assert.ok(ids(r, "FAIL").includes("version"));
});

test("the CLI exits 1 on a FAIL, 0 on a clean package, 2 with no package.json", () => {
  const run = (args) => {
    try {
      execFileSync("node", [cli, ...args], { stdio: "pipe" });
      return 0;
    } catch (e) {
      return e.status;
    }
  };
  assert.equal(run([pkgDir("cli-ok", good, { "index.js": "1\n" })]), 0);
  assert.equal(run([pkgDir("cli-bad", { ...good, main: "gone.js" }, { "index.js": "1\n" })]), 1);
  mkdirSync(join(work, "empty"), { recursive: true });
  assert.equal(run([join(work, "empty")]), 2);
  assert.equal(run(["--bogus"]), 2);
});

test("--json prints counts", () => {
  const out = execFileSync("node", [cli, "--json", pkgDir("js", good, { "index.js": "1\n" })], { encoding: "utf8" });
  const j = JSON.parse(out);
  assert.equal(j.fails, 0);
  assert.equal(j.name, "js");
});
