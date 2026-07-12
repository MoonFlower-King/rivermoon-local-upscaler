#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const strict = process.argv.includes("--strict");
const githubHardLimit = 100 * 1024 * 1024;
const failureLimit = 95 * 1024 * 1024;
const warningLimit = 50 * 1024 * 1024;

const failures = [];
const warnings = [];
const passes = [];

function pass(message) {
  passes.push(message);
}

function warn(message) {
  warnings.push(message);
}

function fail(message) {
  failures.push(message);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    ...options
  });
  if (result.status !== 0 && !options.allowFailure) {
    fail(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "unknown error").trim()}`);
  }
  return result;
}

function git(args, options = {}) {
  return run("git", args, options);
}

function splitNull(text) {
  return text.split("\0").filter(Boolean);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GiB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  return `${bytes} B`;
}

const requiredFiles = [
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  "README.md",
  "README.en.md",
  "LICENSE",
  "NOTICE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "SUPPORT.md",
  ".github/workflows/ci.yml",
  ".github/ISSUE_TEMPLATE/config.yml"
];

for (const file of requiredFiles) {
  if (fs.existsSync(path.join(root, file))) pass(`required file exists: ${file}`);
  else fail(`required file is missing: ${file}`);
}

const packagePath = path.join(root, "package.json");
if (fs.existsSync(packagePath)) {
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (packageJson.license === "MIT") pass("package license is MIT");
  else fail("package.json must declare license=MIT");
  if (packageJson.private === true) pass("npm publishing is disabled with private=true");
  else warn("package.json should keep private=true unless npm publishing is intentional");
  const repositoryUrl = packageJson.repository?.url || "";
  if (repositoryUrl.includes("MoonFlower-King/rivermoon-local-upscaler"))
    pass("package repository metadata is configured");
  else fail("package repository metadata is missing or incorrect");
}

const trackedResult = git(["ls-files", "-z"]);
const trackedFiles = trackedResult.status === 0 ? splitNull(trackedResult.stdout) : [];
const candidateResult = git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
const candidateFiles = candidateResult.status === 0 ? splitNull(candidateResult.stdout) : [];
const ignoredTrackedResult = git(["ls-files", "-ci", "--exclude-standard", "-z"]);
const ignoredTracked = ignoredTrackedResult.status === 0 ? splitNull(ignoredTrackedResult.stdout) : [];

if (ignoredTracked.length === 0) pass("no ignored generated or private file is tracked");
else ignoredTracked.forEach((file) => fail(`ignored file is already tracked: ${file}`));

const forbiddenPrefixes = [
  "node_modules/",
  "dist/",
  "release/",
  "release-check/",
  "resources/comfyui-runtime/",
  "resources/models/",
  ".local-user-data/",
  "user-data/",
  "logs/",
  ".playwright-mcp/"
];

for (const file of trackedFiles) {
  const normalized = file.replaceAll("\\", "/");
  if (forbiddenPrefixes.some((prefix) => normalized.startsWith(prefix))) {
    fail(`generated/runtime path is tracked: ${file}`);
  }
  if (/^\.env(?:\.|$)/i.test(normalized) && normalized !== ".env.example") {
    fail(`environment file is tracked: ${file}`);
  }
}

for (const file of candidateFiles) {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) continue;
  const size = fs.statSync(fullPath).size;
  if (size >= failureLimit) fail(`candidate file is too large for GitHub: ${file} (${formatBytes(size)})`);
  else if (size >= warningLimit) warn(`candidate file is unusually large: ${file} (${formatBytes(size)})`);
}

const objectList = git(["rev-list", "--objects", "--all"]);
if (objectList.status === 0 && objectList.stdout.trim()) {
  const objectCheck = git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize) %(rest)"], {
    input: objectList.stdout
  });
  if (objectCheck.status === 0) {
    for (const line of objectCheck.stdout.split(/\r?\n/)) {
      const match = line.match(/^([0-9a-f]+) (\w+) (\d+)(?: (.*))?$/);
      if (!match || match[2] !== "blob") continue;
      const size = Number(match[3]);
      const file = match[4] || match[1];
      if (size >= failureLimit) fail(`Git history contains a GitHub-blocking blob: ${file} (${formatBytes(size)})`);
      else if (size >= warningLimit) warn(`Git history contains a large blob: ${file} (${formatBytes(size)})`);
    }
  }
}

const binaryExtensions = new Set([
  ".7z",
  ".asar",
  ".bin",
  ".dll",
  ".exe",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".onnx",
  ".pdf",
  ".png",
  ".pth",
  ".safetensors",
  ".webp",
  ".zip"
]);

const highConfidenceSecrets = [
  { label: "private key", pattern: /-----BEGIN (?:RSA|OPENSSH|EC|DSA) PRIVATE KEY-----/ },
  { label: "GitHub token", pattern: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { label: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "Stripe live key", pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/ }
];
const riverMoonKey = /\bsk-[A-Za-z0-9_-]{16,}\b/;
const safeFixtureMarkers = ["test", "example", "fake", "fixture", "redact", "maskkey", "masked"];
// 占位符拆开拼接：否则本脚本自扫描时会命中自己源码里的检测字符串。
const ownerPlaceholder = "<your-" + "name>";

for (const file of candidateFiles) {
  const fullPath = path.join(root, file);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) continue;
  const stat = fs.statSync(fullPath);
  if (stat.size > 2 * 1024 * 1024 || binaryExtensions.has(path.extname(file).toLowerCase())) continue;
  const text = fs.readFileSync(fullPath, "utf8");
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const secret of highConfidenceSecrets) {
      if (secret.pattern.test(line)) fail(`possible ${secret.label}: ${file}:${index + 1}`);
    }
    const lower = line.toLowerCase();
    if (
      riverMoonKey.test(line) &&
      !file.replaceAll("\\", "/").startsWith("tests/") &&
      !safeFixtureMarkers.some((marker) => lower.includes(marker))
    ) {
      fail(`possible RiverMoon API key: ${file}:${index + 1}`);
    }
  });
  if (text.includes(ownerPlaceholder)) fail(`placeholder GitHub owner remains: ${file}`);
}

const stalePublicClaims = [
  { file: "README.md", text: "完全本地运行" },
  { file: "SECURITY.md", text: "不使用任何云端 API Key" }
];
for (const claim of stalePublicClaims) {
  const fullPath = path.join(root, claim.file);
  if (fs.existsSync(fullPath) && fs.readFileSync(fullPath, "utf8").includes(claim.text)) {
    fail(`stale public product claim remains in ${claim.file}: ${claim.text}`);
  }
}

for (const file of candidateFiles.filter((item) => /^scripts\/.*\.(?:mjs|cjs)$/.test(item.replaceAll("\\", "/")))) {
  const result = run(process.execPath, ["--check", path.join(root, file)], { allowFailure: true });
  if (result.status === 0) pass(`script syntax is valid: ${file}`);
  else fail(`script syntax error: ${file}`);
}

const statusResult = git(["status", "--porcelain"]);
if (statusResult.status === 0 && statusResult.stdout.trim()) {
  if (strict) fail("working tree is dirty; commit intended source changes before public release");
  else warn("working tree is dirty; use npm run repo:preflight:strict before tagging a release");
} else {
  pass("working tree is clean");
}

if (githubHardLimit <= failureLimit) fail("internal preflight size thresholds are invalid");

for (const message of passes) console.log(`[PASS] ${message}`);
for (const message of warnings) console.warn(`[WARN] ${message}`);
for (const message of failures) console.error(`[FAIL] ${message}`);

if (failures.length > 0) {
  console.error(`Open-source preflight failed: ${failures.length} blocker(s), ${warnings.length} warning(s).`);
  process.exit(1);
}

console.log(`Open-source preflight passed: ${passes.length} pass(es), ${warnings.length} warning(s).`);
