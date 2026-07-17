import crypto from "node:crypto";
import { app } from "electron";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  comfyUpscaleModelsRoot,
  extraModelPathsConfig,
  findComfyModel,
  supirResources,
  userModelsRoot
} from "./paths.js";
import {
  UPSCALE_MODEL_REGISTRY,
  findModelSpec,
  normalizeUpscaleModel,
  type UpscaleModelSpec
} from "./model-registry.js";
import { loadSettings } from "./settings-store.js";
import { log } from "./logger.js";
import type { ModelDownloadState, UpscaleModelStatus } from "./types.js";

/**
 * 超分模型按需下载：安装包不分发 .pth 权重，由用户在界面里自主下载。
 * 注册表驱动（4x-UltraSharp 非商业 / RealESRGAN 可商用），流式下载 +
 * SHA256 校验 + 原子落位；runtime 目录不可写（如装进 Program Files）时
 * 回退 userData 并生成 extra_model_paths.yaml 挂给 ComfyUI。
 * 同一时刻只允许一个下载任务。
 */

let state: ModelDownloadState = { phase: "idle", fileName: null, receivedBytes: 0, totalBytes: 0, message: null };
let controller: AbortController | null = null;
let notify: ((next: ModelDownloadState) => void) | null = null;

export function onModelDownloadUpdate(callback: (next: ModelDownloadState) => void): void {
  notify = callback;
}

export function getModelStatus(): UpscaleModelStatus {
  const selectedFileName = normalizeUpscaleModel(loadSettings().upscaleModel);
  const models = UPSCALE_MODEL_REGISTRY.map((spec) => {
    const installed = findComfyModel(spec.fileName);
    return {
      fileName: spec.fileName,
      displayName: spec.displayName,
      sizeBytes: spec.sizeBytes,
      license: spec.license,
      commercial: spec.commercial,
      tagline: spec.tagline,
      installed: Boolean(installed),
      path: installed
    };
  });
  return {
    models,
    selectedFileName,
    selectedInstalled: models.some((model) => model.fileName === selectedFileName && model.installed),
    supirAvailable: supirResources().available,
    download: state
  };
}

export function cancelModelDownload(): void {
  controller?.abort();
}

export async function startModelDownload(fileName: unknown): Promise<void> {
  if (state.phase === "downloading" || state.phase === "verifying") return;
  const spec = findModelSpec(typeof fileName === "string" ? fileName : "");
  if (!spec) {
    setState({ phase: "failed", fileName: null, message: "未知的模型，请更新应用后重试。" });
    return;
  }

  controller = new AbortController();
  setState({
    phase: "downloading",
    fileName: spec.fileName,
    receivedBytes: 0,
    totalBytes: spec.sizeBytes,
    message: null
  });

  let targetDir: string;
  try {
    targetDir = await resolveTargetDir();
  } catch (error) {
    setState({
      phase: "failed",
      message: `无法创建模型目录：${error instanceof Error ? error.message : String(error)}`
    });
    return;
  }

  let lastError = "下载失败";
  for (const url of spec.urls) {
    try {
      await downloadModelFile(url, targetDir, spec, controller.signal, (receivedBytes, totalBytes) =>
        setState({ receivedBytes, totalBytes })
      );
      setState({ phase: "done", receivedBytes: spec.sizeBytes, message: null });
      log(`模型下载完成 ${spec.fileName} -> ${targetDir}`);
      return;
    } catch (error) {
      if (controller.signal.aborted) {
        setState({ phase: "idle", receivedBytes: 0, message: "已取消下载" });
        return;
      }
      lastError = error instanceof Error ? error.message : String(error);
      log(`模型下载失败 ${spec.fileName}（${url}）：${lastError}，尝试下一个源`);
    }
  }
  setState({ phase: "failed", message: `${lastError}。请检查网络后重试。` });
}

/**
 * 从单一源流式下载到 targetDir：临时文件累积 + 增量 SHA256 + 校验后原子改名。
 * 独立导出便于端到端测试指定目录与模型。
 */
export async function downloadModelFile(
  url: string,
  targetDir: string,
  spec: UpscaleModelSpec,
  signal: AbortSignal,
  onProgress?: (receivedBytes: number, totalBytes: number) => void
): Promise<string> {
  const finalPath = path.join(targetDir, spec.fileName);
  const tmpPath = `${finalPath}.download`;

  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）`);
  const totalBytes = Number(response.headers.get("content-length")) || spec.sizeBytes;

  const hash = crypto.createHash("sha256");
  const file = fs.createWriteStream(tmpPath);
  let receivedBytes = 0;
  let lastEmit = 0;

  try {
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      hash.update(buffer);
      await new Promise<void>((resolve, reject) => file.write(buffer, (error) => (error ? reject(error) : resolve())));
      receivedBytes += buffer.length;
      if (Date.now() - lastEmit > 300) {
        lastEmit = Date.now();
        onProgress?.(receivedBytes, totalBytes);
      }
    }
    await new Promise<void>((resolve, reject) => file.end((error: unknown) => (error ? reject(error) : resolve())));

    setState({ phase: "verifying", receivedBytes, totalBytes });
    const digest = hash.digest("hex").toLowerCase();
    if (digest !== spec.sha256) {
      throw new Error("SHA256 校验失败：文件不完整或已被篡改");
    }
    await fsp.rename(tmpPath, finalPath);
    return finalPath;
  } catch (error) {
    file.destroy();
    await fsp.rm(tmpPath, { force: true }).catch(() => {
      // 清理失败忽略。
    });
    throw error;
  }
}

/** 打包版优先 userData；开发版优先 runtime。避免 release/win-unpacked 重建时删掉已下载模型。 */
async function resolveTargetDir(): Promise<string> {
  if (app.isPackaged) {
    return prepareUserModelDir();
  }

  const primary = comfyUpscaleModelsRoot();
  try {
    await fsp.mkdir(primary, { recursive: true });
    const probe = path.join(primary, ".write-probe");
    await fsp.writeFile(probe, "");
    await fsp.rm(probe, { force: true });
    return primary;
  } catch {
    const fallback = await prepareUserModelDir();
    log(`runtime 模型目录不可写，回退 ${fallback}`);
    return fallback;
  }
}

async function prepareUserModelDir(): Promise<string> {
  const fallback = userModelsRoot();
  await fsp.mkdir(fallback, { recursive: true });
  // ComfyUI 通过 --extra-model-paths-config 认到 userData 下的模型目录（comfy-engine 启动时携带）。
  const yaml = [
    "rivermoon:",
    `  base_path: ${path.dirname(fallback).replace(/\\/g, "/")}`,
    "  upscale_models: upscale_models",
    ""
  ].join("\n");
  await fsp.writeFile(extraModelPathsConfig(), yaml, "utf8");
  return fallback;
}

function setState(patch: Partial<ModelDownloadState>): void {
  state = { ...state, ...patch };
  notify?.(state);
}

/** 启动时清理上次强退残留的 .download 临时文件（正在下载中的不受影响——此函数只在启动早期调用）。 */
export async function cleanupStaleDownloads(): Promise<void> {
  for (const dir of [comfyUpscaleModelsRoot(), userModelsRoot()]) {
    try {
      const entries = await fsp.readdir(dir);
      for (const entry of entries) {
        if (entry.endsWith(".download")) {
          await fsp.rm(path.join(dir, entry), { force: true });
          log(`已清理残留下载临时文件 ${entry}`);
        }
      }
    } catch {
      // 目录不存在等情况忽略。
    }
  }
}
