import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { comfyUpscaleModelsRoot, extraModelPathsConfig, findComfyModel, userModelsRoot } from "./paths.js";
import { log } from "./logger.js";
import type { ModelDownloadState, UpscaleModelStatus } from "./types.js";

/**
 * 超分模型按需下载：安装包不再分发 .pth 权重（非商业授权），
 * 由用户在界面里自主下载。流式下载 + SHA256 校验 + 原子落位；
 * runtime 目录不可写（如装进 Program Files）时回退 userData 并生成
 * extra_model_paths.yaml 挂给 ComfyUI。
 */

export const MODEL_SPEC = {
  fileName: "4x-UltraSharp.pth",
  displayName: "4x-UltraSharp",
  sizeBytes: 66_961_958,
  sha256: "a5812231fc936b42af08a5edba784195495d303d5b3248c24489ef0c4021fe01",
  license: "CC-BY-NC-SA 4.0（仅限非商业用途）",
  urls: [
    "https://hf-mirror.com/lokCX/4x-Ultrasharp/resolve/main/4x-UltraSharp.pth",
    "https://huggingface.co/lokCX/4x-Ultrasharp/resolve/main/4x-UltraSharp.pth"
  ]
} as const;

let state: ModelDownloadState = { phase: "idle", receivedBytes: 0, totalBytes: MODEL_SPEC.sizeBytes, message: null };
let controller: AbortController | null = null;
let notify: ((next: ModelDownloadState) => void) | null = null;

export function onModelDownloadUpdate(callback: (next: ModelDownloadState) => void): void {
  notify = callback;
}

export function getModelStatus(): UpscaleModelStatus {
  const installed = findComfyModel(MODEL_SPEC.fileName);
  return {
    installed: Boolean(installed),
    path: installed,
    fileName: MODEL_SPEC.fileName,
    sizeBytes: MODEL_SPEC.sizeBytes,
    license: MODEL_SPEC.license,
    download: state
  };
}

export function cancelModelDownload(): void {
  controller?.abort();
}

export async function startModelDownload(): Promise<void> {
  if (state.phase === "downloading" || state.phase === "verifying") return;
  controller = new AbortController();
  setState({ phase: "downloading", receivedBytes: 0, totalBytes: MODEL_SPEC.sizeBytes, message: null });

  let targetDir: string;
  try {
    targetDir = await resolveTargetDir();
  } catch (error) {
    setState({ phase: "failed", message: `无法创建模型目录：${error instanceof Error ? error.message : String(error)}` });
    return;
  }

  let lastError = "下载失败";
  for (const url of MODEL_SPEC.urls) {
    try {
      await downloadModelFile(url, targetDir, controller.signal, (receivedBytes, totalBytes) =>
        setState({ receivedBytes, totalBytes })
      );
      setState({ phase: "done", receivedBytes: MODEL_SPEC.sizeBytes, message: null });
      log(`模型下载完成 -> ${path.join(targetDir, MODEL_SPEC.fileName)}`);
      return;
    } catch (error) {
      if (controller.signal.aborted) {
        setState({ phase: "idle", receivedBytes: 0, message: "已取消下载" });
        return;
      }
      lastError = error instanceof Error ? error.message : String(error);
      log(`模型下载失败（${url}）：${lastError}，尝试下一个源`);
    }
  }
  setState({ phase: "failed", message: `${lastError}。请检查网络后重试。` });
}

/**
 * 从单一源流式下载到 targetDir：临时文件累积 + 增量 SHA256 + 校验后原子改名。
 * 独立导出便于端到端测试指定目录。
 */
export async function downloadModelFile(
  url: string,
  targetDir: string,
  signal: AbortSignal,
  onProgress?: (receivedBytes: number, totalBytes: number) => void
): Promise<string> {
  const finalPath = path.join(targetDir, MODEL_SPEC.fileName);
  const tmpPath = `${finalPath}.download`;

  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) throw new Error(`下载失败（HTTP ${response.status}）`);
  const totalBytes = Number(response.headers.get("content-length")) || MODEL_SPEC.sizeBytes;

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
    if (digest !== MODEL_SPEC.sha256) {
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

/** 优先 runtime 模型目录；写探针失败回退 userData 并生成 extra_model_paths.yaml。 */
async function resolveTargetDir(): Promise<string> {
  const primary = comfyUpscaleModelsRoot();
  try {
    await fsp.mkdir(primary, { recursive: true });
    const probe = path.join(primary, ".write-probe");
    await fsp.writeFile(probe, "");
    await fsp.rm(probe, { force: true });
    return primary;
  } catch {
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
    log(`runtime 模型目录不可写，回退 ${fallback}`);
    return fallback;
  }
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
