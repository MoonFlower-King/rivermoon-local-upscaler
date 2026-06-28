import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ImageDimensions, ImageFormat } from "./types.js";

const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export function isSupportedImage(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
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

export async function ensureDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
