import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ImageDimensions, ImageFormat } from "./types.js";

const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export function isSupportedImage(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export function normalizeOutputFormat(value: string): ImageFormat {
  if (value === "jpg" || value === "png" || value === "webp") return value;
  return "png";
}

/** 生成缩放后的预览图（base64 data URL），用于渲染层前后对比，避免暴露 file:// 路径。 */
export async function previewDataUrl(filePath: string, maxSide = 1200): Promise<string> {
  const buffer = await sharp(filePath)
    .resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80 })
    .toBuffer();
  return `data:image/webp;base64,${buffer.toString("base64")}`;
}

export async function readImageDimensions(filePath: string): Promise<ImageDimensions> {
  const metadata = await sharp(filePath).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("无法读取图片尺寸，请确认文件是有效的 PNG、JPEG 或 WebP。");
  }
  return { width: metadata.width, height: metadata.height };
}

export function computeTargetDimensions(input: ImageDimensions, maxSide: number, scale: number): ImageDimensions {
  const longest = Math.max(input.width, input.height);
  // maxSide<=0 表示不限制，直接按倍数放大；否则把长边限制在 maxSide 内（可选的防超大输出保险）。
  const cap = Number.isFinite(maxSide) && maxSide > 0 ? maxSide / longest : Infinity;
  const upscale = Math.min(scale, cap);
  return {
    width: Math.max(1, Math.round(input.width * upscale)),
    height: Math.max(1, Math.round(input.height * upscale))
  };
}

export function outputExtension(format: ImageFormat): string {
  return format === "jpg" ? "jpg" : format;
}

export function outputFormatForEngine(format: ImageFormat): string {
  return format === "jpg" ? "jpg" : format;
}

export async function ensureDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

/** 网页同款"通透感"增强：饱和/亮度/对比微调 + 强锐化。原地覆盖。 */
export async function applyWebEnhance(filePath: string, format: ImageFormat): Promise<void> {
  let pipeline = sharp(filePath)
    .modulate({ brightness: 1.01, saturation: 1.06 })
    .linear(1.035, -4)
    .sharpen({ sigma: 1.15, m1: 1.15, m2: 2.2, x1: 2, y2: 12, y3: 24 });

  if (format === "jpg") {
    pipeline = pipeline.jpeg({ quality: 95, mozjpeg: true });
  } else if (format === "webp") {
    pipeline = pipeline.webp({ quality: 95 });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9 });
  }

  const tempPath = `${filePath}.enhance-tmp`;
  await pipeline.toFile(tempPath);
  await fs.rename(tempPath, filePath);
}

export async function resizeIfNeeded(
  filePath: string,
  target: ImageDimensions,
  format: ImageFormat
): Promise<void> {
  const dimensions = await readImageDimensions(filePath);
  if (dimensions.width === target.width && dimensions.height === target.height) return;

  let pipeline = sharp(filePath).resize(target.width, target.height, {
    fit: "fill",
    kernel: sharp.kernel.lanczos3
  });

  if (format === "jpg") {
    pipeline = pipeline.jpeg({ quality: 95, mozjpeg: true });
  } else if (format === "webp") {
    pipeline = pipeline.webp({ quality: 95 });
  } else {
    pipeline = pipeline.png({ compressionLevel: 9 });
  }

  const tempPath = `${filePath}.resize-tmp`;
  await pipeline.toFile(tempPath);
  await fs.rename(tempPath, filePath);
}
