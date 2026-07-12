import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ConcreteImageFormat, ImageDimensions, ImageFormat } from "./types.js";

const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const WEB_CLEAR_MAX_OUTPUT_PIXELS = 16_777_216;

export function isSupportedImage(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** 生成缩放后的预览图（base64 data URL），用于渲染层前后对比，避免暴露 file:// 路径。
 *  .rotate() 按 EXIF 朝向自动转正，避免手机竖拍图在预览里侧躺。
 *  quality 可调：缩略图用低质量省内存，对比弹窗用高质量保观感。 */
export async function previewDataUrl(filePath: string, maxSide = 1200, quality = 80): Promise<string> {
  const buffer = await sharp(filePath)
    .rotate()
    .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
    .webp({ quality })
    .toBuffer();
  return `data:image/webp;base64,${buffer.toString("base64")}`;
}

export async function readImageDimensions(filePath: string): Promise<ImageDimensions> {
  const metadata = await sharp(filePath).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("无法读取图片尺寸，请确认文件是有效的 PNG、JPEG 或 WebP。");
  }
  // EXIF 朝向 5–8 表示图片被旋转 90°，存储的 width/height 与显示方向相反，需交换，
  // 以与 ComfyUI LoadImage 的自动转正保持一致，保证目标尺寸正确。
  const swap = typeof metadata.orientation === "number" && metadata.orientation >= 5;
  return swap ? { width: metadata.height, height: metadata.width } : { width: metadata.width, height: metadata.height };
}

export function computeTargetDimensions(input: ImageDimensions, maxSide: number, scale: number): ImageDimensions {
  const longest = Math.max(input.width, input.height);
  // 与网页版 compute_target_size 语义一致：
  // maxSide<=0 表示真实倍数放大；否则输出长边统一限制到 maxSide——
  // 原图长边超过 maxSide 时会「缩小」到 maxSide（4x 模型输出经 Lanczos 缩回，
  // 相当于超采样，这正是网页版画面观感更干净锐利的来源之一）。
  const upscale = Number.isFinite(maxSide) && maxSide > 0 ? Math.min(scale, maxSide / longest) : scale;
  return {
    width: Math.max(1, Math.round(input.width * upscale)),
    height: Math.max(1, Math.round(input.height * upscale))
  };
}

export async function readImageHasAlpha(filePath: string): Promise<boolean> {
  const metadata = await sharp(filePath).metadata();
  return Boolean(metadata.hasAlpha);
}

export async function readWorkerImageDimensions(filePath: string): Promise<ImageDimensions | null> {
  const buffer = await fs.readFile(filePath);
  if (
    buffer.length >= 24 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1] ?? 0;
      const length = buffer.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3].includes(marker)) {
        return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) };
      }
      offset += 2 + length;
    }
  }
  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8 " && buffer.length >= 30) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === "VP8L" && buffer.length >= 25) {
      const b0 = buffer[21] ?? 0;
      const b1 = buffer[22] ?? 0;
      const b2 = buffer[23] ?? 0;
      const b3 = buffer[24] ?? 0;
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + ((b3 << 6) | (b2 >> 2) | ((b1 & 0xc0) << 6))
      };
    }
    if (chunk === "VP8X" && buffer.length >= 30) {
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    }
  }
  return null;
}

export async function computeWorkerOutputDimensions(filePath: string, maxSide: number): Promise<ImageDimensions> {
  const normalizedMaxSide = Number.isFinite(maxSide) && maxSide > 0 ? maxSide : 4096;
  const size = await readWorkerImageDimensions(filePath);
  if (!size) return { width: normalizedMaxSide, height: normalizedMaxSide };
  const scale = Math.min(4, normalizedMaxSide / Math.max(size.width, size.height));
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale))
  };
}

/** 复刻网站 image-fast-enhance 的 4k_clear 尺寸策略：长边尽量到 maxSide，但不缩小原图。 */
export function computeWebClearDimensions(input: ImageDimensions, maxSide: number): ImageDimensions {
  const longest = Math.max(input.width, input.height);
  const normalizedMaxSide = Number.isFinite(maxSide) && maxSide > 0 ? maxSide : 4096;
  let scale = normalizedMaxSide / longest;
  scale = Math.min(scale, Math.sqrt(WEB_CLEAR_MAX_OUTPUT_PIXELS / (input.width * input.height)));
  scale = Math.max(1, scale);
  return {
    width: Math.max(1, Math.round(input.width * scale)),
    height: Math.max(1, Math.round(input.height * scale))
  };
}

export function resolveConcreteFormat(format: ImageFormat, hasAlpha: boolean): ConcreteImageFormat {
  if (format === "auto") return hasAlpha ? "png" : "jpg";
  return format;
}

export function outputExtension(format: ConcreteImageFormat): string {
  return format === "jpg" ? "jpg" : format;
}

export async function ensureDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
