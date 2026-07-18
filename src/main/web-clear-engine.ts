import fsp from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import type { ConcreteImageFormat, ImageDimensions } from "./types.js";

export type WebClearOptions = {
  inputPath: string;
  outputPath: string;
  targetDimensions: ImageDimensions;
  format: ConcreteImageFormat;
  signal?: AbortSignal;
};

export async function runWebClearEngine(options: WebClearOptions): Promise<void> {
  if (options.signal?.aborted) throw new Error("任务已取消。");
  await fsp.mkdir(path.dirname(options.outputPath), { recursive: true });

  const metadata = await sharp(options.inputPath).metadata();
  const hasAlpha = Boolean(metadata.hasAlpha);
  let pipeline = sharp(options.inputPath).rotate().resize({
    width: options.targetDimensions.width,
    height: options.targetDimensions.height,
    fit: "inside",
    withoutEnlargement: false,
    kernel: sharp.kernel.lanczos3
  });

  if (!hasAlpha) {
    pipeline = pipeline.modulate({ brightness: 1.01, saturation: 1.06 }).linear(1.035, -4);
  }
  pipeline = pipeline.sharpen({ sigma: 1.15, m1: 1.15, m2: 2.2, x1: 2, y2: 12, y3: 24 });

  if (options.format === "jpg") {
    pipeline = pipeline.jpeg({ quality: 95, mozjpeg: true });
  } else if (options.format === "webp") {
    pipeline = pipeline.webp({ quality: 95, effort: 4 });
  } else {
    pipeline = pipeline.png({ compressionLevel: 8, adaptiveFiltering: true });
  }

  await pipeline.toFile(options.outputPath);
  if (options.signal?.aborted) throw new Error("任务已取消。");
}
