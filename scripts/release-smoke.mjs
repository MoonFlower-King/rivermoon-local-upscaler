#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const asar = require("@electron/asar");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.resolve(root, process.argv[2] ?? path.join("release", "win-unpacked"));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const appAsar = path.join(releaseDir, "resources", "app.asar");

const failures = [];
const warnings = [];
const passes = [];

function pass(message) {
  passes.push(message);
}

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

function assert(condition, message) {
  if (condition) pass(message);
  else fail(message);
}

function exists(relativePath) {
  return fs.existsSync(path.join(releaseDir, relativePath));
}

function fileSize(relativePath) {
  try {
    return fs.statSync(path.join(releaseDir, relativePath)).size;
  } catch {
    return 0;
  }
}

function readText(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function normalizeAsarPath(value) {
  return value.replace(/^[/\\]+/, "");
}

function asarPath(...segments) {
  return path.join(...segments);
}

function extractAsarText(filePath) {
  return asar.extractFile(appAsar, filePath).toString("utf8");
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

function checkContains(label, text, snippets) {
  for (const snippet of snippets) {
    assert(text.includes(snippet), `${label} contains ${snippet}`);
  }
}

function checkNotContains(label, text, snippets) {
  for (const snippet of snippets) {
    assert(!text.includes(snippet), `${label} does not contain stale ${snippet}`);
  }
}

console.log(`RiverMoon release smoke: ${releaseDir}`);

assert(fs.existsSync(releaseDir), "release directory exists");
assert(exists("resources"), "resources directory exists");

const productName = packageJson.build?.productName;
const expectedExe = typeof productName === "string" ? path.join(releaseDir, `${productName}.exe`) : null;
const exeCandidates = fs.existsSync(releaseDir)
  ? fs.readdirSync(releaseDir).filter((name) => name.toLowerCase().endsWith(".exe"))
  : [];
const exePath =
  expectedExe && fs.existsSync(expectedExe)
    ? expectedExe
    : exeCandidates.length === 1
      ? path.join(releaseDir, exeCandidates[0])
      : null;
assert(Boolean(exePath), "packaged exe exists");
if (exePath) {
  const size = fs.statSync(exePath).size;
  assert(size > 50 * 1024 * 1024, `packaged exe has plausible size (${Math.round(size / 1024 / 1024)}MB)`);
}

for (const requiredFile of [
  "resources/app.asar",
  "resources/docs/PRODUCT_DOCUMENT.md",
  "resources/docs/PRODUCT_REPORT_BILINGUAL.md",
  "resources/docs/USER_GUIDE_BILINGUAL.md",
  "resources/docs/BUILD_AND_RELEASE.md",
  "resources/icon.ico",
  "ffmpeg.dll",
  "resources.pak"
]) {
  assert(exists(requiredFile), `${requiredFile} exists`);
}
assert(fileSize("resources/docs/PRODUCT_DOCUMENT.md") > 50_000, "product document is packaged");
assert(fileSize("resources/docs/PRODUCT_REPORT_BILINGUAL.md") > 20_000, "bilingual product report is packaged");
assert(fileSize("resources/docs/USER_GUIDE_BILINGUAL.md") > 20_000, "bilingual user guide is packaged");
assert(fileSize("resources/docs/BUILD_AND_RELEASE.md") > 1_000, "build and release notes are packaged");

let asarFiles = [];
if (fs.existsSync(appAsar)) {
  asarFiles = asar.listPackage(appAsar).map(normalizeAsarPath);
  assert(asarFiles.length > 100, `app.asar can be listed (${asarFiles.length} entries)`);
} else {
  fail("app.asar is missing");
}

const asarSet = new Set(asarFiles);
const requiredAsarFiles = [
  asarPath("dist", "main", "main.js"),
  asarPath("dist", "main", "cloud", "agent-gen.js"),
  asarPath("dist", "main", "cloud", "agent-protocol.js"),
  asarPath("dist", "main", "cloud", "image-gen.js"),
  asarPath("dist", "main", "cloud", "image-protocol.js"),
  asarPath("dist", "main", "cloud", "video-cleanup.js"),
  asarPath("dist", "main", "cloud", "video-gen.js"),
  asarPath("dist", "main", "cloud", "video-protocol.js"),
  asarPath("dist", "main", "cloud", "video-queue.js"),
  asarPath("dist", "main", "cloud", "video-url.js"),
  asarPath("dist", "main", "model-downloader.js"),
  asarPath("dist", "main", "model-registry.js"),
  asarPath("dist", "main", "update-checker.js"),
  asarPath("dist", "preload", "index.js"),
  asarPath("dist", "renderer", "index.html")
];
for (const filePath of requiredAsarFiles) {
  assert(asarSet.has(filePath), `app.asar includes ${filePath}`);
}

const rendererJs = asarFiles.find((filePath) => /^dist\\renderer\\assets\\index-.*\.js$/.test(filePath));
assert(Boolean(rendererJs), "app.asar includes renderer bundle");

if (failures.length === 0) {
  const mainJs = extractAsarText(asarPath("dist", "main", "main.js"));
  const preloadJs = extractAsarText(asarPath("dist", "preload", "index.js"));
  const agentGenJs = extractAsarText(asarPath("dist", "main", "cloud", "agent-gen.js"));
  const agentProtocolJs = extractAsarText(asarPath("dist", "main", "cloud", "agent-protocol.js"));
  const imageGenJs = extractAsarText(asarPath("dist", "main", "cloud", "image-gen.js"));
  const imageProtocolJs = extractAsarText(asarPath("dist", "main", "cloud", "image-protocol.js"));
  const videoCleanupJs = extractAsarText(asarPath("dist", "main", "cloud", "video-cleanup.js"));
  const videoGenJs = extractAsarText(asarPath("dist", "main", "cloud", "video-gen.js"));
  const videoProtocolJs = extractAsarText(asarPath("dist", "main", "cloud", "video-protocol.js"));
  const videoQueueJs = extractAsarText(asarPath("dist", "main", "cloud", "video-queue.js"));
  const videoUrlJs = extractAsarText(asarPath("dist", "main", "cloud", "video-url.js"));
  const modelDownloaderJs = extractAsarText(asarPath("dist", "main", "model-downloader.js"));
  const modelRegistryJs = extractAsarText(asarPath("dist", "main", "model-registry.js"));
  const updateCheckerJs = extractAsarText(asarPath("dist", "main", "update-checker.js"));
  const rendererBundle = rendererJs ? extractAsarText(rendererJs) : "";

  checkContains("main process", mainJs, [
    "app:renderer-ready",
    "渲染层就绪",
    "agent-chat:start",
    "agent-chat:event",
    "agent-chat:cancel",
    "image:contract",
    "image-gen:start",
    "dialog:select-image-references",
    "fetchFreshHttpsVideoContract",
    "video:contract",
    "video:diagnostics",
    "video-gen:start",
    "video-gen:sync-recent",
    "cleanupStaleVideoDownloads",
    "updates:check",
    "updates:open-release"
  ]);
  checkContains("preload bridge", preloadJs, [
    "reportRendererReady",
    "app:renderer-ready",
    "startVideoTask",
    "syncRecentVideoTasks",
    "getVideoGatewayDiagnostics",
    "getImageContract",
    "startAgentResponse",
    "onAgentResponseEvent",
    "selectImageReferences",
    "selectVideoSources",
    "checkForUpdates",
    "openUpdatePage"
  ]);
  checkContains("agent gateway", agentGenJs, ["/v1/responses", "text/event-stream", "GPT 网关没有返回流式响应"]);
  checkContains("agent protocol", agentProtocolJs, [
    "img.rivermoon7.com",
    "gpt-5.5",
    "reasoning_effort",
    "input_image",
    "response.output_text.delta"
  ]);
  checkContains("image gateway", imageGenJs, [
    "img.rivermoon7.com",
    "/v1/image/contract",
    "/v1/images/generations",
    "/v1/images/edits",
    "output_format",
    "fit_mode",
    "size_mode",
    "rivermoon_reference_binding"
  ]);
  checkContains("image protocol", imageProtocolJs, [
    "parseImageContract",
    "validateImageParamsAgainstContract",
    "max_reference_images",
    "output_formats",
    "custom_size",
    "参考图只支持"
  ]);
  checkContains("video gateway", videoGenJs, [
    "/v1/video/source-cache",
    "/v1/video/jobs",
    "video.rivermoon7.com",
    'redirect: "manual"',
    "allowExternalRedirect",
    "视频服务返回了不安全的重定向",
    "视频认证请求必须使用 HTTPS 视频网关",
    "视频参考图上传遇到瞬时错误"
  ]);
  checkContains("video cleanup", videoCleanupJs, ["cleanupStaleVideoDownloads", ".download", "assets", "videos"]);
  checkContains("video url policy", videoUrlJs, [
    "VIDEO_DOWNLOAD_MAX_BYTES",
    "validateVideoDownloadHeaders",
    "validateVideoFileHeader",
    "视频下载内容是错误响应",
    "视频下载内容不是可识别的视频文件",
    "视频下载地址必须使用 HTTPS",
    "视频下载地址不能包含内嵌凭据",
    "[invalid-video-url]"
  ]);
  checkContains("video protocol", videoProtocolJs, [
    "raw_response_json",
    "client_request_id",
    "reference_types",
    "提交视频任务必须使用 HTTPS 实时合同"
  ]);
  checkContains("video queue", videoQueueJs, ["video-tasks.json", "safePersistentVideoUrl"]);
  checkContains("model downloader", modelDownloaderJs, ["SHA256"]);
  checkContains("model registry", modelRegistryJs, ["4x-UltraSharp.pth", "RealESRGAN_x4plus.pth"]);
  checkContains("update checker", updateCheckerJs, [
    "api.github.com/repos",
    "releases/latest",
    "tags?per_page=1",
    "GitHub Release",
    "github-tag"
  ]);
  checkContains("renderer bundle", rendererBundle, [
    "imagegen",
    "GPT 对话",
    "图片分析",
    "超高",
    "图片合同",
    "原生直出",
    "分镜模板",
    "添加参考图",
    "videogen",
    "HTTPS 实时合同",
    "reference-type-select",
    "submit-block-reason",
    "reportRendererReady",
    "startVideoTask",
    "syncRecentVideoTasks",
    "检查更新",
    "打开下载页",
    "GitHub Releases"
  ]);
}

const runtimeRoot = path.join(releaseDir, "resources", "comfyui-runtime");
assert(fs.existsSync(path.join(runtimeRoot, "main.py")), "ComfyUI runtime main.py exists");
assert(fs.existsSync(path.join(runtimeRoot, "python_embeded", "python.exe")), "embedded Python exists");

for (const forbiddenPath of [
  path.join(runtimeRoot, "custom_nodes", "ComfyUI-DiffBIR"),
  path.join(runtimeRoot, "custom_nodes", "ComfyUI_DiffBIR"),
  path.join(runtimeRoot, "custom_nodes", "ComfyUI-SUPIR"),
  path.join(runtimeRoot, "models", "diffbir"),
  path.join(runtimeRoot, "models", "checkpoints")
]) {
  assert(
    !fs.existsSync(forbiddenPath),
    `forbidden legacy resource is absent: ${path.relative(releaseDir, forbiddenPath)}`
  );
}

const bundledPthFiles = walkFiles(path.join(runtimeRoot, "models")).filter((filePath) =>
  filePath.toLowerCase().endsWith(".pth")
);
const unexpectedPthFiles = bundledPthFiles.filter((filePath) => path.basename(filePath) !== "4x-UltraSharp.pth");
assert(unexpectedPthFiles.length === 0, "no unexpected .pth model is bundled");
if (bundledPthFiles.some((filePath) => path.basename(filePath) === "4x-UltraSharp.pth")) {
  warn("4x-UltraSharp.pth is bundled; commercial license review is still required.");
} else {
  warn("4x-UltraSharp.pth is not bundled; first-run model download must be manually verified.");
}

const productDocPath = path.join(releaseDir, "resources", "docs", "PRODUCT_DOCUMENT.md");
if (fs.existsSync(productDocPath)) {
  const productDoc = readText(productDocPath);
  checkContains("packaged product doc", productDoc, [
    "img.rivermoon7.com",
    "/v1/images/generations",
    "/v1/images/edits",
    "gpt-image-2",
    "video.rivermoon7.com",
    "source-cache",
    "raw_response_json.data.job",
    "raw_response_json.results"
  ]);
}

const buildDocPath = path.join(releaseDir, "resources", "docs", "BUILD_AND_RELEASE.md");
if (fs.existsSync(buildDocPath)) {
  const buildDoc = readText(buildDocPath);
  checkContains("packaged build doc", buildDoc, ["npm run release:smoke", "not bundled", "first-run download"]);
  checkNotContains("packaged build doc", buildDoc, [
    "resources/comfyui-runtime/models/upscale_models/4x-UltraSharp.pth"
  ]);
}

if (packageJson.build?.win?.signAndEditExecutable === false) {
  warn("Windows executable signing is disabled; commercial release will show unknown publisher until signed.");
}
warn("This smoke test does not submit paid video jobs; real Key HTTPS E2E remains a manual release gate.");

for (const message of passes) console.log(`[PASS] ${message}`);
for (const message of warnings) console.warn(`[WARN] ${message}`);
for (const message of failures) console.error(`[FAIL] ${message}`);

if (failures.length > 0) {
  console.error(`Release smoke failed: ${failures.length} failure(s), ${warnings.length} warning(s).`);
  process.exit(1);
}

console.log(`Release smoke passed: ${passes.length} pass(es), ${warnings.length} warning(s).`);
