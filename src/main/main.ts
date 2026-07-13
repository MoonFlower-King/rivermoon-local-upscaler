import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, session, shell } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { discoverImageFiles } from "./file-discovery.js";
import { previewDataUrl } from "./image.js";
import { appRoot, comfyRuntimeRoot, findComfyModel, listComfyModels, modelsRoot } from "./paths.js";
import { comfyRuntimeStatus, shutdownComfy } from "./comfy-engine.js";
import { buildStandardPromptTemplate, describeStandardWorkflow } from "./comfy-protocol.js";
import { JobQueue } from "./job-queue.js";
import { getHardwareReport } from "./hardware-probe.js";
import { loadSettings, saveSettings } from "./settings-store.js";
import { DEFAULT_MODEL } from "./settings.js";
import { loadSavedJobs } from "./jobs-store.js";
import { log, readRecentLog, logsRoot } from "./logger.js";
import { redactDiagnosticsText } from "./diagnostics-redaction.js";
import {
  TOPUP_URL,
  clearAccountKey,
  getAccountStatus,
  invalidateAccountCache,
  setAccountKey
} from "./cloud/account.js";
import { loadKey, saveKey } from "./cloud/key-store.js";
import { RelayError } from "./cloud/relay-protocol.js";
import { runAgentResponse } from "./cloud/agent-gen.js";
import { sanitizeAgentChatRequest } from "./cloud/agent-protocol.js";
import { ImageTaskQueue, loadSavedImageTasks } from "./cloud/image-queue.js";
import { fetchImageContract } from "./cloud/image-gen.js";
import {
  sanitizeImageParams,
  validateImageParamsAgainstContract,
  validateImageSourceFileContent,
  validateImageSourceFileMeta
} from "./cloud/image-protocol.js";
import { fetchFreshHttpsVideoContract, fetchVideoContract, runVideoGatewayDiagnostics } from "./cloud/video-gen.js";
import { cleanupStaleVideoDownloads, videoAssetsRootForUserData } from "./cloud/video-cleanup.js";
import { VideoTaskQueue, loadSavedVideoTasks } from "./cloud/video-queue.js";
import {
  sanitizeVideoParams,
  validateVideoParamsAgainstContract,
  validateVideoSourceFileContent,
  validateVideoSourceFileMeta
} from "./cloud/video-protocol.js";
import {
  cancelModelDownload,
  cleanupStaleDownloads,
  getModelStatus,
  onModelDownloadUpdate,
  startModelDownload
} from "./model-downloader.js";
import { findModelSpec } from "./model-registry.js";
import { checkForUpdates, isAllowedUpdatePageUrl } from "./update-checker.js";
import type { AccountStatus, AppInfo, AssetStatus, HardwareReport, StartJobsPayload } from "./types.js";

let mainWindow: BrowserWindow | null = null;
let jobQueue: JobQueue;
let imageQueue: ImageTaskQueue;
let videoQueue: VideoTaskQueue;
let lastHardwareReport: HardwareReport | null = null;
const agentResponses = new Map<string, AbortController>();

/**
 * 渲染层可引用的磁盘路径白名单（纵深防御）：
 * 只有经文件对话框、拖拽发现、任务记录产生的路径才允许预览 / 定位 / 发起任务，
 * 即使渲染层被攻破也无法借 IPC 读取任意文件。
 */
const allowedPaths = new Set<string>();
const IMAGE_REFERENCE_DIALOG_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];
const VIDEO_SOURCE_DIALOG_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];

function allowPaths(paths: Iterable<string>): void {
  for (const item of paths) allowedPaths.add(path.normalize(item));
}

function isAllowedPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  const normalized = path.normalize(value);
  if (allowedPaths.has(normalized)) return true;
  // 任务记录里的输入/输出路径天然可信（主进程自己生成过），覆盖重启后恢复的历史任务。
  const fromUpscale =
    jobQueue
      ?.getJobs()
      .some(
        (job) =>
          path.normalize(job.inputPath) === normalized ||
          (job.outputPath !== null && path.normalize(job.outputPath) === normalized)
      ) ?? false;
  const fromImages =
    imageQueue
      ?.getTasks()
      .some(
        (task) =>
          task.outputPaths.some((outputPath) => path.normalize(outputPath) === normalized) ||
          task.params.referencePaths.some((referencePath) => path.normalize(referencePath) === normalized)
      ) ?? false;
  const fromVideos =
    videoQueue
      ?.getTasks()
      .some(
        (task) =>
          (task.outputPath !== null && path.normalize(task.outputPath) === normalized) ||
          task.params.referencePaths.some((referencePath) => path.normalize(referencePath) === normalized)
      ) ?? false;
  return fromUpscale || fromImages || fromVideos;
}

configureLocalUserData();

const preloadPath = path.join(app.getAppPath(), "dist", "preload", "index.js");

function configureLocalUserData(): void {
  const userDataRoot =
    configuredUserDataRoot() ??
    (app.isPackaged ? packagedUserDataRoot() : path.join(process.cwd(), ".local-user-data"));
  try {
    fsSync.mkdirSync(userDataRoot, { recursive: true });
    // 写探针：目录可能存在但不可写（比如装进 Program Files），
    // 那样 setPath 后所有持久化都会失败，不如回退 Electron 默认 %APPDATA%。
    const probe = path.join(userDataRoot, ".write-probe");
    fsSync.writeFileSync(probe, "");
    fsSync.rmSync(probe, { force: true });
    app.setPath("userData", userDataRoot);
  } catch {
    // 保持默认 userData，路径问题绝不阻塞启动。
  }
}

function configuredUserDataRoot(): string | null {
  const configured = process.env.RIVERMOON_USER_DATA_DIR?.trim().replace(/^["']|["']$/g, "");
  if (!configured) return null;
  return path.resolve(configured);
}

function packagedUserDataRoot(): string {
  const exeDir = path.dirname(process.execPath);
  const releaseDir = path.dirname(exeDir);
  const projectDir = path.dirname(releaseDir);
  const isLocalRelease =
    path.basename(exeDir).toLowerCase() === "win-unpacked" &&
    path.basename(releaseDir).toLowerCase() === "release" &&
    fsSync.existsSync(path.join(projectDir, "package.json"));
  // 本地开发反复 dist:dir 会重建 release/win-unpacked；用户数据必须放到项目根，避免模型每次被删。
  if (isLocalRelease) return path.join(projectDir, ".local-user-data");
  return path.join(exeDir, "user-data");
}

/** 窗口底色跟随系统主题；acrylic 材质不可用（Win10 等）时它就是可见背景。 */
function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#1d1d20" : "#f0f2f5";
}

async function createWindow(): Promise<void> {
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(app.getAppPath(), "build", "icon.ico");

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: windowBackgroundColor(),
    // Win11 22H2+ 的系统级亚克力毛玻璃；不支持的系统自动忽略并回退纯色底。
    backgroundMaterial: "acrylic",
    title: "RiverMoon AI 创作台",
    icon: iconPath,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // 安全加固：本应用从不打开新窗口，也不需要导航到外部地址。
  // 一律拦截，避免渲染层被诱导跳转/弹窗到任意 URL（钓鱼、远程代码面）。
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, targetUrl) => {
    const allowed = app.isPackaged ? "file://" : "http://127.0.0.1:5173";
    if (!targetUrl.startsWith(allowed)) {
      event.preventDefault();
      log(`已拦截非法导航 -> ${targetUrl}`);
    }
  });
  mainWindow.webContents.once("did-finish-load", () => {
    log("主窗口加载完成");
  });
  mainWindow.webContents.once("did-fail-load", (_event, errorCode, errorDescription, validatedUrl) => {
    log(`主窗口加载失败 code=${errorCode} reason=${errorDescription} url=${validatedUrl}`);
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    log(`渲染进程异常退出 reason=${details.reason} exitCode=${details.exitCode}`);
  });
  mainWindow.on("unresponsive", () => {
    log("主窗口无响应");
  });
  mainWindow.on("responsive", () => {
    log("主窗口恢复响应");
  });

  jobQueue = new JobQueue(() => mainWindow, await loadSavedJobs());
  imageQueue = new ImageTaskQueue(
    () => mainWindow,
    await loadSavedImageTasks(),
    (task) => {
      // 终态钩子：产物进入路径白名单（预览/定位/送超分），并让余额缓存失效。
      if (task.outputPaths.length > 0) allowPaths(task.outputPaths);
      invalidateAccountCache();
    }
  );
  videoQueue = new VideoTaskQueue(
    () => mainWindow,
    await loadSavedVideoTasks(),
    (task) => {
      if (task.outputPath) allowPaths([task.outputPath]);
      invalidateAccountCache();
    }
  );
  // 历史生图产物允许预览与「打开位置」。
  for (const task of imageQueue.getTasks()) {
    if (task.outputPaths.length > 0) allowPaths(task.outputPaths);
  }
  for (const task of videoQueue.getTasks()) {
    if (task.outputPath) allowPaths([task.outputPath]);
  }

  try {
    if (!app.isPackaged) {
      await mainWindow.loadURL("http://127.0.0.1:5173");
    } else {
      await mainWindow.loadFile(path.join(app.getAppPath(), "dist", "renderer", "index.html"));
    }
  } catch (error) {
    log(`窗口加载失败：${error instanceof Error ? error.message : String(error)}`);
    dialog.showErrorBox("RiverMoon 启动失败", "界面加载失败。请重启应用；若反复出现，请在关于页导出诊断日志反馈。");
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function registerIpc(): void {
  ipcMain.on("app:renderer-ready", (_event, payload: unknown) => {
    log(rendererReadyLog(payload));
  });

  ipcMain.handle("assets:status", () => getAssetStatus());

  ipcMain.handle("hardware:probe", async (_event, force?: boolean) => {
    lastHardwareReport = await getHardwareReport(Boolean(force));
    return lastHardwareReport;
  });

  ipcMain.handle("settings:get", () => loadSettings());
  ipcMain.handle("settings:save", (_event, settings: unknown) => saveSettings(settings));

  ipcMain.handle("app:get-info", () => getAppInfo());

  ipcMain.handle("updates:check", () => checkForUpdates(app.getVersion()));

  ipcMain.handle("updates:open-release", (_event, url: unknown) => {
    if (isAllowedUpdatePageUrl(url)) void shell.openExternal(url);
  });

  ipcMain.handle("logs:reveal", () => shell.openPath(logsRoot()));

  ipcMain.handle("clipboard:write-text", (_event, text: unknown) => {
    if (typeof text !== "string" || text.length === 0) return;
    clipboard.writeText(text.slice(0, 20_000));
  });

  ipcMain.handle("logs:export", async () => {
    const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const options = {
      title: "导出诊断日志",
      defaultPath: `rivermoon-诊断-${stamp}.txt`,
      filters: [{ name: "文本", extensions: ["txt"] }]
    };
    const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return null;
    await fs.writeFile(result.filePath, await buildDiagnostics(), "utf8");
    log(`诊断日志已导出 -> ${result.filePath}`);
    return result.filePath;
  });

  ipcMain.handle("dialog:select-files", async () => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: "选择图片",
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }]
        })
      : await dialog.showOpenDialog({
          title: "选择图片",
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] }]
        });
    if (result.canceled) return [];
    const files = await discoverImageFiles(result.filePaths);
    allowPaths(files);
    return files;
  });

  ipcMain.handle("dialog:select-image-references", async () => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: "选择生图参考图",
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "Images", extensions: IMAGE_REFERENCE_DIALOG_EXTENSIONS }]
        })
      : await dialog.showOpenDialog({
          title: "选择生图参考图",
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "Images", extensions: IMAGE_REFERENCE_DIALOG_EXTENSIONS }]
        });
    if (result.canceled) return { paths: [], rejected: [] };
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const filePath of result.filePaths) {
      const resolved = path.resolve(filePath);
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) {
          rejected.push(`参考图不是可读取文件：${path.basename(resolved)}`);
          continue;
        }
        const metaError = validateImageSourceFileMeta(resolved, stat.size);
        if (metaError) {
          rejected.push(metaError);
          continue;
        }
        const header = await readFileHeader(resolved, 16);
        const contentError = validateImageSourceFileContent(resolved, header);
        if (contentError) {
          rejected.push(contentError);
          continue;
        }
        accepted.push(resolved);
      } catch {
        rejected.push(`参考图无法读取：${path.basename(resolved)}`);
      }
    }
    const files = Array.from(new Set(accepted));
    allowPaths(files);
    return { paths: files, rejected };
  });

  ipcMain.handle("dialog:select-video-sources", async () => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: "选择视频参考图",
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "Images", extensions: VIDEO_SOURCE_DIALOG_EXTENSIONS }]
        })
      : await dialog.showOpenDialog({
          title: "选择视频参考图",
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "Images", extensions: VIDEO_SOURCE_DIALOG_EXTENSIONS }]
        });
    if (result.canceled) return { paths: [], rejected: [] };
    const accepted: string[] = [];
    const rejected: string[] = [];
    for (const filePath of result.filePaths) {
      const resolved = path.resolve(filePath);
      try {
        const stat = await fs.stat(resolved);
        if (!stat.isFile()) {
          rejected.push(`参考图不是可读取文件：${path.basename(resolved)}`);
          continue;
        }
        const error = validateVideoSourceFileMeta(resolved, stat.size);
        if (error) {
          rejected.push(error);
          continue;
        }
        const header = await readFileHeader(resolved, 16);
        const contentError = validateVideoSourceFileContent(resolved, header);
        if (contentError) {
          rejected.push(contentError);
          continue;
        }
        accepted.push(resolved);
      } catch {
        rejected.push(`参考图无法读取：${path.basename(resolved)}`);
      }
    }
    const files = Array.from(new Set(accepted));
    allowPaths(files);
    return { paths: files, rejected };
  });

  ipcMain.handle("dialog:select-folder", async () => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: "选择图片文件夹",
          properties: ["openDirectory"]
        })
      : await dialog.showOpenDialog({
          title: "选择图片文件夹",
          properties: ["openDirectory"]
        });
    if (result.canceled) return [];
    const files = await discoverImageFiles(result.filePaths);
    allowPaths(files);
    return files;
  });

  ipcMain.handle("dialog:select-output-directory", async () => {
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, {
          title: "选择输出目录",
          properties: ["openDirectory", "createDirectory"]
        })
      : await dialog.showOpenDialog({
          title: "选择输出目录",
          properties: ["openDirectory", "createDirectory"]
        });
    if (result.canceled) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle("files:discover", async (_event, paths: unknown) => {
    const files = await discoverImageFiles(toStringArray(paths));
    allowPaths(files);
    return files;
  });

  ipcMain.handle("jobs:start", (_event, payload: unknown) => {
    const raw = (payload && typeof payload === "object" ? payload : {}) as Partial<StartJobsPayload>;
    const paths = toStringArray(raw.paths).filter(isAllowedPath);
    if (paths.length === 0) return [];
    return jobQueue.startJobs({ paths, settings: raw.settings as StartJobsPayload["settings"] });
  });
  ipcMain.handle("jobs:list", () => jobQueue.getJobs());
  ipcMain.handle("jobs:cancel", (_event, id: string) => jobQueue.cancelJob(id));
  ipcMain.handle("jobs:clear-finished", () => jobQueue.clearFinished());

  ipcMain.handle("shell:reveal", async (_event, filePath: unknown) => {
    if (!isAllowedPath(filePath)) return;
    await shell.showItemInFolder(filePath);
  });

  ipcMain.handle("account:get-status", (_event, force?: boolean) => getAccountStatus(Boolean(force)));

  ipcMain.handle("account:set-key", async (_event, key: unknown): Promise<AccountStatus> => {
    try {
      return await setAccountKey(key);
    } catch (error) {
      // 校验失败不保存新 Key；若原本已有可用连接则保留旧状态，只附加错误说明。
      const message = error instanceof RelayError ? error.message : "校验失败，请稍后重试。";
      const current = loadKey() ? await getAccountStatus() : null;
      if (current?.connected) return { ...current, error: `新 Key 校验失败（${message}），已保留原连接。` };
      return { connected: false, maskedKey: null, models: [], totalUsd: null, usedUsd: null, error: message };
    }
  });

  ipcMain.handle("account:clear-key", () => clearAccountKey());

  ipcMain.handle("account:open-topup", () => {
    // openExternal 白名单：只允许打开中转站域名，防止任意 URL 注入。
    if (TOPUP_URL.startsWith("https://rivermoon7.com")) void shell.openExternal(TOPUP_URL);
  });

  ipcMain.handle("image:contract", () => fetchImageContract());

  ipcMain.handle("image-gen:start", async (_event, params: unknown) => {
    const clean = sanitizeImageParams(params);
    if (!clean) return null;
    clean.referencePaths = clean.referencePaths.filter(isAllowedPath);
    if (
      Array.isArray((params as { referencePaths?: unknown } | null)?.referencePaths) &&
      clean.referencePaths.length === 0
    ) {
      const requested = (params as { referencePaths?: unknown }).referencePaths;
      if (Array.isArray(requested) && requested.length > 0)
        throw new Error("参考图路径未通过安全校验，请重新选择参考图。");
    }
    const contract = await fetchImageContract();
    const validation = validateImageParamsAgainstContract(clean, contract);
    if (!validation.ok) throw new Error(validation.error);
    return imageQueue.start(clean);
  });
  ipcMain.handle("image-gen:list", () => imageQueue.getTasks());
  ipcMain.handle("image-gen:cancel", (_event, id: unknown) => {
    if (typeof id === "string") imageQueue.cancel(id);
  });
  ipcMain.handle("image-gen:clear-finished", () => imageQueue.clearFinished());

  ipcMain.handle("video:contract", () => fetchVideoContract());
  ipcMain.handle("video:diagnostics", () => runVideoGatewayDiagnostics());
  ipcMain.handle("video-gen:start", async (_event, params: unknown) => {
    const clean = sanitizeVideoParams(params);
    if (!clean) return null;
    if (clean.endpoint === "text_to_video") {
      clean.referencePaths = [];
      clean.referenceTypes = [];
    }
    const allowedReferences = clean.referencePaths
      .map((referencePath, index) => ({
        referencePath,
        referenceType: clean.referenceTypes[index] ?? clean.referenceType
      }))
      .filter((item) => isAllowedPath(item.referencePath));
    clean.referencePaths = allowedReferences.map((item) => item.referencePath);
    clean.referenceTypes = allowedReferences.map((item) => item.referenceType);
    if (clean.endpoint !== "text_to_video" && clean.referencePaths.length === 0)
      throw new Error("当前视频模式需要至少 1 张参考图。");
    const contract = await fetchFreshHttpsVideoContract();
    const validation = validateVideoParamsAgainstContract(clean, contract);
    if (!validation.ok) throw new Error(validation.error);
    clean.requestEndpoint = validation.requestEndpoint;
    return videoQueue.start(clean, { estimatedCostUsd: validation.estimatedCostUsd });
  });
  ipcMain.handle("video-gen:list", () => videoQueue.getTasks());
  ipcMain.handle("video-gen:sync-recent", () => videoQueue.syncRecent());
  ipcMain.handle("video-gen:cancel", (_event, id: unknown) => {
    if (typeof id === "string") videoQueue.cancel(id);
  });
  ipcMain.handle("video-gen:resume", (_event, id: unknown) => (typeof id === "string" ? videoQueue.resume(id) : null));
  ipcMain.handle("video-gen:retry", (_event, id: unknown) => (typeof id === "string" ? videoQueue.retry(id) : null));
  ipcMain.handle("video-gen:clear-finished", () => videoQueue.clearFinished());

  ipcMain.handle("agent-chat:start", async (event, request: unknown) => {
    const clean = sanitizeAgentChatRequest(request);
    if (!clean) return { ok: false, content: "", error: "GPT 对话参数无效。", needsTopup: false };
    const key = loadKey();
    if (!key) return { ok: false, content: "", error: "未连接账户，请先在设置里填写 API Key。", needsTopup: false };

    const controller = new AbortController();
    agentResponses.set(clean.requestId, controller);
    try {
      const content = await runAgentResponse(clean, key, controller.signal, (delta) => {
        event.sender.send("agent-chat:event", { requestId: clean.requestId, delta });
      });
      event.sender.send("agent-chat:event", { requestId: clean.requestId, done: true, content });
      invalidateAccountCache();
      return { ok: true, content, error: null, needsTopup: false };
    } catch (error) {
      const aborted = controller.signal.aborted;
      const message = aborted
        ? "已取消"
        : error instanceof RelayError
          ? error.message
          : error instanceof Error
            ? error.message
            : "GPT 请求失败。";
      const needsTopup = !aborted && error instanceof RelayError && error.kind === "quota";
      event.sender.send("agent-chat:event", { requestId: clean.requestId, done: true, error: message, needsTopup });
      return { ok: false, content: "", error: message, needsTopup };
    } finally {
      agentResponses.delete(clean.requestId);
    }
  });

  ipcMain.handle("agent-chat:cancel", (_event, requestId: unknown) => {
    if (typeof requestId === "string") agentResponses.get(requestId)?.abort();
  });

  ipcMain.handle("media:local-url", (_event, filePath: unknown) => {
    if (!isAllowedPath(filePath)) return null;
    return pathToFileURL(filePath).toString();
  });

  ipcMain.handle("model:get-status", () => getModelStatus());
  ipcMain.handle("model:download", (_event, fileName: unknown) => startModelDownload(fileName));
  ipcMain.handle("model:cancel-download", () => cancelModelDownload());
  onModelDownloadUpdate((state) => {
    mainWindow?.webContents.send("model:download-update", state);
  });

  // 清理上次强退可能残留的模型下载临时文件（每个 67MB）。
  void cleanupStaleDownloads();
  // 清理上次强退可能残留的视频下载半成品，避免 .download 文件留在资产库。
  void cleanupStaleVideoDownloads(videoAssetsRootForUserData(app.getPath("userData"))).then((result) => {
    if (result.removed > 0 || result.failed > 0) {
      log(`视频下载临时文件清理完成 removed=${result.removed} failed=${result.failed}`);
    }
  });

  ipcMain.handle("image:preview", async (_event, filePath: unknown, maxSide?: number, quality?: number) => {
    if (!isAllowedPath(filePath)) return null;
    const safeQuality =
      typeof quality === "number" && Number.isFinite(quality) ? Math.min(100, Math.max(1, Math.round(quality))) : 80;
    try {
      return await previewDataUrl(filePath, maxSide ?? 1200, safeQuality);
    } catch {
      return null;
    }
  });
}

/** 把任意 IPC 入参规整成「字符串数组」，过滤掉非字符串/空串，避免下游崩溃。 */
function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

async function readFileHeader(filePath: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function buildDiagnostics(): Promise<string> {
  const info = getAppInfo();
  const localUpscaleDiagnostics = await buildLocalUpscaleDiagnostics();
  const videoDiagnostics = await runVideoGatewayDiagnostics().catch((error) => ({
    error: error instanceof Error ? error.message : String(error)
  }));
  return [
    "RiverMoon AI 创作台 诊断信息",
    `导出时间：${new Date().toISOString()}`,
    `版本：${info.version}  Electron：${info.electron}  Node：${process.versions.node}`,
    `平台：${process.platform} ${process.arch}`,
    `ComfyUI Runtime：${info.comfyuiRuntimePath ?? "未找到"}`,
    `ComfyUI 模型：${info.comfyuiModels.join(", ") || "无"}`,
    `资源目录：${info.resourcesRoot}`,
    "",
    "[本地超分链路]",
    localUpscaleDiagnostics,
    "",
    "[硬件检测]",
    lastHardwareReport ? JSON.stringify(lastHardwareReport, null, 2) : "（尚未运行检测）",
    "",
    "[视频网关检测]",
    JSON.stringify(videoDiagnostics, null, 2),
    "",
    "[最近日志]",
    redactDiagnosticsText(readRecentLog() || "（暂无日志）")
  ].join("\n");
}

async function buildLocalUpscaleDiagnostics(): Promise<string> {
  // 按当前设置选用的模型做诊断（注册表内可切换：UltraSharp / RealESRGAN）。
  const selectedModel = loadSettings().upscaleModel;
  const spec = findModelSpec(selectedModel);
  const modelPath = findComfyModel(selectedModel);
  const modelStat = modelPath ? await fs.stat(modelPath).catch(() => null) : null;
  const modelHash = modelPath ? await readModelSha256(modelPath) : { value: null, error: null };
  const modelHashMatches = spec != null && modelHash.value === spec.sha256;
  return [
    `工作流：${describeStandardWorkflow()}`,
    `模型文件：${selectedModel}${spec ? `（${spec.license}）` : ""}`,
    `模型大小：${modelStat ? `${modelStat.size} bytes` : "未找到"}`,
    `模型 SHA256：${modelHash.value ?? (modelHash.error ? `计算失败：${modelHash.error}` : "未找到")}`,
    `期望 SHA256：${spec?.sha256 ?? "未知模型"}`,
    `模型校验：${modelHash.value ? (modelHashMatches ? "通过" : "不匹配") : modelHash.error ? "无法校验" : "未找到"}`,
    "默认尺寸策略：最大长边 4096；用户填 0 时按真实 4x 输出",
    "ComfyUI prompt 模板：",
    JSON.stringify(buildStandardPromptTemplate(selectedModel), null, 2)
  ].join("\n");
}

async function readModelSha256(filePath: string): Promise<{ value: string | null; error: string | null }> {
  try {
    return { value: await sha256File(filePath), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fsSync.createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex").toLowerCase();
}

function rendererReadyLog(payload: unknown): string {
  const raw = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const modules = Array.isArray(raw.modules)
    ? raw.modules
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => /^[a-z0-9_-]{1,32}$/i.test(item))
        .slice(0, 12)
    : [];
  const activeModule = typeof raw.activeModule === "string" ? raw.activeModule.trim() : "";
  const safeActiveModule = /^[a-z0-9_-]{1,32}$/i.test(activeModule) ? activeModule : "unknown";
  const videoNav = raw.videoNav === true && modules.includes("videogen");
  return `渲染层就绪 active=${safeActiveModule} modules=${modules.join(",") || "-"} videoNav=${videoNav}`;
}

function getAppInfo(): AppInfo {
  const comfyStatus = comfyRuntimeStatus();
  const qualityModes = getQualityModeStatus();
  return {
    name: app.getName(),
    version: app.getVersion(),
    electron: process.versions.electron,
    comfyuiRuntimePath: comfyStatus.pythonPath && findComfyModel(DEFAULT_MODEL) ? comfyRuntimeRoot() : null,
    comfyuiModels: listComfyModels().filter((model) => model === DEFAULT_MODEL),
    qualityModes,
    resourcesRoot: appRoot()
  };
}

function getAssetStatus(): AssetStatus {
  const comfyStatus = comfyRuntimeStatus();
  const comfyuiModels = listComfyModels().filter((model) => model === DEFAULT_MODEL);
  const qualityModes = getQualityModeStatus();
  const missing: string[] = [];
  if (!comfyStatus.pythonPath) missing.push("ComfyUI Runtime");
  if (!comfyStatus.modelPath) missing.push(DEFAULT_MODEL);
  return {
    ok: Boolean(comfyStatus.pythonPath && comfyStatus.modelPath),
    comfyuiRuntimePath: comfyStatus.pythonPath ? comfyStatus.root : null,
    comfyuiPythonPath: comfyStatus.pythonPath,
    comfyuiModelPath: comfyStatus.modelPath,
    modelsPath: modelsRoot(),
    missing,
    comfyuiModels,
    qualityModes,
    resourcesRoot: appRoot()
  };
}

function getQualityModeStatus(): AssetStatus["qualityModes"] {
  const standardMissing: string[] = [];
  if (!comfyPythonReady()) standardMissing.push("ComfyUI Runtime");
  // 以当前设置选用的模型为准（注册表内多模型可切换）。
  const selectedModel = loadSettings().upscaleModel;
  if (!findComfyModel(selectedModel)) standardMissing.push(selectedModel);

  return {
    standard: { ok: standardMissing.length === 0, label: "网站同款 AI", missing: standardMissing }
  };
}

function comfyPythonReady(): boolean {
  const status = comfyRuntimeStatus();
  return Boolean(status.pythonPath && fsSync.existsSync(status.mainPath));
}

// 主进程全局兜底：未捕获异常/未处理拒绝只记日志，不让整个应用静默崩溃。
process.on("uncaughtException", (error) => {
  log(`未捕获异常：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
});
process.on("unhandledRejection", (reason) => {
  log(`未处理的 Promise 拒绝：${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

function applyContentSecurityPolicy(): void {
  // 仅对打包版注入 CSP；开发版走 Vite，注入会破坏 HMR。
  // 渲染层只用本地资源 + data:/blob: 预览图，不向外发起任何网络请求。
  if (!app.isPackaged) return;
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self'; img-src 'self' data: blob: file:; media-src 'self' file: blob: data:; style-src 'self' 'unsafe-inline'; " +
            "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        ]
      }
    });
  });
}

// 单实例锁：避免双开争抢同一份 jobs.json 与 ComfyUI 端口（18188）。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    // 用户再次启动时，聚焦已有窗口而不是开新实例。
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // 退出前：最终同步落盘任务记录，并杀掉内置 ComfyUI 子进程，避免 python.exe 残留吃显存。
  app.on("will-quit", () => {
    for (const controller of agentResponses.values()) controller.abort();
    agentResponses.clear();
    try {
      jobQueue?.flushSync();
    } catch {
      // 退出落盘失败不阻塞退出。
    }
    try {
      imageQueue?.flushSync();
    } catch {
      // 同上。
    }
    try {
      videoQueue?.flushSync();
    } catch {
      // 同上。
    }
    shutdownComfy();
  });

  void app.whenReady().then(async () => {
    log(`应用启动 v${app.getVersion()} · ${process.platform} ${process.arch}`);
    // 开发便利：环境变量注入测试 Key（仅未打包时），便于自动化验证账户链路。
    if (!app.isPackaged && process.env.RIVERMOON_TEST_KEY && !loadKey()) {
      saveKey(process.env.RIVERMOON_TEST_KEY);
      log("已从 RIVERMOON_TEST_KEY 注入开发测试 Key");
    }
    applyContentSecurityPolicy();
    registerIpc();
    nativeTheme.on("updated", () => {
      mainWindow?.setBackgroundColor(windowBackgroundColor());
    });
    await createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
