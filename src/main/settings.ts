import type { ImageFormat, UpscaleSettings } from "./types.js";

export const DEFAULT_SETTINGS: UpscaleSettings = {
  engineMode: "comfyui",
  qualityMode: "standard",
  model: "4x-UltraSharp.pth",
  outputFormat: "png",
  outputDirectory: null,
  maxSide: 4096,
  scale: 4,
  tileMode: "auto",
  gpuId: "auto",
  enhance: false
};

/** 把任意来源（IPC 载荷、磁盘 JSON）的设置规整成合法的 UpscaleSettings。 */
export function sanitizeSettings(input: unknown): UpscaleSettings {
  const settings = (input && typeof input === "object" ? input : {}) as Partial<UpscaleSettings>;
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  const engineMode = "comfyui";
  const qualityMode = "standard";
  const defaultModel = "4x-UltraSharp.pth";
  return {
    engineMode,
    qualityMode,
    model: defaultModel,
    outputFormat: normalizeFormat(merged.outputFormat),
    outputDirectory:
      typeof merged.outputDirectory === "string" && merged.outputDirectory ? merged.outputDirectory : null,
    maxSide: normalizeMaxSide(merged.maxSide),
    scale: merged.scale === 2 || merged.scale === 3 || merged.scale === 4 ? merged.scale : DEFAULT_SETTINGS.scale,
    tileMode: isTileMode(merged.tileMode) ? merged.tileMode : "auto",
    gpuId: typeof merged.gpuId === "string" && merged.gpuId ? merged.gpuId : "auto",
    enhance: false
  };
}

function normalizeFormat(value: unknown): ImageFormat {
  return value === "jpg" || value === "png" || value === "webp" ? value : "png";
}

function isTileMode(value: unknown): value is UpscaleSettings["tileMode"] {
  return value === "auto" || value === "512" || value === "256" || value === "128";
}

/** 最大长边：<=0 视为不限制（返回 0），否则夹到 [256, 16384]。 */
function normalizeMaxSide(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(16384, Math.max(256, Math.round(numeric)));
}
