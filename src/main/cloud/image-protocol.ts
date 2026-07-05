import type { ImageGenParams, ImageGenTask } from "../types.js";

/** 生图协议纯逻辑：响应解析、参数规整、任务落盘规整。不依赖 electron/网络。 */

export const MAX_SAVED_IMAGE_TASKS = 200;
export const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;

export type GeneratedImage = { b64?: string; url?: string };

/** /v1/images/generations 响应 → 图片列表；同时兼容 b64_json 与 url 两种渠道行为。 */
export function parseImagesResponse(payload: unknown): GeneratedImage[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const images: GeneratedImage[] = [];
  for (const item of data) {
    const record = item as { b64_json?: unknown; url?: unknown } | null;
    const b64 = typeof record?.b64_json === "string" && record.b64_json ? record.b64_json : undefined;
    const url = typeof record?.url === "string" && record.url ? record.url : undefined;
    if (b64 || url) images.push({ b64, url });
  }
  return images;
}

/** 把任意 IPC 载荷规整成合法生图参数；prompt 为空返回 null（拒绝开任务）。 */
export function sanitizeImageParams(input: unknown): ImageGenParams | null {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<ImageGenParams>;
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim().slice(0, 4000) : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!prompt || !model) return null;
  const size =
    typeof raw.size === "string" && /^\d{3,4}x\d{3,4}$/.test(raw.size) ? raw.size : IMAGE_SIZES[0];
  const count =
    typeof raw.count === "number" && Number.isFinite(raw.count) ? Math.min(4, Math.max(1, Math.round(raw.count))) : 1;
  return { model, prompt, size, count };
}

/** 磁盘 JSON → 合法 ImageGenTask；上次退出时仍在跑的任务标记为已中断。 */
export function normalizeImageTask(value: unknown, now: number = Date.now()): ImageGenTask | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<ImageGenTask>;
  if (typeof raw.id !== "string" || !raw.params || typeof raw.params !== "object") return null;
  const params = sanitizeImageParams(raw.params);
  if (!params) return null;
  const status = isImageStatus(raw.status) ? raw.status : "failed";
  const interrupted = status === "running" || status === "queued";
  return {
    id: raw.id,
    params,
    status: interrupted ? "cancelled" : status,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now,
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : null,
    finishedAt: typeof raw.finishedAt === "number" ? raw.finishedAt : interrupted ? now : null,
    durationMs: typeof raw.durationMs === "number" ? Math.max(0, raw.durationMs) : null,
    message: interrupted ? "上次关闭软件时已停止" : typeof raw.message === "string" ? raw.message : "",
    error: typeof raw.error === "string" ? raw.error : null,
    needsTopup: raw.needsTopup === true,
    outputPaths: Array.isArray(raw.outputPaths)
      ? raw.outputPaths.filter((item): item is string => typeof item === "string" && item.length > 0)
      : []
  };
}

function isImageStatus(value: unknown): value is ImageGenTask["status"] {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}
