import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ImageDimensions, ImageFormat } from "./types.js";

const SUPPORTED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

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
  return swap
    ? { width: metadata.height, height: metadata.width }
    : { width: metadata.width, height: metadata.height };
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

export function outputExtension(format: ImageFormat): string {
  return format === "jpg" ? "jpg" : format;
}

export async function ensureDirectory(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}
