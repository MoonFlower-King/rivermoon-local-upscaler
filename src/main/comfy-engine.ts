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
  extraModelPathsConfig,
  findComfyModel
} from "./paths.js";
import { log, logsRoot } from "./logger.js";
import { DEFAULT_MODEL } from "./settings.js";
import {
  ComfyExecutionError,
  NODE,
  assertHistoryHealthy,
  buildStandardPrompt,
  progressBaseForNode,
  progressFromState,
  progressSpanForNode,
  type ComfyHistoryItem,
  type ComfyProgressPayload,
  type ComfyPromptResponse
} from "./comfy-protocol.js";
import type { ImageDimensions, ImageFormat, UpscaleSettings } from "./types.js";

const MANAGED_PORT = 18188;
const MANAGED_URL = `http://127.0.0.1:${MANAGED_PORT}`;
const READY_TIMEOUT_MS = 180_000;
/** 回退轮询模式下查询 history 的间隔。 */
const POLL_INTERVAL_MS = 1500;
/** websocket 正常时，history 只作为漏事件的双保险，低频即可。 */
const WS_HISTORY_POLL_MS = 5000;
/** 单个任务等待执行完成的总超时（超大图 + 排队的极端情况兜底）。 */
const EXECUTION_TIMEOUT_MS = 60 * 60 * 1000;
const INTERRUPT_TIMEOUT_MS = 3000;

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
/** 当前正在执行的任务上下文，供 interruptComfy 精确打断。串行队列保证同一时刻至多一个。 */
let activeComfyUrl: string | null = null;
let activePromptId: string | null = null;

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

/**
 * 取消运行中的任务时调用：让 ComfyUI 立即中断当前执行并从队列删除该 prompt，
 * 立刻释放 GPU，而不是任由废弃任务在后台算完整张图。失败静默（ComfyUI 可能未在运行）。
 */
export async function interruptComfy(): Promise<void> {
  const url = activeComfyUrl ?? MANAGED_URL;
  const promptId = activePromptId;
  try {
    await fetch(`${url}/interrupt`, { method: "POST", signal: AbortSignal.timeout(INTERRUPT_TIMEOUT_MS) });
  } catch {
    // ComfyUI 未运行或已停止时无需处理。
  }
  if (!promptId) return;
  try {
    await fetch(`${url}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delete: [promptId] }),
      signal: AbortSignal.timeout(INTERRUPT_TIMEOUT_MS)
    });
  } catch {
    // 同上。
  }
}

export async function runComfyEngine(options: ComfyRunOptions): Promise<void> {
  assertQualityResources();

  const comfyUrl = await ensureComfyReady(options.signal);
  activeComfyUrl = comfyUrl;
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
    activePromptId = promptId;
    log(`ComfyUI 任务已提交 prompt=${promptId} model=${DEFAULT_MODEL}`);

    const history = await waitForPrompt(comfyUrl, promptId, clientId, options.signal, options.onProgress);
    const comfyOutput = findSavedImage(history);
    const sourcePath = resolveComfyOutputPath(comfyOutput);
    await fsp.mkdir(path.dirname(options.outputPath), { recursive: true });
    await copyOrConvertOutput(sourcePath, options.outputPath, options.format);
    // 回收 ComfyUI output 侧的原始产物，否则每个任务都会在 runtime 目录泄漏一张全尺寸图。
    await fsp.rm(sourcePath, { force: true }).catch(() => {
      // 回收失败不影响主流程。
    });
    options.onProgress?.(100);
  } finally {
    activePromptId = null;
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
  const args = [mainPath, "--port", String(MANAGED_PORT), "--listen", "127.0.0.1"];
  // 模型落在 userData 回退目录时（runtime 不可写），把 extra_model_paths 挂给 ComfyUI。
  if (fs.existsSync(extraModelPathsConfig())) {
    args.push("--extra-model-paths-config", extraModelPathsConfig());
  }
  const child = spawn(pythonPath, args, {
    cwd: comfyRuntimeRoot(),
    windowsHide: true,
    detached: false,
    stdio: ["ignore", logFile, logFile]
  });
  managedProcess = child;
  log(`启动内置 ComfyUI runtime pid=${child.pid ?? "-"} log=${logPath}`);

  // 用对象属性记录退出状态：闭包内赋值不受 TS 控制流窄化影响，就绪轮询里能即时读到。
  const exitState = { exited: false, code: null as number | null };

  child.on("error", (error) => {
    exitState.exited = true;
    log(`内置 ComfyUI 启动失败 ${error.message}`);
  });

  child.on("exit", (code) => {
    exitState.exited = true;
    exitState.code = code ?? null;
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
    if (exitState.exited) {
      signal.removeEventListener("abort", abort);
      throw new Error(
        `内置 ComfyUI 启动后立即退出（code=${exitState.code ?? "未知"}）。` +
          `常见原因：端口 ${MANAGED_PORT} 被其他程序占用，或运行时文件损坏。启动日志：${logPath}`
      );
    }
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
  let parsed: ComfyPromptResponse;
  try {
    parsed = JSON.parse(text) as ComfyPromptResponse;
  } catch {
    throw new Error(`ComfyUI 返回了无法解析的响应：${text.slice(0, 200)}`);
  }
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
    // 只有「连接层」错误才值得回退轮询：
    // 执行失败（ComfyExecutionError）和用户取消原样上抛，避免失败任务在轮询里空等。
    if (error instanceof ComfyExecutionError || signal.aborted) throw error;
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

  return new Promise((resolve, reject) => {
    // 所有退出路径（完成/失败/取消/超时）统一经 settle：先跑全部 disposer 再定案，
    // 物理上杜绝任何一条路径漏清理定时器、socket 或事件监听。
    let settled = false;
    let finishing = false;
    const disposers: Array<() => void> = [];
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      for (const dispose of disposers) {
        try {
          dispose();
        } catch {
          // 清理失败忽略。
        }
      }
      action();
    };

    const timeout = setTimeout(() => settle(() => reject(new Error("websocket 等待超时"))), EXECUTION_TIMEOUT_MS);
    disposers.push(() => clearTimeout(timeout));

    disposers.push(() => {
      try {
        socket.close();
      } catch {
        // Ignore closed sockets.
      }
    });

    const abort = () => settle(() => reject(new Error("任务已取消。")));
    signal.addEventListener("abort", abort, { once: true });
    disposers.push(() => signal.removeEventListener("abort", abort));

    const finish = (knownHistory?: ComfyHistoryItem) => {
      if (settled || finishing) return;
      finishing = true;
      onProgress?.(92);
      void (knownHistory ? Promise.resolve(knownHistory) : fetchHistory(url, promptId, signal))
        .then((history) => settle(() => resolve(history)))
        .catch((error) => settle(() => reject(error instanceof Error ? error : new Error(String(error)))));
    };

    // websocket 可能漏事件；低频轮询 history 作为完成信号的双保险。
    const historyTimer = setInterval(() => {
      void fetchHistory(url, promptId, signal)
        .then((history) => {
          if (history.status?.completed) finish(history);
        })
        .catch((error) => {
          // 执行失败要立刻上抛；其余情况是任务仍在排队/执行、history 尚不存在，继续等。
          if (error instanceof ComfyExecutionError) settle(() => reject(error));
        });
    }, WS_HISTORY_POLL_MS);
    disposers.push(() => clearInterval(historyTimer));

    socket.addEventListener("open", () => onProgress?.(12));
    socket.addEventListener("error", () => settle(() => reject(new Error("websocket 连接失败"))));
    socket.addEventListener("message", (event) => {
      if (settled || typeof event.data !== "string") return;
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
        if (data.node == null) finish();
      } else if (payload.type === "progress_state" && data.nodes) {
        const nextProgress = progressFromState(data.nodes, promptId);
        if (nextProgress != null) onProgress?.(nextProgress);
      } else if (payload.type === "progress" && typeof data.value === "number" && typeof data.max === "number" && data.max > 0) {
        const nodeBase = progressBaseForNode(currentNode);
        const nodeSpan = progressSpanForNode(currentNode);
        onProgress?.(Math.min(90, nodeBase + Math.round((data.value / data.max) * nodeSpan)));
      } else if (payload.type === "execution_error") {
        settle(() =>
          reject(new ComfyExecutionError(data.exception_message || data.exception_type || "ComfyUI 执行失败"))
        );
      } else if (payload.type === "execution_success") {
        finish();
      }
    });
  });
}

async function fetchHistory(url: string, promptId: string, signal: AbortSignal): Promise<ComfyHistoryItem> {
  const response = await fetch(`${url}/history/${promptId}`, { signal });
  if (!response.ok) throw new Error("ComfyUI 历史记录读取失败。");
  const history = (await response.json()) as Record<string, ComfyHistoryItem>;
  const item = history[promptId];
  if (!item) throw new Error("ComfyUI 已完成，但没有找到任务历史记录。");
  assertHistoryHealthy(item);
  return item;
}

async function pollPrompt(
  url: string,
  promptId: string,
  signal: AbortSignal,
  onProgress?: (percent: number) => void
): Promise<ComfyHistoryItem> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < EXECUTION_TIMEOUT_MS) {
    if (signal.aborted) throw new Error("任务已取消。");
    try {
      const item = await fetchHistory(url, promptId, signal);
      if (item?.status?.completed) {
        onProgress?.(92);
        return item;
      }
    } catch (error) {
      // 执行失败立刻上抛；其余情况是 history 尚不存在（仍在排队/执行），继续轮询。
      if (error instanceof ComfyExecutionError) throw error;
    }

    onProgress?.(20);
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error("ComfyUI 执行超时。");
}

function findSavedImage(history: ComfyHistoryItem): { filename: string; subfolder?: string; type?: string } {
  const images = history.outputs?.[NODE.SAVE]?.images;
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
