import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findEngine, modelsRoot } from "./paths.js";
import { outputFormatForEngine } from "./image.js";
import { diagnoseEngineFailure } from "./engine-errors.js";
import type { ImageFormat, UpscaleSettings } from "./types.js";

export type EngineRunOptions = {
  inputPath: string;
  outputPath: string;
  settings: UpscaleSettings;
  tileSize: number;
  format: ImageFormat;
  signal: AbortSignal;
  /** 引擎 -v 输出的百分比进度（0–100），用于真实进度反馈。 */
  onProgress?: (percent: number) => void;
};

export async function runEngine(options: EngineRunOptions): Promise<string> {
  const enginePath = findEngine();
  if (!enginePath) {
    throw new Error(
      "缺少超分引擎。请把 realesrgan-ncnn-vulkan.exe 或 upscayl-bin.exe 放到 resources/engines/win32-x64。"
    );
  }

  const modelBase = path.join(modelsRoot(), options.settings.model);
  const paramPath = `${modelBase}.param`;
  const binPath = `${modelBase}.bin`;
  if (!fs.existsSync(paramPath) || !fs.existsSync(binPath)) {
    throw new Error(
      `缺少模型文件 "${options.settings.model}"。请确认 resources/models 里存在 ${path.basename(paramPath)} 和 ${path.basename(binPath)}。`
    );
  }

  const args = [
    "-i",
    options.inputPath,
    "-o",
    options.outputPath,
    "-m",
    modelsRoot(),
    "-n",
    options.settings.model,
    "-s",
    String(options.settings.scale),
    "-t",
    String(options.tileSize),
    "-f",
    outputFormatForEngine(options.format),
    "-v"
  ];

  if (options.settings.gpuId !== "auto") {
    args.push("-g", options.settings.gpuId);
  }

  return new Promise((resolve, reject) => {
    const child = spawn(enginePath, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";
    const append = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output += text;
      if (options.onProgress) {
        const matches = text.match(/(\d+(?:\.\d+)?)%/g);
        const last = matches?.[matches.length - 1];
        if (last) {
          const value = Number.parseFloat(last);
          if (Number.isFinite(value)) options.onProgress(Math.max(0, Math.min(100, value)));
        }
      }
    };

    child.stdout.on("data", append);
    child.stderr.on("data", append);

    const abort = () => {
      child.kill();
      reject(new Error("任务已取消。"));
    };

    if (options.signal.aborted) {
      abort();
      return;
    }

    options.signal.addEventListener("abort", abort, { once: true });

    child.on("error", (error) => {
      options.signal.removeEventListener("abort", abort);
      reject(error);
    });

    child.on("exit", (code) => {
      options.signal.removeEventListener("abort", abort);
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(formatEngineError(code, output)));
      }
    });
  });
}

function formatEngineError(code: number | null, output: string): string {
  const { issue, hints } = diagnoseEngineFailure(code, output);
  const text = output.trim();
  return [issue, ...hints, text ? `引擎输出：${text}` : ""].filter(Boolean).join(" ");
}
