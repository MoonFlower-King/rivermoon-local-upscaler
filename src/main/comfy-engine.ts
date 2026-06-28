import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { app } from "electron";
import { outputExtension } from "./image.js";
import {
  comfyInputRoot,
  comfyMainPath,
  comfyOutputRoot,
  comfyPythonPath,
  comfyRuntimeRoot,
  findComfyModel
} from "./paths.js";
import { log, logsRoot } from "./logger.js";
import { DEFAULT_MODEL } from "./settings.js";
import type { ImageDimensions, ImageFormat, UpscaleSettings } from "./types.js";

const MANAGED_PORT = 18188;
const MANAGED_URL = `http://127.0.0.1:${MANAGED_PORT}`;
const READY_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 1500;

type ComfyHistoryItem = {
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: unknown[];
  };
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }>;
};

type ComfyPromptResponse = {
  prompt_id?: string;
  node_errors?: unknown;
};

type ComfyProgressPayload = {
  type?: string;
  data?: {
    prompt_id?: string;
    node?: string | null;
    value?: number;
    max?: number;
    nodes?: Record<
      string,
      {
        value?: number;
        max?: number;
        state?: string;
        node_id?: string;
        prompt_id?: string;
      }
    >;
    exception_message?: string;
    exception_type?: string;
  };
};

export type ComfyRunOptions = {
  inputPath: string;
  outputPath: string;
  settings: UpscaleSettings;
  inputDimensions: ImageDimensions;
  targetDimensions: ImageDimensions;
  format: ImageFormat;
  signal: AbortSignal;
  onProgress?: (percent: number) => void;
};

let managedProcess: ChildProcess | null = null;
let startupPromise: Promise<string> | null = null;

export function comfyRuntimeStatus(): {
  root: string;
  pythonPath: string | null;
  mainPath: string;
  modelPath: string | null;
} {
  return {
    root: comfyRuntimeRoot(),
    pythonPath: comfyPythonPath(),
    mainPath: comfyMainPath(),
    modelPath: findComfyModel("4x-UltraSharp.pth")
  };
}

/** 退出应用前调用：杀掉内置 ComfyUI 子进程，避免 python.exe 残留占用显存与端口。 */
export function shutdownComfy(): void {
  try {
    managedProcess?.kill();
  } catch {
    // 进程可能已退出，忽略。
  }
  managedProcess = null;
}

export async function runComfyEngine(options: ComfyRunOptions): Promise<void> {
  assertQualityResources();

  const comfyUrl = await ensureComfyReady(options.signal);
  options.onProgress?.(8);

  const jobId = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const inputName = await copyInputToComfy(options.inputPath, jobId);
  const copiedInputPath = path.join(comfyInputRoot(), inputName);
  try {
    const prefix = `rivermoon_desktop_ai/${jobId}`;
    const prompt = buildStandardPrompt(inputName, DEFAULT_MODEL, options.targetDimensions, prefix);
    const clientId = `rivermoon-desktop-${crypto.randomUUID()}`;

    options.onProgress?.(12);
    const promptId = await submitPrompt(comfyUrl, prompt, clientId, options.signal);
    log(`ComfyUI 任务已提交 prompt=${promptId} model=${DEFAULT_MODEL}`);

    const history = await waitForPrompt(comfyUrl, promptId, clientId, options.signal, options.onProgress);
    const comfyOutput = findSavedImage(history);
    const sourcePath = resolveComfyOutputPath(comfyOutput);
    await fsp.mkdir(path.dirname(options.outputPath), { recursive: true });
    await copyOrConvertOutput(sourcePath, options.outputPath, options.format);
    options.onProgress?.(100);
  } finally {
    // 清理复制进 ComfyUI input 目录的临时输入文件，避免磁盘占用无限增长。
    await fsp.rm(copiedInputPath, { force: true }).catch(() => {
      // 清理失败不影响主流程。
    });
  }
}

async function ensureComfyReady(signal: AbortSignal): Promise<string> {
  // 只有开发环境显式开启时才允许复用外部 ComfyUI。打包版固定使用内置 runtime，避免误连到用户机器上的其他工作流。
  if (!app.isPackaged && process.env.RIVERMOON_USE_EXTERNAL_COMFYUI === "1") {
    const configuredUrl = process.env.RIVERMOON_COMFYUI_URL || process.env.COMFYUI_URL || "http://127.0.0.1:8188";
    if (await isReady(configuredUrl)) return configuredUrl.replace(/\/$/, "");
  }

  if (await isReady(MANAGED_URL)) return MANAGED_URL;
  if (!startupPromise) {
    startupPromise = startManagedComfy(signal).finally(() => {
      startupPromise = null;
    });
  }
  return startupPromise;
}

async function startManagedComfy(signal: AbortSignal): Promise<string> {
  const pythonPath = comfyPythonPath();
  const mainPath = comfyMainPath();
  if (!pythonPath || !fs.existsSync(mainPath)) {
    throw new Error(
      [
        "缺少内置 ComfyUI Runtime，无法使用“网站同款 CUDA”模式。",
        `期望目录：${comfyRuntimeRoot()}`,
        "请先运行 scripts\\prepare-comfyui-runtime.ps1，或重新安装包含 ComfyUI Runtime 的完整版。"
      ].join(" ")
    );
  }

  await fsp.mkdir(path.join(comfyRuntimeRoot(), "input"), { recursive: true });
  await fsp.mkdir(path.join(comfyRuntimeRoot(), "output"), { recursive: true });
  await fsp.mkdir(path.join(comfyRuntimeRoot(), "temp"), { recursive: true });

  const logPath = path.join(logsRoot(), `comfyui-${Date.now()}.log`);
  const logFile = fs.openSync(logPath, "a");
  const child = spawn(pythonPath, [mainPath, "--port", String(MANAGED_PORT), "--listen", "127.0.0.1"], {
    cwd: comfyRuntimeRoot(),
    windowsHide: true,
    detached: false,
    stdio: ["ignore", logFile, logFile]
  });
  managedProcess = child;
  log(`启动内置 ComfyUI runtime pid=${child.pid ?? "-"} log=${logPath}`);

  child.on("exit", (code) => {
    log(`内置 ComfyUI 已退出 code=${code ?? "null"}`);
    if (managedProcess === child) managedProcess = null;
    try {
      fs.closeSync(logFile);
    } catch {
      // Ignore stale descriptor.
    }
  });

  const abort = () => {
    managedProcess?.kill();
  };
  signal.addEventListener("abort", abort, { once: true });

  const startedAt = Date.now();
  while (Date.now() - startedAt < READY_TIMEOUT_MS) {
    if (signal.aborted) throw new Error("任务已取消。");
    if (await isReady(MANAGED_URL)) {
      signal.removeEventListener("abort", abort);
      return MANAGED_URL;
    }
    await delay(1000);
  }

  signal.removeEventListener("abort", abort);
  throw new Error("内置 ComfyUI 启动超时。请导出诊断日志查看 ComfyUI 启动输出。");
}

async function isReady(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}/system_stats`, { signal: AbortSignal.timeout(2500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function copyInputToComfy(inputPath: string, jobId: string): Promise<string> {
  await fsp.mkdir(comfyInputRoot(), { recursive: true });
  const extension = path.extname(inputPath).toLowerCase();
  const name = `${jobId}_${safeName(path.basename(inputPath, extension))}${extension}`;
  await fsp.copyFile(inputPath, path.join(comfyInputRoot(), name));
  return name;
}

function buildStandardPrompt(
  inputName: string,
  modelName: string,
  target: ImageDimensions,
  filenamePrefix: string
): Record<string, unknown> {
  return {
    "1": {
      class_type: "LoadImage",
      inputs: { image: inputName }
    },
    "2": {
      class_type: "UpscaleModelLoader",
      inputs: { model_name: modelName }
    },
    "3": {
      class_type: "ImageUpscaleWithModel",
      inputs: {
        upscale_model: ["2", 0],
        image: ["1", 0]
      }
    },
    "4": {
      class_type: "ImageScale",
      inputs: {
        image: ["3", 0],
        upscale_method: "lanczos",
        width: target.width,
        height: target.height,
        crop: "disabled"
      }
    },
    "5": {
      class_type: "SaveImage",
      inputs: {
        images: ["4", 0],
        filename_prefix: filenamePrefix
      }
    }
  };
}

async function submitPrompt(
  url: string,
  prompt: Record<string, unknown>,
  clientId: string,
  signal: AbortSignal
): Promise<string> {
  const response = await fetch(`${url}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, client_id: clientId }),
    signal
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`ComfyUI 提交失败：${text}`);
  const parsed = JSON.parse(text) as ComfyPromptResponse;
  if (parsed.node_errors && Object.keys(parsed.node_errors as Record<string, unknown>).length > 0) {
    throw new Error(`ComfyUI 工作流校验失败：${JSON.stringify(parsed.node_errors)}`);
  }
  if (!parsed.prompt_id) throw new Error(`ComfyUI 未返回 prompt_id：${text}`);
  return parsed.prompt_id;
}

async function waitForPrompt(
  url: string,
  promptId: string,
  clientId: string,
  signal: AbortSignal,
  onProgress?: (percent: number) => void
): Promise<ComfyHistoryItem> {
  try {
    return await waitForPromptWebsocket(url, promptId, clientId, signal, onProgress);
  } catch (error) {
    log(`ComfyUI websocket 进度不可用，回退轮询 ${error instanceof Error ? error.message : String(error)}`);
    return pollPrompt(url, promptId, signal, onProgress);
  }
}

async function waitForPromptWebsocket(
  url: string,
  promptId: string,
  clientId: string,
  signal: AbortSignal,
  onProgress?: (percent: number) => void
): Promise<ComfyHistoryItem> {
  const wsUrl = `${url.replace(/^http/, "ws")}/ws?clientId=${encodeURIComponent(clientId)}`;
  const socket = new WebSocket(wsUrl);
  let currentNode = "";
  let settled = false;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("websocket 等待超时")), 60 * 60 * 1000);
    const historyTimer = setInterval(() => {
      void fetchHistory(url, promptId, signal)
        .then((history) => {
          if (history.status?.completed) void finish(history);
        })
        .catch(() => {
          // History is absent while the prompt is still queued or executing.
        });
    }, POLL_INTERVAL_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      clearInterval(historyTimer);
      signal.removeEventListener("abort", abort);
      try {
        socket.close();
      } catch {
        // Ignore closed sockets.
      }
    };
    const finish = async (knownHistory?: ComfyHistoryItem) => {
      if (settled) return;
      settled = true;
      try {
        onProgress?.(92);
        const history = knownHistory ?? (await fetchHistory(url, promptId, signal));
        cleanup();
        resolve(history);
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("任务已取消。"));
    };
    signal.addEventListener("abort", abort, { once: true });

    socket.addEventListener("open", () => onProgress?.(12));
    socket.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("websocket 连接失败"));
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      let payload: ComfyProgressPayload;
      try {
        payload = JSON.parse(event.data) as ComfyProgressPayload;
      } catch {
        return;
      }
      const data = payload.data ?? {};
      if (data.prompt_id && data.prompt_id !== promptId) return;

      if (payload.type === "executing") {
        currentNode = data.node ?? "";
        if (data.node == null) void finish();
      } else if (payload.type === "progress_state" && data.nodes) {
        const nextProgress = progressFromState(data.nodes, promptId);
        if (nextProgress != null) onProgress?.(nextProgress);
      } else if (payload.type === "progress" && typeof data.value === "number" && typeof data.max === "number" && data.max > 0) {
        const nodeBase = progressBaseForNode(currentNode);
        const nodeSpan = progressSpanForNode(currentNode);
        onProgress?.(Math.min(90, nodeBase + Math.round((data.value / data.max) * nodeSpan)));
      } else if (payload.type === "execution_error") {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(data.exception_message || data.exception_type || "ComfyUI 执行失败"));
      } else if (payload.type === "execution_success") {
        void finish();
      }
    });
  });
}

function progressFromState(
  nodes: NonNullable<ComfyProgressPayload["data"]>["nodes"],
  promptId: string
): number | null {
  if (!nodes) return null;
  let best: number | null = null;

  for (const [key, state] of Object.entries(nodes)) {
    if (state.prompt_id && state.prompt_id !== promptId) continue;
    const node = state.node_id || key;
    const value = typeof state.value === "number" ? state.value : null;
    const max = typeof state.max === "number" && state.max > 0 ? state.max : null;
    const ratio = state.state === "finished" ? 1 : value != null && max ? value / max : state.state === "running" ? 0 : null;
    if (ratio == null) continue;
    const nodeBase = progressBaseForNode(node);
    const nodeSpan = progressSpanForNode(node);
    const nodeProgress = Math.min(90, nodeBase + Math.round(Math.max(0, Math.min(1, ratio)) * nodeSpan));
    best = best == null ? nodeProgress : Math.max(best, nodeProgress);
  }

  return best;
}

async function fetchHistory(url: string, promptId: string, signal: AbortSignal): Promise<ComfyHistoryItem> {
  const response = await fetch(`${url}/history/${promptId}`, { signal });
  if (!response.ok) throw new Error("ComfyUI 历史记录读取失败。");
  const history = (await response.json()) as Record<string, ComfyHistoryItem>;
  const item = history[promptId];
  if (!item) throw new Error("ComfyUI 已完成，但没有找到任务历史记录。");
  const status = item.status?.status_str ?? "";
  if (item.status?.completed && status.toLowerCase() !== "success" && status.toLowerCase() !== "completed") {
    throw new Error(`ComfyUI 执行失败：${JSON.stringify(item.status)}`);
  }
  return item;
}

async function pollPrompt(
  url: string,
  promptId: string,
  signal: AbortSignal,
  onProgress?: (percent: number) => void
): Promise<ComfyHistoryItem> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60 * 60 * 1000) {
    if (signal.aborted) throw new Error("任务已取消。");
    try {
      const item = await fetchHistory(url, promptId, signal);
      if (item?.status?.completed) {
        onProgress?.(92);
        return item;
      }
    } catch {
      // History is absent while the prompt is still queued or executing.
    }

    onProgress?.(20);
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error("ComfyUI 执行超时。");
}

function progressBaseForNode(node: string): number {
  if (node === "3") return 20;
  if (node === "4") return 78;
  if (node === "5") return 88;
  return 15;
}

function progressSpanForNode(node: string): number {
  if (node === "3") return 58;
  if (node === "4") return 10;
  if (node === "5") return 2;
  return 10;
}

function findSavedImage(history: ComfyHistoryItem): { filename: string; subfolder?: string; type?: string } {
  const images = history.outputs?.["5"]?.images;
  const first = images?.[0];
  if (!first?.filename) throw new Error("ComfyUI 已完成，但没有生成 SaveImage 输出。");
  return first;
}

function resolveComfyOutputPath(image: { filename: string; subfolder?: string; type?: string }): string {
  const root =
    image.type === "input"
      ? comfyInputRoot()
      : image.type === "temp"
        ? path.join(comfyRuntimeRoot(), "temp")
        : comfyOutputRoot();
  return path.join(root, image.subfolder ?? "", image.filename);
}

async function copyOrConvertOutput(sourcePath: string, outputPath: string, format: ImageFormat): Promise<void> {
  if (!fs.existsSync(sourcePath)) throw new Error(`ComfyUI 输出文件不存在：${sourcePath}`);
  const wantedExt = outputExtension(format).toLowerCase();
  if (path.extname(sourcePath).slice(1).toLowerCase() === wantedExt) {
    await fsp.copyFile(sourcePath, outputPath);
    return;
  }

  const sharp = (await import("sharp")).default;
  let pipeline = sharp(sourcePath);
  if (format === "jpg") {
    pipeline = pipeline.jpeg({ quality: 95, mozjpeg: true });
  } else if (format === "webp") {
    pipeline = pipeline.webp({ quality: 95 });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9 });
  }
  await pipeline.toFile(outputPath);
}

function assertQualityResources(): void {
  if (!findComfyModel(DEFAULT_MODEL)) {
    throw new Error(`缺少 ComfyUI 超分模型 ${DEFAULT_MODEL}。请确认 comfyui-runtime/models/upscale_models 下存在该 .pth 文件。`);
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80) || "image";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
