// Each test builds a small package under tests/.work, runs the check on it and reads the result.
// Token-shaped strings are assembled at run time so this repo never holds one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
// A token-shaped string with varied characters (a run of one letter reads as a placeholder).
const mix = (n, at = 0) => Array.from({ length: n }, (_, i) => "aZ3kQ9mX7pR2"[(i + at) % 12]).join("");
const good = { main: "index.js", repository: "https://github.com/example/good" };

test("a clean package passes", () => {
  const r = check(pkgDir("clean", good, { "index.js": "module.exports = 1;\n" }));
  assert.deepEqual(ids(r, "FAIL"), []);
  assert.deepEqual(ids(r, "WARN"), []);
  assert.ok(ids(r, "PASS").includes("all"));
});

test("a token inside a packed file fails, and the value is not printed", () => {
  const token = "npm_" + mix(36);
  const r = check(pkgDir("tok", good, { "index.js": `const t = "${token}";\n` }));
  const hit = r.results.find((x) => x.id === "secret");
  assert.ok(hit, "secret found");
  assert.match(hit.message, /index\.js:1/);
  assert.ok(!hit.message.includes(token));
});

test("a private key block fails", () => {
  const block = "-----BEGIN " + "RSA PRIVATE KEY-----\n" + "MIIEow".repeat(8) + "\n";
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

test("a template .env file passes; a real one in a folder fails", () => {
  const files = { "index.js": "1\n", ".env.example": "A=\n", ".env.local.sample": "A=\n", "cfg/.env.local": "A=1\n" };
  const r = check(pkgDir("envex", { ...good, files: ["index.js", ".env.example", ".env.local.sample", "cfg/.env.local"] }, files));
  const hits = r.results.filter((x) => x.id === "private-file").map((x) => x.message);
  assert.equal(hits.length, 1);
  assert.match(hits[0], /cfg\/\.env\.local/);
});

test("main resolves as Node does; exports, bin and types do not take a .js guess", () => {
  const files = { "lib/index.js": "1\n", "data.json": "{}\n", "index.js": "1\n", "dist/index.js": "1\n", "cli.js": "1\n" };
  for (const [name, main] of [["mdir", "./lib/"], ["mdot", "."], ["mjson", "data"]])
    assert.deepEqual(ids(check(pkgDir(name, { ...good, main }, files)), "FAIL"), [], name);
  for (const [name, extra] of [
    ["xnoext", { exports: { ".": "./dist/index" } }],
    ["bnoext", { bin: { x: "cli" } }],
    ["tnoext", { types: "./index" }],
  ])
    assert.ok(ids(check(pkgDir(name, { ...good, ...extra }, files)), "FAIL").includes("entry"), name);
});

test("a token in a script or a git URL is hidden in the message", () => {
  const token = "ghp_" + mix(36);
  const dir = pkgDir("leak", { ...good, scripts: { postinstall: `curl -H "token ${token}" x` } }, { "index.js": "1\n" });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", `https://x:${token}@github.com/example/other`]);
  const r = check(dir);
  for (const id of ["install-script", "repository"]) {
    const m = r.results.find((x) => x.id === id).message;
    assert.ok(!m.includes(token) && m.includes("[hidden]"), id);
  }
});

test("git:// and https forms of one repository agree", () => {
  const dir = pkgDir("forms", { ...good, repository: "git://github.com/example/good.git" }, { "index.js": "1\n" });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/example/good"]);
  assert.deepEqual(ids(check(dir), "WARN"), []);
});

test("a type error that quotes a token is hidden; a .envrc fails", () => {
  const token = "ghp_" + mix(36, 5);
  const dir = pkgDir("tsctok", { ...good, files: ["index.js", ".envrc"] }, {
    "index.js": "1\n",
    ".envrc": "export A=1\n",
    "tsconfig.json": '{"include":["src/a.ts"]}',
    "src/a.ts": `export const x: "a" = "${token}";\n`,
  });
  const r = check(dir, { tsc: false });
  assert.ok(r.results.some((x) => x.id === "private-file" && x.message.includes(".envrc")));
  const tsc = check(dir).results.find((x) => x.id === "tsc"); // absent when no tsc is installed
  if (tsc) assert.ok(!tsc.message.includes(token));
});

test("main does not take .mjs (require never does); a plain URL user is not hidden", () => {
  const r = check(pkgDir("mmjs", { ...good, main: "index" }, { "index.mjs": "1\n" }));
  assert.ok(ids(r, "FAIL").includes("entry"));
  const dir = pkgDir("urluser", good, { "index.js": "1\n" });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "remote", "add", "origin", "https://bob@gitlab.com/example/other"]);
  const m = check(dir).results.find((x) => x.id === "repository").message;
  assert.match(m, /\/\/bob@gitlab\.com/);
});

test("npm pack does not run the prepare script", () => {
  const dir = pkgDir("prep", { ...good, scripts: { prepare: "echo ran > ran.txt" } }, { "index.js": "1\n" });
  const r = check(dir);
  assert.ok(!existsSync(join(dir, "ran.txt")), "prepare ran");
  assert.deepEqual(ids(r, "FAIL"), []);
});

test("a PEM header in code passes; key data after it, escaped or on the next line, fails", () => {
  const head = "-----BEGIN " + "PRIVATE KEY-----";
  const body = "MIIEvQ".repeat(8);
  const code = check(pkgDir("pemcode", good, { "index.js": `return ('${head}\\n' +\n  key);\n` }));
  assert.deepEqual(ids(code, "FAIL"), []);
  const esc = check(pkgDir("pemesc", good, { "index.js": `const k = "${head}\\n${body}";\n` }));
  assert.ok(ids(esc, "FAIL").includes("secret"));
  const crlf = check(pkgDir("pemcrlf", { ...good, files: ["index.js", "k.txt"] }, { "index.js": "1\n", "k.txt": `${head}\r\n${body}\r\n` }));
  assert.ok(ids(crlf, "FAIL").includes("secret"));
});

test("a custom exports condition pointing at source is INFO; import pointing nowhere still fails", () => {
  const exp = { ".": { source: "./src/index.ts", import: "./index.js" } };
  const r = check(pkgDir("custom", { ...good, exports: exp }, { "index.js": "1\n" }));
  assert.deepEqual(ids(r, "FAIL"), []);
  assert.ok(r.results.some((x) => x.status === "INFO" && /"source" is a custom condition/.test(x.message)));
  const bad = check(pkgDir("custombad", { ...good, exports: { ".": { source: "./src/index.ts", import: "./dist/index.js" } } }, { "index.js": "1\n" }));
  assert.ok(ids(bad, "FAIL").includes("entry"));
});

test("a file over 1 MB is still scanned for tokens", () => {
  const token = "npm_" + mix(36, 3);
  const big = "// pad\n".repeat(200000) + `const t = "${token}";\n`;
  const r = check(pkgDir("bigtok", { ...good, files: ["index.js", "big.js"] }, { "index.js": "1\n", "big.js": big }));
  assert.ok(ids(r, "FAIL").includes("secret"));
  assert.ok(!ids(r, "WARN").includes("big-file"));
});

test("an AWS key shape inside a base64 run, or AWS's example key, passes; a standalone one fails", () => {
  const key = "AKIA" + "Q7RZ" + "2M4X" + "J9KP" + "W3TB";
  const blob = check(pkgDir("awsblob", good, { "index.js": `var R = "data:;base64,x9${key}Lq==";\n` }));
  assert.deepEqual(ids(blob, "FAIL"), []);
  const example = check(pkgDir("awsex", good, { "index.js": `// ${"AKIA" + "IOSFODNN7" + "EXAMPLE"}\n` }));
  assert.deepEqual(ids(example, "FAIL"), []);
  const real = check(pkgDir("awsreal", good, { "index.js": `const id = "${key}";\n` }));
  assert.ok(ids(real, "FAIL").includes("secret"));
});

test("a package whose file list is over 1 MB of JSON still packs", () => {
  const files = { "index.js": "1\n" };
  for (let i = 0; i < 4000; i++) files[`lib/${"f".repeat(200)}${i}.js`] = "1\n";
  const r = check(pkgDir("many", good, files));
  assert.deepEqual(ids(r, "FAIL"), []);
});

test("a placeholder token passes; a .pem with only a public key passes, one with a private key fails", () => {
  const ph = check(pkgDir("placeholder", good, { "index.js": `// export GH=${"ghp_" + "x".repeat(36)}\n` }));
  assert.deepEqual(ids(ph, "FAIL"), []);
  const pub = check(pkgDir("pubpem", { ...good, files: ["index.js", "k.pem"] }, { "index.js": "1\n", "k.pem": "-----BEGIN PUBLIC KEY-----\nabc\n" }));
  assert.deepEqual(ids(pub, "FAIL"), []);
  const priv = check(pkgDir("privpem", { ...good, files: ["index.js", "k.pem"] }, { "index.js": "1\n", "k.pem": "-----BEGIN " + "PRIVATE KEY-----\nabc\n" }));
  assert.ok(ids(priv, "FAIL").includes("private-file"));
});
