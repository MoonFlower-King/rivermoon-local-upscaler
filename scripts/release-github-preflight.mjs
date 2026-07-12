#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const productName = packageJson.build?.productName ?? "RiverMoon AI 创作台";
const exeName = `${productName}.exe`;
const releaseDir = path.join(root, "release", "win-unpacked");
const githubAssetsDir = path.join(root, "release", "github");
const repoSlug = "MoonFlower-King/rivermoon-local-upscaler";
const githubAssetLimitBytes = 2 * 1024 * 1024 * 1024;
const recommendedAssetLimitBytes = 1900 * 1024 * 1024;

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
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim()
  };
}

function walkFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(fullPath));
    else result.push(fullPath);
  }
  return result;
}

function fileSize(filePath) {
  return fs.statSync(filePath).size;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  return `${bytes}B`;
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

console.log(`RiverMoon GitHub release preflight: ${repoSlug}`);

if (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(packageJson.version)) {
  pass(`package version is semver-like: ${packageJson.version}`);
} else {
  fail(`package version is not semver-like: ${packageJson.version}`);
}

const expectedTag = `v${packageJson.version}`;

const remote = run("git", ["remote", "get-url", "origin"]);
if (remote.ok && remote.stdout.includes("github.com") && remote.stdout.includes("rivermoon-local-upscaler")) {
  pass(`origin remote points to GitHub repo: ${remote.stdout}`);
} else {
  fail(`origin remote is not the expected GitHub repo: ${remote.stdout || remote.stderr || "unknown"}`);
}

const status = run("git", ["status", "--porcelain"]);
if (status.ok && status.stdout.length === 0) {
  pass("git working tree is clean");
} else {
  fail("git working tree is dirty; commit release changes before tagging");
}

const branch = run("git", ["branch", "--show-current"]);
if (branch.ok && branch.stdout) pass(`current branch: ${branch.stdout}`);
else warn("could not resolve current git branch");

const tagCheck = run("git", ["ls-remote", "--tags", "origin", expectedTag]);
if (tagCheck.ok && tagCheck.stdout.length === 0) {
  pass(`remote tag is available: ${expectedTag}`);
} else if (tagCheck.ok) {
  fail(`remote tag already exists: ${expectedTag}`);
} else {
  warn(`could not check remote tag ${expectedTag}: ${tagCheck.stderr || tagCheck.stdout}`);
}

const ghStatus = run("gh", ["auth", "status"]);
if (ghStatus.ok) {
  pass("GitHub CLI is logged in");
} else {
  fail("GitHub CLI is not logged in; run `gh auth login` before creating the release");
}

const repoView = run("gh", ["repo", "view", repoSlug, "--json", "nameWithOwner,visibility,url"]);
if (repoView.ok) {
  pass(`GitHub repo is reachable via gh: ${repoSlug}`);
} else {
  warn(`GitHub repo could not be checked via gh: ${repoView.stderr || repoView.stdout}`);
}

if (fs.existsSync(releaseDir)) {
  const files = walkFiles(releaseDir);
  const totalBytes = files.reduce((sum, filePath) => sum + fileSize(filePath), 0);
  pass(
    `portable release exists: ${path.relative(root, releaseDir)} (${files.length} files, ${formatBytes(totalBytes)})`
  );
  if (fs.existsSync(path.join(releaseDir, exeName))) pass(`portable exe exists: ${exeName}`);
  else fail("portable exe is missing");
  if (fs.existsSync(path.join(releaseDir, "resources", "app.asar"))) pass("app.asar exists");
  else fail("app.asar is missing");
  if (totalBytes > githubAssetLimitBytes) {
    warn(
      `portable directory is ${formatBytes(totalBytes)}; upload multipart assets, not one archive, because GitHub assets must stay under 2GiB each`
    );
  }
  const oversizedFile = files.find((filePath) => fileSize(filePath) >= githubAssetLimitBytes);
  if (oversizedFile) {
    fail(`single release file exceeds GitHub 2GiB asset limit: ${path.relative(releaseDir, oversizedFile)}`);
  } else {
    pass("no individual portable file exceeds GitHub 2GiB asset limit");
  }
} else {
  fail("release/win-unpacked is missing; run `npm run dist:dir` first");
}

if (fs.existsSync(githubAssetsDir)) {
  const assetFiles = walkFiles(githubAssetsDir);
  if (assetFiles.length === 0) warn("release/github exists but has no assets");
  else {
    pass(`GitHub asset directory exists with ${assetFiles.length} file(s)`);
    for (const filePath of assetFiles) {
      const size = fileSize(filePath);
      if (size >= githubAssetLimitBytes)
        fail(`GitHub asset exceeds 2GiB: ${path.basename(filePath)} (${formatBytes(size)})`);
      else if (size > recommendedAssetLimitBytes)
        warn(`GitHub asset is close to the limit: ${path.basename(filePath)} (${formatBytes(size)})`);
    }
    const checksumFile = assetFiles.find((filePath) => path.basename(filePath).startsWith("SHA256SUMS-"));
    if (checksumFile) {
      pass(`checksum file exists: ${path.basename(checksumFile)}`);
      const checksumDigest = sha256File(checksumFile).slice(0, 12);
      pass(`checksum file is readable (${checksumDigest}...)`);
    } else {
      warn("checksum file is missing; run `npm run release:github:assets`");
    }
  }
} else {
  warn("release/github is missing; run `npm run release:github:assets` after installing 7-Zip");
}

for (const message of passes) console.log(`[PASS] ${message}`);
for (const message of warnings) console.warn(`[WARN] ${message}`);
for (const message of failures) console.error(`[FAIL] ${message}`);

if (failures.length > 0) {
  console.error(`GitHub release preflight failed: ${failures.length} blocker(s), ${warnings.length} warning(s).`);
  process.exit(1);
}

console.log(`GitHub release preflight passed: ${passes.length} pass(es), ${warnings.length} warning(s).`);
