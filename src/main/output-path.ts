import fsSync from "node:fs";
import path from "node:path";
import { outputExtension } from "./image.js";
import type { ConcreteImageFormat } from "./types.js";

/**
 * 生成任务输出路径；目标已存在时追加 _2/_3… 序号。
 * 避免 a.png 与 a.jpg 同批（或重复处理同一文件）时静默覆盖旧输出。
 * exists 可注入以便单元测试。
 */
export function buildOutputPath(
  inputPath: string,
  outputDirectory: string,
  format: ConcreteImageFormat,
  exists: (candidate: string) => boolean = fsSync.existsSync
): string {
  const parsed = path.parse(inputPath);
  return resolveCollisionFreePath(
    path.join(outputDirectory, `${parsed.name}_upscaled`),
    outputExtension(format),
    exists
  );
}

export function resolveCollisionFreePath(
  basePath: string,
  ext: string,
  exists: (candidate: string) => boolean = fsSync.existsSync
): string {
  let candidate = `${basePath}.${ext}`;
  for (let index = 2; exists(candidate); index += 1) {
    candidate = `${basePath}_${index}.${ext}`;
  }
  return candidate;
}
