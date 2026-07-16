import { DEFAULT_UPSCALE_MODEL, normalizeUpscaleModel } from "./model-registry.js";
import type { ProcessingMode, UpscaleSettings } from "./types.js";

/** 默认模型 = 网站同款 4x-UltraSharp（可在注册表内切换）；固定按 4x 放大。 */
export const DEFAULT_MODEL = DEFAULT_UPSCALE_MODEL;
export const DEFAULT_SCALE = 4;

export const DEFAULT_SETTINGS: UpscaleSettings = {
  // 默认 = 网站同款观感：AI 超分后再过一道网页增强（锐化+微调色）。
  processingMode: "aiUpscaleWebClear",
  outputFormat: "png",
  outputDirectory: null,
  maxSide: 4096,
  upscaleModel: DEFAULT_UPSCALE_MODEL
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
    upscaleModel: normalizeUpscaleModel(merged.upscaleModel)
  };
}

function normalizeProcessingMode(value: unknown): ProcessingMode {
  // 三种模式全部放行：网站按钮的真实链路是「AI 超分 + 网页增强」组合，
  // 纯超分只重建细节不加锐化，观感远弱于网页版。
  if (value === "aiUpscale" || value === "webClear" || value === "aiUpscaleWebClear") return value;
  return DEFAULT_SETTINGS.processingMode;
}

/** 最大长边：<=0 视为不限制（返回 0），否则夹到 [256, 16384]。 */
function normalizeMaxSide(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(16384, Math.max(256, Math.round(numeric)));
}
