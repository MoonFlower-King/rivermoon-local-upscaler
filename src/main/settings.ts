import type { ImageFormat, UpscaleSettings } from "./types.js";

/** 产品固定常量：网站同款 AI 链路只用 4x-UltraSharp，按 4x 放大。 */
export const DEFAULT_MODEL = "4x-UltraSharp.pth";
export const DEFAULT_SCALE = 4;

export const DEFAULT_SETTINGS: UpscaleSettings = {
  outputFormat: "png",
  outputDirectory: null,
  maxSide: 4096
};

/** 把任意来源（IPC 载荷、磁盘 JSON）的设置规整成合法的 UpscaleSettings。 */
export function sanitizeSettings(input: unknown): UpscaleSettings {
  const settings = (input && typeof input === "object" ? input : {}) as Partial<UpscaleSettings>;
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  return {
    outputFormat: normalizeFormat(merged.outputFormat),
    outputDirectory:
      typeof merged.outputDirectory === "string" && merged.outputDirectory ? merged.outputDirectory : null,
    maxSide: normalizeMaxSide(merged.maxSide)
  };
}

function normalizeFormat(value: unknown): ImageFormat {
  return value === "jpg" || value === "png" || value === "webp" ? value : "png";
}

/** 最大长边：<=0 视为不限制（返回 0），否则夹到 [256, 16384]。 */
function normalizeMaxSide(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(16384, Math.max(256, Math.round(numeric)));
}
