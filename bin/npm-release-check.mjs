#!/usr/bin/env node
// npm-release-check: look at what `npm pack` would ship before you release it.
// Offline. Reads package.json and the files npm would pack; runs `npm pack --dry-run --json`
// and, when the package has a tsconfig.json, `tsc --noEmit`. Changes nothing, sends nothing.
// Exit codes: 0 no FAIL (WARNs allowed), 1 at least one FAIL, 2 could not run (named).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";

// Files that should never be in a tarball. Matched against each packed path.
/** @type {[RegExp, string][]} */
const PRIVATE_FILES = [
  [/(^|\/)\.env(\.(?!(example|sample|template|dist|defaults)$)[^/]*)?$/i, ".env file"],
  [/(^|\/)\.npmrc$/i, ".npmrc (may hold a registry token)"],
  [/\.(pem|key|p12|pfx|keystore|jks)$/i, "key or certificate file"],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i, "SSH private key"],
  [/(^|\/)\.git\//, "git internals"],
  [/(^|\/)credentials(\.json)?$/i, "credentials file"],
  [/(^|\/)\.(aws|ssh|docker)\//i, "tool config folder"],
];

// Token shapes. A hit prints the file and line, never the value.
/** @type {[RegExp, string][]} */
const SECRET_PATTERNS = [
  [/npm_[A-Za-z0-9]{36}/, "npm token"],
  [/gh[pousr]_[A-Za-z0-9]{36}/, "GitHub token"],
  [/github_pat_[A-Za-z0-9_]{60,}/, "GitHub fine-grained token"],
  [/AKIA[0-9A-Z]{16}/, "AWS access key id"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/sk-(proj-)?[A-Za-z0-9]{32,}/, "OpenAI-style API key"],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/AIza[0-9A-Za-z_-]{35}/, "Google API key"],
];

const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

// Text from package.json or git that goes into a message: token shapes and URL user info are hidden.
function redact(text) {
  let out = String(text).replace(/\/\/[^/@\s]+@/g, "//[hidden]@");
  for (const [rx] of SECRET_PATTERNS) out = out.replace(new RegExp(rx.source, "g"), "[hidden]");
  return out;
}
const BIG_FILE = 1024 * 1024;
const BIG_PACKAGE = 10 * 1024 * 1024;

function usage() {
  return `npm-release-check ${VERSION}
Usage: npm-release-check [dir] [--json] [--no-tsc]
  dir       package folder (default: current folder)
  --json    print the results as JSON
  --no-tsc  skip the TypeScript check
Exit: 0 no FAIL, 1 a FAIL, 2 could not run.`;
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{dir: string, json: boolean, tsc: boolean, help?: boolean, version?: boolean}} */
  const opts = { dir: ".", json: false, tsc: true };
  for (const a of argv) {
    if (a === "--json") opts.json = true;
    else if (a === "--no-tsc") opts.tsc = false;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-v" || a === "--version") opts.version = true;
    else if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    else opts.dir = a;
  }
  return opts;
}

function packList(dir) {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--logs-max=0"], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(out);
  const info = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!info || !Array.isArray(info.files)) throw new Error("npm pack gave no file list");
  return info;
}

function normalizeRepo(r) {
  if (!r) return "";
  const url = typeof r === "string" ? r : r.url || "";
  return url
    .trim()
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/^github:/, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function gitOrigin(dir) {
  try {
    return execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function gitTracked(dir, path) {
  try {
    const out = execFileSync("git", ["-C", dir, "ls-files", "--", path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// Files that satisfy an entry. Node resolves main like require (extensions, folder index); exports and
// bin must name the exact file; types also takes .d.ts forms.
function candidates(p, field) {
  const base = p.replace(/\/+$/, "").replace(/^\.$/, "");
  const dirIndex = (ext) => (base ? `${base}/index${ext}` : `index${ext}`);
  if (field === "main") {
    const exts = [".js", ".json", ".node", ".cjs", ".mjs"];
    return [base, ...exts.map((e) => base + e), ...exts.map(dirIndex)].filter(Boolean);
  }
  if (field === "types") return [base, `${base}.d.ts`, dirIndex(".d.ts")].filter(Boolean);
  return [base];
}

// Paths package.json says users will load: main, bin, exports, types.
function entryPoints(pkg) {
  const paths = [];
  const add = (p, field) => {
    if (typeof p === "string" && !p.includes("*")) paths.push([p.replace(/^\.\//, ""), field]);
  };
  add(pkg.main, "main");
  add(pkg.types || pkg.typings, "types");
  if (typeof pkg.bin === "string") add(pkg.bin, "bin");
  else if (pkg.bin && typeof pkg.bin === "object") for (const [k, v] of Object.entries(pkg.bin)) add(v, `bin.${k}`);
  const walk = (node, field) => {
    if (typeof node === "string") add(node, field);
    else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) walk(v, `${field}[${k}]`);
  };
  if (pkg.exports !== undefined) walk(pkg.exports, "exports");
  return paths;
}

function findTsc(dir) {
  const local = join(dir, "node_modules", ".bin", "tsc");
  if (existsSync(local)) return local;
  try {
    execFileSync("tsc", ["--version"], { stdio: "ignore" });
    return "tsc";
  } catch {
    return "";
  }
}

export function check(dirArg, { tsc = true } = {}) {
  const dir = resolve(dirArg);
  /** @type {{status: string, id: string, message: string}[]} */
  const results = [];
  const add = (status, id, message) => results.push({ status, id, message });

  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) throw new Error(`no package.json in ${dir}`);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch (e) {
    throw new Error(`package.json is not JSON: ${e.message}`);
  }

  // 1. name and version
  if (!pkg.name) add("FAIL", "name", "package.json has no name");
  if (!pkg.version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(pkg.version))
    add("FAIL", "version", `version "${pkg.version ?? ""}" is not semver`);
  if (pkg.private === true) add("FAIL", "private", '"private": true: npm will refuse to release it');

  // 2. what the tarball holds
  let info;
  try {
    info = packList(dir);
  } catch (e) {
    const msg = (e.stderr || e.message || "").toString().split("\n").find((l) => l.trim()) || "failed";
    add("FAIL", "pack", `npm pack --dry-run failed: ${msg.trim()}`);
    return { dir, name: pkg.name, version: pkg.version, results };
  }
  const files = info.files.map((f) => f.path);
  add("INFO", "pack", `${files.length} files, ${info.unpackedSize ?? "?"} bytes unpacked`);

  // 3. private files
  for (const f of files)
    for (const [rx, what] of PRIVATE_FILES) if (rx.test(f)) add("FAIL", "private-file", `${f}: ${what} in the tarball`);

  // 4. secrets inside packed text files
  for (const f of info.files) {
    if (f.size > BIG_FILE) {
      add("WARN", "big-file", `${f.path}: ${f.size} bytes (not scanned for secrets)`);
      continue;
    }
    let text;
    try {
      text = readFileSync(join(dir, f.path), "utf8");
    } catch {
      continue;
    }
    if (text.includes("\u0000")) continue; // binary
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      for (const [rx, what] of SECRET_PATTERNS)
        if (rx.test(line)) add("FAIL", "secret", `${f.path}:${i + 1}: has the shape of: ${what}`);
    });
  }
  if ((info.unpackedSize || 0) > BIG_PACKAGE) add("WARN", "size", `unpacked size ${info.unpackedSize} bytes is over 10 MB`);

  // 5. install scripts run on every user's machine
  for (const s of INSTALL_SCRIPTS)
    if (pkg.scripts && pkg.scripts[s]) add("WARN", "install-script", `scripts.${s} runs on every install: "${redact(pkg.scripts[s])}"`);

  // 6. entry points exist in the tarball
  const packed = new Set(files);
  const entries = entryPoints(pkg);
  for (const [p, field] of entries) {
    const hit = candidates(p, field).some((c) => packed.has(c));
    if (!hit) add("FAIL", "entry", `${field} points at ${p}, which is not in the tarball`);
  }
  if (!pkg.main && !pkg.exports && !pkg.bin && !packed.has("index.js"))
    add("INFO", "entry", "no main, exports or bin: fine for a files-only package, nothing to import or run otherwise");

  // 7. repository field
  const repo = normalizeRepo(pkg.repository);
  if (!repo) add("WARN", "repository", "no repository field: npm will not link the source");
  else {
    const origin = normalizeRepo(gitOrigin(dir));
    if (origin && origin !== repo) add("WARN", "repository", `repository ${redact(repo)} differs from git origin ${redact(origin)}`);
  }

  // 8. versions in sibling manifests agree
  for (const m of [".claude-plugin/plugin.json", "gemini-extension.json", "jsr.json", "deno.json"]) {
    const mp = join(dir, m);
    if (!existsSync(mp)) continue;
    try {
      const v = JSON.parse(readFileSync(mp, "utf8")).version;
      if (v !== undefined && v !== pkg.version) add("FAIL", "version-match", `${m} says ${v}, package.json says ${pkg.version}`);
    } catch {
      add("FAIL", "version-match", `${m} is not JSON`);
    }
  }
  const cl = join(dir, "CHANGELOG.md");
  if (existsSync(cl) && pkg.version && !readFileSync(cl, "utf8").includes(pkg.version))
    add("WARN", "changelog", `CHANGELOG.md does not mention ${pkg.version}`);

  // 9. a committed .npmrc
  if (existsSync(join(dir, ".npmrc")) && gitTracked(dir, ".npmrc"))
    add("WARN", "npmrc", ".npmrc is committed to git; it often holds a registry token");

  // 10. types
  if (tsc && existsSync(join(dir, "tsconfig.json"))) {
    const bin = findTsc(dir);
    if (!bin) add("WARN", "tsc", "tsconfig.json found but no tsc to run (install typescript or pass --no-tsc)");
    else {
      try {
        execFileSync(bin, ["--noEmit", "--composite", "false", "--incremental", "false", "-p", dir], { cwd: dir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
        add("PASS", "tsc", "tsc --noEmit: no errors");
      } catch (e) {
        const first = (e.stdout || "").toString().split("\n").find((l) => l.includes("error")) || "errors";
        add("FAIL", "tsc", `tsc --noEmit: ${first.trim()}`);
      }
    }
  }

  if (!results.some((r) => r.status === "FAIL" || r.status === "WARN"))
    add("PASS", "all", "no problems found");
  return { dir, name: pkg.name, version: pkg.version, results };
}

/** @param {string[]} argv */
function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`npm-release-check: ${e instanceof Error ? e.message : e}\n${usage()}`);
    return 2;
  }
  if (opts.help) return console.log(usage()), 0;
  if (opts.version) return console.log(VERSION), 0;
  let report;
  try {
    report = check(opts.dir, { tsc: opts.tsc });
  } catch (e) {
    console.error(`npm-release-check: ${e instanceof Error ? e.message : e}`);
    return 2;
  }
  const fails = report.results.filter((r) => r.status === "FAIL").length;
  const warns = report.results.filter((r) => r.status === "WARN").length;
  if (opts.json) console.log(JSON.stringify({ ...report, fails, warns }, null, 2));
  else {
    console.log(`${report.name}@${report.version} (${basename(report.dir)})`);
    for (const r of report.results) console.log(`${r.status.padEnd(4)}  ${r.id}: ${r.message}`);
    console.log(`---- ${fails} FAIL, ${warns} WARN`);
  }
  return fails ? 1 : 0;
}

// Run only when executed (directly or through an npm bin link), not when imported by the tests.
function isMain() {
  try {
    return statSync(resolve(process.argv[1])).ino === statSync(fileURLToPath(import.meta.url)).ino;
  } catch {
    return false;
  }
}
if (isMain()) process.exitCode = main(process.argv.slice(2));
