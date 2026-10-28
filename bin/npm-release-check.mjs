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
  [/(^|\/)\.env(?!(\.[^/]*)?\.(example|sample|template|dist|defaults)$)(\.[^/]*)?$/i, ".env file"],
  [/(^|\/)\.envrc$/i, ".envrc (direnv, often exports secrets)"],
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
  // Not touching a base64 character on either side (an escape such as \n before it does not count), and not a
  // key ending in EXAMPLE, as AWS's documented example key does.
  [/(?<!(?<!\\)[A-Za-z0-9+/])AKIA(?![0-9A-Z]{9}EXAMPLE)[0-9A-Z]{16}(?![A-Za-z0-9+/])/, "AWS access key id"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/sk-(proj-)?[A-Za-z0-9]{32,}/, "OpenAI-style API key"],
  [/xox[abprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/(?<!(?<!\\)[A-Za-z0-9+/])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/, "Google API key"],
];

const INSTALL_SCRIPTS = ["preinstall", "install", "postinstall"];

// Every message passes through here: token shapes and a URL password are hidden (a plain user like git@ stays).
function redact(text) {
  let out = String(text).replace(/\/\/[^/@\s:]+:[^/@\s]+@/g, "//[hidden]@");
  for (const [rx] of SECRET_PATTERNS) out = out.replace(new RegExp(rx.source, "g"), "[hidden]");
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/g, "[hidden]");
  return out;
}
const BIG_FILE = 50 * 1024 * 1024;

// exports conditions Node, bundlers and runtimes read without being asked. Any other key (source, code,
// dev-source) is a custom condition only a tool that sets it reads, so a missing file there is INFO.
const KNOWN_CONDITIONS = new Set(["node", "import", "require", "default", "types", "module-sync", "browser", "module",
  "deno", "bun", "worker", "workerd", "edge-light", "react-native", "react-server", "development", "production", "electron",
  "node-addons", "style", "sass", "svelte"]);

// npm 10 runs a package's prepare script during `npm pack --dry-run` even with --ignore-scripts.
// Handing npm a shell that does nothing stops it. Windows has no such shell; there the check refuses to pack.
function noopShell() {
  if (process.platform === "win32") return "";
  const dirs = ["/usr/bin", "/bin", ...(process.env.PATH || "").split(":").filter(Boolean)];
  return dirs.map((d) => join(d, "true")).find((p) => existsSync(p)) || "";
}
const BIG_PACKAGE = 10 * 1024 * 1024;

// A .pem that holds only a public key or a certificate is meant to ship. One that is not PEM text (DER, UTF-16) is not exempt.
function publicPem(path) {
  if (!/\.pem$/i.test(path)) return false;
  try {
    const text = readFileSync(path, "utf8");
    return text.trimStart().startsWith("-----BEGIN") && !text.includes("PRIVATE KEY");
  } catch {
    return false;
  }
}

// ghp_xxxx... in a README is a placeholder: every match on the line ends in 16 characters of at most 3 kinds.
function placeholder(line, rx) {
  const all = line.match(new RegExp(rx.source, "g")) || [];
  return all.length > 0 && all.every((m) => new Set(m.slice(-16)).size <= 3);
}

// A PEM private key header with key data after it: on the same line after an escaped newline, or on the next
// lines past indentation, quotes, commas, string joins and an encrypted PEM's Proc-Type/DEK-Info lines.
// The header alone is code that writes a PEM.
function pemKeyAt(lines, i) {
  const m = /-----BEGIN [A-Z ]*PRIVATE KEY-----/.exec(lines[i]);
  if (!m) return false;
  const after = [lines[i].slice(m.index + m[0].length), ...lines.slice(i + 1, i + 6)]
    .filter((l) => !/^\s*["'`]?(Proc-Type|DEK-Info):/.test(l))
    .join("\n")
    .replace(/\\r|\\n/g, "")
    .replace(/[\s"'`,]/g, "");
  return /^[A-Za-z0-9+/]{40}/.test(after);
}

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

function packList(dir, shell) {
  const args = ["pack", "--dry-run", "--json", "--ignore-scripts", "--logs-max=0", "--no-update-notifier"];
  if (shell) args.push(`--script-shell=${shell}`);
  const out = execFileSync("npm", args, {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024, // a package of a few thousand files prints more than the 1 MB default
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
    const exts = [".js", ".json", ".node"];
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
  const add = (status, id, message) => results.push({ status, id, message: redact(message) });

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
  const shell = noopShell();
  if (pkg.scripts && pkg.scripts.prepare && !shell)
    throw new Error("scripts.prepare is set and npm pack would run it (npm 10 ignores --ignore-scripts for prepare); nothing was run");
  let info;
  try {
    info = packList(dir, shell);
  } catch (e) {
    const lines = (e.stderr || "").toString().split("\n").filter((l) => l.trim());
    const msg = lines.find((l) => /^npm (error|ERR!)/.test(l)) || (e.code ? `${e.code}: ${e.message}` : lines[0] || e.message || "failed");
    add("FAIL", "pack", `npm pack --dry-run failed: ${msg.trim()}`);
    return { dir, name: pkg.name, version: pkg.version, results };
  }
  const files = info.files.map((f) => f.path);
  add("INFO", "pack", `${files.length} files, ${info.unpackedSize ?? "?"} bytes unpacked`);

  // 3. private files
  for (const f of files)
    for (const [rx, what] of PRIVATE_FILES)
      if (rx.test(f) && !(what === "key or certificate file" && publicPem(join(dir, f)))) add("FAIL", "private-file", `${f}: ${what} in the tarball`);

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
      if (pemKeyAt(lines, i)) add("FAIL", "secret", `${f.path}:${i + 1}: has the shape of: private key block`);
      for (const [rx, what] of SECRET_PATTERNS)
        if (rx.test(line) && !placeholder(line, rx)) add("FAIL", "secret", `${f.path}:${i + 1}: has the shape of: ${what}`);
    });
  }
  if ((info.unpackedSize || 0) > BIG_PACKAGE) add("WARN", "size", `unpacked size ${info.unpackedSize} bytes is over 10 MB`);

  // 5. install scripts run on every user's machine
  for (const s of INSTALL_SCRIPTS)
    if (pkg.scripts && pkg.scripts[s]) add("WARN", "install-script", `scripts.${s} runs on every install: "${pkg.scripts[s]}"`);

  // 6. entry points exist in the tarball
  const packed = new Set(files);
  const entries = entryPoints(pkg);
  for (const [p, field] of entries) {
    const hit = candidates(p, field).some((c) => packed.has(c));
    const custom = [...field.matchAll(/\[([^\]]*)\]/g)].map((m) => m[1]).find((k) => !k.startsWith(".") && !/^\d+$/.test(k) && !KNOWN_CONDITIONS.has(k) && !k.startsWith("types@"));
    if (hit) continue;
    if (custom) add("INFO", "entry", `${field} points at ${p}, which is not in the tarball; "${custom}" is a custom condition, read only by tools that set it`);
    else add("FAIL", "entry", `${field} points at ${p}, which is not in the tarball`);
  }
  if (!pkg.main && !pkg.exports && !pkg.bin && !packed.has("index.js"))
    add("INFO", "entry", "no main, exports or bin: fine for a files-only package, nothing to import or run otherwise");

  // 7. repository field
  const repo = normalizeRepo(pkg.repository);
  if (!repo) add("WARN", "repository", "no repository field: npm will not link the source");
  else {
    const origin = normalizeRepo(gitOrigin(dir));
    if (origin && origin !== repo) add("WARN", "repository", `repository ${repo} differs from git origin ${origin}`);
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
