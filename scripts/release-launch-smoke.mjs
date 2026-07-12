#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = path.resolve(root, process.argv[2] ?? path.join("release", "win-unpacked"));
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const productName = packageJson.build?.productName ?? "RiverMoon AI 创作台";
const exePath = path.join(releaseDir, `${productName}.exe`);
const timeoutMs = Number(process.env.RIVERMOON_LAUNCH_SMOKE_TIMEOUT_MS ?? 30_000);
const stableMs = Number(process.env.RIVERMOON_LAUNCH_SMOKE_STABLE_MS ?? 3_000);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rivermoon-launch-smoke-"));
const logPath = path.join(userDataDir, "logs", "app.log");
const fatalLogMarkers = [
  "主窗口加载失败",
  "窗口加载失败",
  "渲染进程异常退出",
  "主窗口无响应",
  "未捕获异常",
  "未处理的 Promise 拒绝"
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLog() {
  try {
    return fs.readFileSync(logPath, "utf8");
  } catch {
    return "";
  }
}

function cleanupTempDir() {
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    // A running Electron child may still hold a file briefly; ignore cleanup failure.
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await sleep(250);
  }
  child.kill("SIGKILL");
}

if (!fs.existsSync(exePath)) {
  console.error(`[FAIL] Packaged exe not found: ${exePath}`);
  process.exit(1);
}

console.log(`RiverMoon launch smoke: ${exePath}`);
console.log(`Temporary userData: ${userDataDir}`);

const child = spawn(exePath, [], {
  cwd: releaseDir,
  env: {
    ...process.env,
    RIVERMOON_USER_DATA_DIR: userDataDir
  },
  stdio: "ignore",
  windowsHide: false
});

let earlyExit = null;
child.once("exit", (code, signal) => {
  earlyExit = { code, signal };
});

let ok = false;
let sawStartup = false;
let sawWindowLoad = false;
let sawRendererReady = false;
let loadedAt = null;
let fatalLogMarker = null;
const startedAt = Date.now();
try {
  while (Date.now() - startedAt < timeoutMs) {
    const log = readLog();
    sawStartup = sawStartup || log.includes("应用启动");
    sawWindowLoad = sawWindowLoad || log.includes("主窗口加载完成");
    sawRendererReady = sawRendererReady || /渲染层就绪.*videoNav=true/.test(log);
    fatalLogMarker = fatalLogMarkers.find((marker) => log.includes(marker)) ?? null;
    if (fatalLogMarker) break;
    if (sawStartup && sawWindowLoad && sawRendererReady && loadedAt === null) {
      loadedAt = Date.now();
    }
    if (loadedAt !== null && Date.now() - loadedAt >= stableMs) {
      ok = true;
      break;
    }
    if (earlyExit) break;
    await sleep(500);
  }

  if (!ok) {
    const reason = fatalLogMarker
      ? `fatal log observed: ${fatalLogMarker}`
      : earlyExit
        ? `process exited early code=${earlyExit.code} signal=${earlyExit.signal}`
        : !sawStartup
          ? "startup log not observed"
          : !sawWindowLoad
            ? "window load log not observed"
            : !sawRendererReady
              ? "renderer ready log with video navigation not observed"
              : `renderer did not stay stable for ${stableMs}ms`;
    console.error(`[FAIL] Packaged app launch smoke failed: ${reason}`);
    const recentLog = readLog().trim();
    if (recentLog) console.error(recentLog.split("\n").slice(-20).join("\n"));
    process.exitCode = 1;
  } else {
    console.log("[PASS] Packaged app wrote startup log");
    console.log("[PASS] Packaged app loaded renderer window");
    console.log("[PASS] Packaged app reported renderer ready with video navigation");
    console.log(`[PASS] Packaged app stayed stable for ${stableMs}ms after renderer load`);
  }
} finally {
  await stopProcess(child);
  cleanupTempDir();
}
