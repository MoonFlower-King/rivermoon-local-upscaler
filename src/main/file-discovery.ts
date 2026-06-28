import fs from "node:fs/promises";
import path from "node:path";
import { isSupportedImage } from "./image.js";

/** 单次发现的图片数量上限，避免在超大目录树上卡死或撑爆内存。 */
const MAX_FILES = 5000;
/** 递归最大深度，配合不跟随符号链接，进一步防止异常深的目录树。 */
const MAX_DEPTH = 16;

export async function discoverImageFiles(paths: string[]): Promise<string[]> {
  const discovered = new Set<string>();

  for (const item of paths) {
    if (discovered.size >= MAX_FILES) break;
    await collect(item, discovered, 0);
  }

  return Array.from(discovered).sort((a, b) => a.localeCompare(b));
}

async function collect(itemPath: string, discovered: Set<string>, depth: number): Promise<void> {
  if (discovered.size >= MAX_FILES || depth > MAX_DEPTH) return;

  let stat;
  try {
    stat = await fs.lstat(itemPath);
  } catch {
    return;
  }

  // 不跟随符号链接，避免目录循环导致无限递归。
  if (stat.isSymbolicLink()) return;

  if (stat.isFile()) {
    if (isSupportedImage(itemPath)) discovered.add(path.resolve(itemPath));
    return;
  }

  if (!stat.isDirectory()) return;

  let entries;
  try {
    entries = await fs.readdir(itemPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (discovered.size >= MAX_FILES) break;
    // 跳过隐藏/点开头条目（.git、.cache 等），它们通常不含用户图片。
    if (entry.name.startsWith(".")) continue;
    await collect(path.join(itemPath, entry.name), discovered, depth + 1);
  }
}
