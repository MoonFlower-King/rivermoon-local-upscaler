#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(root, "release");
const portableDir = path.join(releaseRoot, "win-unpacked");
const outputDir = path.join(releaseRoot, "github");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = packageJson.version;
const tag = `v${version}`;
const productName = packageJson.build?.productName ?? "RiverMoon AI 创作台";
const exeName = `${productName}.exe`;
const assetPrefix = `RiverMoon-AI-Studio-${tag}-portable`;
const archiveBase = path.join(outputDir, `${assetPrefix}.7z`);
const volumeSizeMb = Number(process.env.RIVERMOON_GITHUB_RELEASE_VOLUME_MB ?? 1900);
const metadataOnly = process.argv.includes("--metadata-only");
const clean = process.argv.includes("--clean") || !metadataOnly;
const repoUrl = "https://github.com/MoonFlower-King/rivermoon-local-upscaler";
const githubAssetLimitBytes = 2 * 1024 * 1024 * 1024;

function usage() {
  console.log(`RiverMoon GitHub release asset builder

Usage:
  node scripts/create-github-release-assets.mjs [--clean]
  node scripts/create-github-release-assets.mjs --metadata-only

Output:
  release/github/${assetPrefix}.7z.001
  release/github/SHA256SUMS-${tag}.txt
  release/github/RELEASE_NOTES-${tag}.md
  release/github/README-DOWNLOAD-${tag}.txt
  release/github/manifest-${tag}.json

Requirements:
  - release/win-unpacked must already exist.
  - 7-Zip must be installed for archive generation.
  - Set RIVERMOON_GITHUB_RELEASE_VOLUME_MB to override the default 1900MB volume size.
`);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  usage();
  process.exit(0);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    ...options
  });
}

function commandOutput(command, args) {
  const result = run(command, args);
  return result.status === 0 ? (result.stdout ?? "").trim() : "";
}

function find7Zip() {
  const candidates = [
    process.env.RIVERMOON_7Z_PATH,
    commandOutput("where.exe", ["7z"]).split(/\r?\n/)[0],
    commandOutput("where.exe", ["7za"]).split(/\r?\n/)[0],
    "C:\\Program Files\\7-Zip\\7z.exe",
    "C:\\Program Files (x86)\\7-Zip\\7z.exe"
  ].filter(Boolean);
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) ?? null;
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

function sha256File(filePath) {
  const hash = createHash("sha256");
  const stream = fs.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)}GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)}MB`;
  return `${bytes}B`;
}

function ensurePortableRelease() {
  const exePath = path.join(portableDir, exeName);
  const asarPath = path.join(portableDir, "resources", "app.asar");
  if (!fs.existsSync(portableDir)) throw new Error("release/win-unpacked is missing. Run `npm run dist:dir` first.");
  if (!fs.existsSync(exePath)) throw new Error("Portable exe is missing from release/win-unpacked.");
  if (!fs.existsSync(asarPath)) throw new Error("resources/app.asar is missing from release/win-unpacked.");
}

function resetOutputDir() {
  fs.mkdirSync(outputDir, { recursive: true });
  if (!clean) return;
  for (const entry of fs.readdirSync(outputDir)) {
    const fullPath = path.join(outputDir, entry);
    if (
      entry.startsWith(assetPrefix) ||
      entry === `SHA256SUMS-${tag}.txt` ||
      entry === `RELEASE_NOTES-${tag}.md` ||
      entry === `README-DOWNLOAD-${tag}.txt` ||
      entry === `manifest-${tag}.json`
    ) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
  }
}

function writeReadme(portableStats) {
  const text = [
    `RiverMoon AI Studio ${tag}`,
    "",
    "Download instructions:",
    "1. Download every file named RiverMoon-AI-Studio-*-portable.7z.001, .002, .003, etc.",
    "2. Keep all parts in the same folder.",
    "3. Open/extract the .7z.001 file with 7-Zip. The remaining parts are read automatically.",
    `4. Run ${exeName} from the extracted win-unpacked folder.`,
    "",
    "Do not download only the exe. The app requires the whole extracted folder.",
    "",
    `Portable folder before compression: ${portableStats.files} files, ${formatBytes(portableStats.bytes)}.`,
    "Requires NVIDIA/CUDA. The executable is currently unsigned, so Windows may show an unknown publisher warning.",
    ""
  ].join("\n");
  fs.writeFileSync(path.join(outputDir, `README-DOWNLOAD-${tag}.txt`), text, "utf8");
}

function writeReleaseNotes(assetNames) {
  const notes = [
    `# RiverMoon AI Studio ${tag}`,
    "",
    "## Download",
    "",
    "This release is uploaded as multipart 7-Zip assets because the portable runtime is larger than GitHub's single-asset limit.",
    "",
    "Download all portable archive parts, keep them in the same folder, then extract the `.7z.001` file with 7-Zip.",
    "",
    "Upload assets:",
    ...assetNames.map((name) => `- \`${name}\``),
    "",
    "## Important",
    "",
    "- Copy/extract the full `win-unpacked` folder. Do not copy only the exe.",
    "- Requires NVIDIA/CUDA.",
    "- The executable is unsigned.",
    "- `4x-UltraSharp.pth` is not bundled; first-run model download must be verified.",
    "- AI image, AI video, and GPT modules require a RiverMoon API Key.",
    "",
    "## Verification",
    "",
    "- `npm run lint`",
    "- `npm test`",
    "- `npm run build`",
    "- `npm run dist:dir`",
    "- `npm run release:smoke`",
    "- `npm run release:launch-smoke`",
    "",
    `Repository: ${repoUrl}`,
    ""
  ].join("\n");
  fs.writeFileSync(path.join(outputDir, `RELEASE_NOTES-${tag}.md`), notes, "utf8");
}

async function writeChecksums(files) {
  const lines = [];
  for (const filePath of files) {
    const digest = await sha256File(filePath);
    lines.push(`${digest}  ${path.basename(filePath)}`);
  }
  fs.writeFileSync(path.join(outputDir, `SHA256SUMS-${tag}.txt`), `${lines.join("\n")}\n`, "utf8");
}

async function writeManifest(files, portableStats) {
  const assets = [];
  for (const filePath of files) {
    assets.push({
      name: path.basename(filePath),
      bytes: fs.statSync(filePath).size,
      sha256: await sha256File(filePath)
    });
  }
  const manifest = {
    name: packageJson.name,
    productName,
    version,
    tag,
    createdAt: new Date().toISOString(),
    repository: repoUrl,
    portableDirectory: "release/win-unpacked",
    portableFiles: portableStats.files,
    portableBytes: portableStats.bytes,
    githubAssetLimitBytes,
    volumeSizeMb,
    assets
  };
  fs.writeFileSync(path.join(outputDir, `manifest-${tag}.json`), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function portableStats() {
  const files = walkFiles(portableDir);
  return {
    files: files.length,
    bytes: files.reduce((sum, filePath) => sum + fs.statSync(filePath).size, 0)
  };
}

function archiveParts() {
  return walkFiles(outputDir)
    .filter((filePath) => path.basename(filePath).startsWith(`${assetPrefix}.7z.`))
    .sort((left, right) => left.localeCompare(right));
}

function ensureAssetsAreUploadable(files) {
  for (const filePath of files) {
    const size = fs.statSync(filePath).size;
    if (size >= githubAssetLimitBytes) {
      throw new Error(`GitHub asset exceeds 2GiB: ${path.basename(filePath)} (${formatBytes(size)})`);
    }
  }
}

async function main() {
  ensurePortableRelease();
  resetOutputDir();

  const stats = portableStats();
  writeReadme(stats);

  if (!metadataOnly) {
    const sevenZip = find7Zip();
    if (!sevenZip) {
      throw new Error(
        "7-Zip was not found. Install 7-Zip, add 7z.exe to PATH, or set RIVERMOON_7Z_PATH before running this script."
      );
    }
    console.log(`Using 7-Zip: ${sevenZip}`);
    console.log(`Creating multipart archive: ${archiveBase}.001 (${volumeSizeMb}MB volumes)`);
    const result = spawnSync(
      sevenZip,
      ["a", "-t7z", "-mx=7", "-mmt=on", `-v${volumeSizeMb}m`, archiveBase, "win-unpacked\\*"],
      {
        cwd: releaseRoot,
        stdio: "inherit",
        windowsHide: true
      }
    );
    if (result.status !== 0) throw new Error(`7-Zip failed with exit code ${result.status ?? 1}`);
  }

  const parts = archiveParts();
  if (!metadataOnly && parts.length === 0) throw new Error("No multipart archive parts were created.");
  ensureAssetsAreUploadable(parts);

  const readmePath = path.join(outputDir, `README-DOWNLOAD-${tag}.txt`);
  const releaseNotesPath = path.join(outputDir, `RELEASE_NOTES-${tag}.md`);
  const uploadFiles = [...parts, readmePath, releaseNotesPath];
  writeReleaseNotes(uploadFiles.map((filePath) => path.basename(filePath)));
  await writeChecksums(uploadFiles);
  await writeManifest([...uploadFiles, path.join(outputDir, `SHA256SUMS-${tag}.txt`)], stats);

  console.log(`GitHub release assets prepared in ${outputDir}`);
  console.log(`Release notes: ${path.join(outputDir, `RELEASE_NOTES-${tag}.md`)}`);
  if (parts.length > 0) {
    console.log("Upload command:");
    console.log(
      `gh release create ${tag} ${parts.map((filePath) => `"${filePath}"`).join(" ")} "${path.join(
        outputDir,
        `SHA256SUMS-${tag}.txt`
      )}" "${path.join(outputDir, `manifest-${tag}.json`)}" "${path.join(
        outputDir,
        `README-DOWNLOAD-${tag}.txt`
      )}" --repo MoonFlower-King/rivermoon-local-upscaler --title "RiverMoon AI Studio ${tag}" --notes-file "${path.join(
        outputDir,
        `RELEASE_NOTES-${tag}.md`
      )}"`
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
