import { DEFAULT_UPSCALE_MODEL, normalizeUpscaleModel } from "./model-registry.js";
import type { ProcessingMode, UpscaleSettings } from "./types.js";

/** 默认模型 = 网站同款 4x-UltraSharp（可在注册表内切换）；固定按 4x 放大。 */
export const DEFAULT_MODEL = DEFAULT_UPSCALE_MODEL;
export const DEFAULT_SCALE = 4;

export const DEFAULT_SETTINGS: UpscaleSettings = {
  // 网站 AI 按钮的生产 worker 默认直接执行 4x-UltraSharp ComfyUI 工作流。
  processingMode: "aiUpscale",
  outputFormat: "png",
  outputDirectory: null,
  maxSide: 4096,
  upscaleModel: DEFAULT_UPSCALE_MODEL,
  // fast = 用户 2026-05 满意批次里的快速档（medium×1.5，CodexEnhanced_00006 配方）。
  supirTier: "fast"
};

/** 把任意来源（IPC 载荷、磁盘 JSON）的设置规整成合法的 UpscaleSettings。 */
export function sanitizeSettings(input: unknown): UpscaleSettings {
  const settings = (input && typeof input === "object" ? input : {}) as Partial<UpscaleSettings>;
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  return {
    processingMode: normalizeProcessingMode(merged.processingMode),
    outputFormat: "png",
    outputDirectory:
      typeof merged.outputDirectory === "string" && merged.outputDirectory ? merged.outputDirectory : null,
    maxSide: normalizeMaxSide(merged.maxSide),
    upscaleModel: normalizeUpscaleModel(merged.upscaleModel),
    supirTier: merged.supirTier === "quality" ? "quality" : "fast"
  };
}

function normalizeProcessingMode(value: unknown): ProcessingMode {
  // aiRepair = SUPIR 扩散修复链路（需本机 SUPIR 环境，任务启动时校验）；
  // aiAuto = 智能模式：GPT 看图自动分流 SUPIR / Anime6B / 通用 ESRGAN（复刻 CodexSmartEnhance）。
  if (
    value === "aiUpscale" ||
    value === "webClear" ||
    value === "aiUpscaleWebClear" ||
    value === "aiRepair" ||
    value === "aiAuto"
  )
    return value;
  return DEFAULT_SETTINGS.processingMode;
}

/** 最大长边：<=0 视为不限制（返回 0），否则夹到 [256, 16384]。 */
function normalizeMaxSide(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(16384, Math.max(256, Math.round(numeric)));
}
