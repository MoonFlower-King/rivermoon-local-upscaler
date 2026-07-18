import { app } from "electron";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { RelayError, classifyRelayError, isTransientRelayError } from "./relay-protocol.js";
import { parseImageContract, parseImagesResponse } from "./image-protocol.js";
import { log } from "../logger.js";
import type { ImageContract, ImageGenParams, ImageOutputFormat } from "../types.js";

/** 单次生图请求总超时：gpt-image 系列高峰期可能要几分钟。 */
const IMAGE_TIMEOUT_MS = 5 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const IMAGE_GATEWAY_BASE_URL = "https://img.rivermoon7.com";
/** 瞬时错误（上游 503 等）的自动重试退避；失败请求不计费，重试无重复扣费风险。 */
const RETRY_DELAYS_MS = [2000, 5000];

/** 生成图片资产目录：userData/assets/images/YYYY-MM/。 */
export function imagesAssetDir(now = new Date()): string {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return path.join(app.getPath("userData"), "assets", "images", month);
}

export async function fetchImageContract(): Promise<ImageContract> {
  try {
    const response = await fetch(`${IMAGE_GATEWAY_BASE_URL}/v1/image/contract`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return parseImageContract(await response.json(), Date.now());
  } catch (error) {
    return {
      ok: false,
      models: [],
      defaultModelId: null,
      contractVersion: null,
      fetchedAt: Date.now(),
      error: error instanceof Error ? `图片能力合同同步失败：${error.message}` : "图片能力合同同步失败。"
    };
  }
}

/**
 * 执行一次生图：提交 → 解析（b64/url 双模式）→ 落盘资产目录。
 * 返回落盘后的绝对路径列表。取消经 signal 打断。
 */
export async function runImageGeneration(params: ImageGenParams, key: string, signal: AbortSignal): Promise<string[]> {
  const payload = await submitWithRetry(params, key, signal);

  const images = parseImagesResponse(payload);
  if (images.length === 0) throw new RelayError("bad-response", "中转站没有返回图片，请稍后重试。");

  const dir = imagesAssetDir();
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const outputs: string[] = [];

  for (const [index, image] of images.entries()) {
    const target = uniquePath(path.join(dir, `${stamp}_${index + 1}${extensionFor(params.outputFormat)}`));
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

/** 提交生图请求；上游瞬时故障（503/限流/网络）自动退避重试，其余错误立即上抛。 */
async function submitWithRetry(params: ImageGenParams, key: string, signal: AbortSignal): Promise<unknown> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await imageGatewayFetch(imageEndpoint(params), key, {
        method: "POST",
        body: await buildImageRequestBody(params),
        signal: AbortSignal.any([signal, AbortSignal.timeout(IMAGE_TIMEOUT_MS)])
      });
      try {
        return await response.json();
      } catch {
        throw new RelayError("bad-response", "图片网关返回了无法解析的响应。");
      }
    } catch (error) {
      const delayMs = RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || signal.aborted || !isTransientRelayError(error)) throw error;
      log(
        `生图上游瞬时错误，${delayMs / 1000}s 后重试（第 ${attempt + 1} 次）：${error instanceof Error ? error.message : String(error)}`
      );
      await abortableDelay(delayMs, signal);
    }
  }
}

function imageEndpoint(params: ImageGenParams): string {
  return params.referencePaths.length > 0 ? "/v1/images/edits" : "/v1/images/generations";
}

async function buildImageRequestBody(params: ImageGenParams): Promise<string | FormData> {
  if (params.referencePaths.length === 0) {
    return JSON.stringify(basePayload(params));
  }

  const body = new FormData();
  const prompt = await promptWithReferenceBinding(params.prompt, params.referencePaths);
  body.append("model", params.model);
  body.append("prompt", prompt);
  body.append("n", String(params.count));
  body.append("size", params.size);
  body.append("quality", params.quality);
  body.append("output_format", params.outputFormat);
  body.append("fit_mode", params.fitMode);
  if (params.sizeMode === "native") body.append("size_mode", "native");
  if (params.referencePaths.length >= 2) {
    body.append("rivermoon_reference_binding", "ordered-v1");
    body.append("rivermoon_reference_aliases", params.referencePaths.map((_, index) => `图${index + 1}`).join("|"));
  }
  for (const referencePath of params.referencePaths) {
    const buffer = await fsp.readFile(referencePath);
    body.append(
      "image",
      new Blob([new Uint8Array(buffer)], { type: mimeFromPath(referencePath) }),
      path.basename(referencePath)
    );
  }
  return body;
}

function basePayload(params: ImageGenParams): Record<string, unknown> {
  return {
    model: params.model,
    prompt: params.prompt,
    n: params.count,
    size: params.size,
    quality: params.quality,
    output_format: params.outputFormat,
    fit_mode: params.fitMode,
    ...(params.sizeMode === "native" ? { size_mode: "native" } : {})
  };
}

async function promptWithReferenceBinding(prompt: string, referencePaths: string[]): Promise<string> {
  if (referencePaths.length < 2 || prompt.includes("REFERENCE_IMAGE_BINDING_V1")) return prompt;
  const lines = referencePaths.map((referencePath, index) => {
    const filename = path.basename(referencePath) || `reference-${index + 1}.png`;
    return `REF_IMAGE_${index + 1}: label=@图${index + 1}; multipart_field=image; multipart_order=${index + 1}; filename=${filename};`;
  });
  return [
    "REFERENCE_IMAGE_BINDING_V1",
    "BEGIN_REFERENCE_MAP",
    ...lines,
    "END_REFERENCE_MAP",
    "请严格按上面的参考图顺序理解 @图1、@图2 等引用，不要调换或合并参考图身份。",
    "BEGIN_USER_TASK",
    prompt,
    "END_USER_TASK"
  ].join("\n");
}

async function imageGatewayFetch(pathname: string, key: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${key}`);
    if (typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    response = await fetch(`${IMAGE_GATEWAY_BASE_URL}${pathname}`, {
      ...init,
      headers
    });
  } catch (error) {
    if (error instanceof DOMException) throw error;
    throw new RelayError("network", "无法连接图片网关，请检查网络。");
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw classifyRelayError(response.status, bodyText);
  }
  return response;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function downloadTo(url: string, target: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(new URL(url, IMAGE_GATEWAY_BASE_URL), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
  });
  if (!response.ok) throw new RelayError("bad-response", `图片下载失败（HTTP ${response.status}）。`);
  const buffer = Buffer.from(await response.arrayBuffer());
  await fsp.writeFile(target, buffer);
}

function extensionFor(format: ImageOutputFormat): string {
  if (format === "jpeg") return ".jpg";
  if (format === "webp") return ".webp";
  return ".png";
}

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function uniquePath(target: string): string {
  if (!fs.existsSync(target)) return target;
  const parsed = path.parse(target);
  for (let index = 2; ; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}_${index}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}
