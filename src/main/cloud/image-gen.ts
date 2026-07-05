import { app } from "electron";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { RelayError } from "./relay-protocol.js";
import { relayFetchJson } from "./relay-client.js";
import { parseImagesResponse } from "./image-protocol.js";
import type { ImageGenParams } from "../types.js";

/** 单次生图请求总超时：gpt-image 系列高峰期可能要几分钟。 */
const IMAGE_TIMEOUT_MS = 5 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;

/** 生成图片资产目录：userData/assets/images/YYYY-MM/。 */
export function imagesAssetDir(now = new Date()): string {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return path.join(app.getPath("userData"), "assets", "images", month);
}

/**
 * 执行一次生图：提交 → 解析（b64/url 双模式）→ 落盘资产目录。
 * 返回落盘后的绝对路径列表。取消经 signal 打断。
 */
export async function runImageGeneration(params: ImageGenParams, key: string, signal: AbortSignal): Promise<string[]> {
  const payload = await relayFetchJson<unknown>(
    "/v1/images/generations",
    key,
    {
      method: "POST",
      body: JSON.stringify({ model: params.model, prompt: params.prompt, n: params.count, size: params.size }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)])
    }
  );

  const images = parseImagesResponse(payload);
  if (images.length === 0) throw new RelayError("bad-response", "中转站没有返回图片，请稍后重试。");

  const dir = imagesAssetDir();
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const outputs: string[] = [];

  for (const [index, image] of images.entries()) {
    const target = uniquePath(path.join(dir, `${stamp}_${index + 1}.png`));
    if (image.b64) {
      await fsp.writeFile(target, Buffer.from(image.b64, "base64"));
    } else if (image.url) {
      await downloadTo(image.url, target, signal);
    } else {
      continue;
    }
    outputs.push(target);
  }

  if (outputs.length === 0) throw new RelayError("bad-response", "图片下载失败，请重试。");
  return outputs;
}

async function downloadTo(url: string, target: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]) });
  if (!response.ok) throw new RelayError("bad-response", `图片下载失败（HTTP ${response.status}）。`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fsp.writeFile(target, buffer);
}

function uniquePath(target: string): string {
  if (!fs.existsSync(target)) return target;
  const parsed = path.parse(target);
  for (let index = 2; ; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}_${index}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}
