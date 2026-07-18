import path from "node:path";
import type {
  ImageContract,
  ImageContractModel,
  ImageFitMode,
  ImageGenEndpoint,
  ImageGenParams,
  ImageGenTask,
  ImageOutputFormat,
  ImageQuality,
  ImageSizeMode
} from "../types.js";

/** 生图协议纯逻辑：响应解析、参数规整、任务落盘规整。不依赖 electron/网络。 */

export const MAX_SAVED_IMAGE_TASKS = 200;
export const IMAGE_SIZES = [
  "1024x1024",
  "1536x1024",
  "1024x1536",
  "2048x2048",
  "2048x1152",
  "3840x2160",
  "2160x3840",
  "auto"
] as const;
export const IMAGE_QUALITIES: ImageQuality[] = ["low", "medium", "high", "auto"];
export const IMAGE_OUTPUT_FORMATS: ImageOutputFormat[] = ["png", "jpeg", "webp"];
export const IMAGE_FIT_MODES: ImageFitMode[] = ["contain", "cover"];
export const IMAGE_SIZE_MODES: ImageSizeMode[] = ["postprocess", "native"];
export const DEFAULT_IMAGE_QUALITY: ImageQuality = "high";
export const DEFAULT_IMAGE_OUTPUT_FORMAT: ImageOutputFormat = "png";
export const DEFAULT_IMAGE_FIT_MODE: ImageFitMode = "contain";
export const DEFAULT_IMAGE_SIZE_MODE: ImageSizeMode = "postprocess";
export const DEFAULT_IMAGE_REFERENCE_MAX_BYTES = 20 * 1024 * 1024;

export type GeneratedImage = { b64?: string; url?: string };

export type ImageParamsValidation = {
  ok: boolean;
  error?: string;
  endpoint?: ImageGenEndpoint;
};

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

export function parseImageContract(payload: unknown, fetchedAt: number = Date.now()): ImageContract {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const models = Array.isArray(root.models)
    ? root.models.map(normalizeImageContractModel).filter((model): model is ImageContractModel => Boolean(model))
    : [];
  const visible = models.filter((model) => model.visible);
  const defaultModelId =
    firstString(
      (root.defaults as Record<string, unknown> | undefined)?.primary_model,
      (root.defaults as Record<string, unknown> | undefined)?.primaryModel,
      root.primary_model,
      root.default_model
    ) ||
    visible.find((model) => model.primary)?.publicName ||
    visible[0]?.publicName ||
    models[0]?.publicName ||
    null;
  return {
    ok: models.length > 0,
    models,
    defaultModelId,
    contractVersion: firstString(root.contract_version, root.version),
    fetchedAt,
    error: models.length > 0 ? null : "图片能力合同没有返回可用模型。"
  };
}

/** 把任意 IPC 载荷规整成合法生图参数；prompt 为空返回 null（拒绝开任务）。 */
export function sanitizeImageParams(input: unknown): ImageGenParams | null {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<ImageGenParams>;
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim().slice(0, 4000) : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!prompt || !model) return null;
  const size =
    typeof raw.size === "string" && (/^\d{3,5}x\d{3,5}$/.test(raw.size) || raw.size === "auto")
      ? raw.size
      : IMAGE_SIZES[0];
  const count =
    typeof raw.count === "number" && Number.isFinite(raw.count) ? Math.min(4, Math.max(1, Math.round(raw.count))) : 1;
  const quality = valueFromList(raw.quality, IMAGE_QUALITIES, DEFAULT_IMAGE_QUALITY);
  const outputFormat = normalizeOutputFormat(raw.outputFormat);
  const fitMode = valueFromList(raw.fitMode, IMAGE_FIT_MODES, DEFAULT_IMAGE_FIT_MODE);
  const sizeMode = valueFromList(raw.sizeMode, IMAGE_SIZE_MODES, DEFAULT_IMAGE_SIZE_MODE);
  const referencePaths = Array.isArray(raw.referencePaths)
    ? raw.referencePaths.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 20)
    : [];
  return { model, prompt, size, count, quality, outputFormat, fitMode, sizeMode, referencePaths };
}

export function validateImageParamsAgainstContract(
  params: ImageGenParams,
  contract: ImageContract
): ImageParamsValidation {
  if (!contract.ok) return { ok: false, error: contract.error || "图片能力合同不可用。" };
  const model = contract.models.find(
    (item) => item.visible && (item.publicName === params.model || item.internalName === params.model)
  );
  if (!model) return { ok: false, error: `模型 ${params.model || "-"} 不在当前图片能力配置中。` };
  const endpoint: ImageGenEndpoint = params.referencePaths.length > 0 ? "edit" : "generation";
  if (endpoint === "generation" && !model.endpoints.includes("generation")) {
    return { ok: false, error: `模型 ${model.publicName} 不支持直接生图。` };
  }
  if (endpoint === "edit" && !model.endpoints.includes("edit") && !model.endpoints.includes("reference_edit")) {
    return { ok: false, error: `模型 ${model.publicName} 不支持参考图/编辑。` };
  }
  if (!model.qualities.includes(params.quality))
    return { ok: false, error: `模型 ${model.publicName} 不支持 ${params.quality} 质量。` };
  if (!model.outputFormats.includes(params.outputFormat)) {
    return { ok: false, error: `模型 ${model.publicName} 不支持 ${params.outputFormat} 输出格式。` };
  }
  if (!model.sizeModes.includes(params.sizeMode))
    return { ok: false, error: `模型 ${model.publicName} 不支持当前尺寸模式。` };
  const sizeError = validateImageSizeForModel(model, params.size);
  if (sizeError) return { ok: false, error: sizeError };
  if (params.referencePaths.length > model.maxReferences) {
    return { ok: false, error: `模型 ${model.publicName} 最多支持 ${model.maxReferences} 张参考图。` };
  }
  return { ok: true, endpoint };
}

export function validateImageSourceFileMeta(
  filePath: string,
  size: number,
  maxBytes = DEFAULT_IMAGE_REFERENCE_MAX_BYTES
): string | null {
  const name = path.basename(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) return `参考图只支持 JPG、PNG、WebP 或 GIF：${name}`;
  if (!Number.isFinite(size) || size <= 0) return `参考图为空或不可读取：${name}`;
  if (size > maxBytes) return `参考图大小超过 ${formatMb(maxBytes)}：${name}`;
  return null;
}

export function validateImageSourceFileContent(filePath: string, header: Uint8Array): string | null {
  const name = path.basename(filePath);
  if (header.length < 4) return `参考图文件损坏或为空：${name}`;
  const isPng = header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47;
  const isJpeg = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  const isWebp =
    header[0] === 0x52 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x46 &&
    header[8] === 0x57 &&
    header[9] === 0x45 &&
    header[10] === 0x42 &&
    header[11] === 0x50;
  const isGif = header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46;
  return isPng || isJpeg || isWebp || isGif ? null : `参考图不是可识别的图片文件：${name}`;
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
  const outputPaths = Array.isArray(raw.outputPaths)
    ? raw.outputPaths.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
  const rawSizes = Array.isArray(raw.outputSizes) ? raw.outputSizes : [];
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
    outputPaths,
    outputSizes: outputPaths.map((_, index) => {
      const size = rawSizes[index];
      return typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : 0;
    })
  };
}

function isImageStatus(value: unknown): value is ImageGenTask["status"] {
  return (
    value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled"
  );
}

function normalizeImageContractModel(value: unknown): ImageContractModel | null {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  if (!raw) return null;
  const publicName = firstString(raw.public_name, raw.publicName, raw.id, raw.model);
  if (!publicName) return null;
  const outputFormats = unique(stringArray(raw.output_formats ?? raw.outputFormats).map(normalizeOutputFormat));
  const qualities = unique(
    stringArray(raw.qualities ?? raw.quality_options ?? raw.qualityOptions).map(normalizeQuality)
  );
  const sizeModes = unique(stringArray(raw.size_modes ?? raw.sizeModes).map(normalizeSizeMode));
  const custom =
    raw.custom_size && typeof raw.custom_size === "object" ? (raw.custom_size as Record<string, unknown>) : {};
  const nativeReturn =
    raw.native_return && typeof raw.native_return === "object" ? (raw.native_return as Record<string, unknown>) : {};
  return {
    publicName,
    internalName: firstString(raw.internal_name, raw.internalName) || publicName,
    label: firstString(raw.label, raw.name) || publicName,
    visible: raw.visible !== false,
    primary: raw.primary === true,
    endpoints: unique(
      stringArray(raw.endpoints)
        .map(normalizeEndpoint)
        .filter((item): item is ImageGenEndpoint => Boolean(item))
    ),
    sizes: unique(stringArray(raw.sizes).length ? stringArray(raw.sizes) : Array.from(IMAGE_SIZES)),
    qualities: qualities.length ? qualities : ["auto"],
    outputFormats: outputFormats.length ? outputFormats : ["png"],
    maxReferences: Math.max(0, firstNumber(raw.max_reference_images, raw.maxReferenceImages) ?? 0),
    maxReferenceBytes: Math.max(0, firstNumber(raw.max_reference_image_bytes, raw.maxReferenceImageBytes) ?? 0),
    maxBodyBytes: Math.max(0, firstNumber(raw.max_body_bytes, raw.maxBodyBytes) ?? 0),
    supportsMask: raw.supports_mask === true || raw.supportsMask === true,
    supportsMultipleReferences: raw.supports_multiple_references === true || raw.supportsMultipleReferences === true,
    customSize: {
      enabled: custom.enabled === true,
      minDimension: Math.max(0, firstNumber(custom.min_dimension, custom.minDimension) ?? 0),
      maxDimension: Math.max(0, firstNumber(custom.max_dimension, custom.maxDimension) ?? 0),
      maxPixels: Math.max(0, firstNumber(custom.max_pixels, custom.maxPixels) ?? 0),
      allowedRatios: stringArray(custom.allowed_ratios ?? custom.allowedRatios),
      nativeRatiosOnly: custom.native_ratios_only === true || custom.nativeRatiosOnly === true,
      mode: firstString(custom.mode),
      warning: firstString(custom.warning)
    },
    sizeModes: sizeModes.length
      ? sizeModes
      : nativeReturn.enabled === true
        ? ["postprocess", "native"]
        : ["postprocess"],
    nativeRecommendedSizes: stringArray(nativeReturn.recommended_sizes ?? nativeReturn.recommendedSizes),
    notice: firstString(raw.notice, raw.note)
  };
}

function validateImageSizeForModel(model: ImageContractModel, size: string): string | null {
  const value = size.trim().toLowerCase();
  if (!value || value === "auto") return null;
  if (model.sizes.map((item) => item.toLowerCase()).includes(value)) return null;
  const match = value.match(/^(\d{3,5})x(\d{3,5})$/);
  if (!match || !model.customSize.enabled) return `模型 ${model.publicName} 不支持尺寸 ${value}。`;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const { minDimension, maxDimension, maxPixels, allowedRatios } = model.customSize;
  if (minDimension && (width < minDimension || height < minDimension)) return `自定义尺寸不能小于 ${minDimension}px。`;
  if (maxDimension && (width > maxDimension || height > maxDimension)) return `自定义尺寸不能大于 ${maxDimension}px。`;
  if (maxPixels && width * height > maxPixels) return `自定义尺寸总像素不能超过 ${Math.floor(maxPixels / 10000)} 万。`;
  if (allowedRatios.length > 0 && !ratioAllowed(width, height, allowedRatios)) {
    return `当前只支持 ${allowedRatios.join("、")} 输出比例。`;
  }
  return null;
}

function ratioAllowed(width: number, height: number, ratios: string[]): boolean {
  const actual = width / height;
  return ratios.some((ratio) => {
    const [left, right] = ratio.split(":").map(Number);
    if (!left || !right) return false;
    return Math.abs(actual - left / right) < 0.003;
  });
}

function normalizeEndpoint(value: string): ImageGenEndpoint | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "generation" || normalized === "generations" || normalized === "text_to_image")
    return "generation";
  if (normalized === "edit" || normalized === "edits" || normalized === "image_edit") return "edit";
  if (normalized === "reference_edit" || normalized === "reference" || normalized === "image_reference")
    return "reference_edit";
  return null;
}

function normalizeQuality(value: string): ImageQuality {
  const raw = value.trim().toLowerCase();
  return IMAGE_QUALITIES.includes(raw as ImageQuality) ? (raw as ImageQuality) : "auto";
}

function normalizeOutputFormat(value: unknown): ImageOutputFormat {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "jpg") return "jpeg";
  return IMAGE_OUTPUT_FORMATS.includes(raw as ImageOutputFormat)
    ? (raw as ImageOutputFormat)
    : DEFAULT_IMAGE_OUTPUT_FORMAT;
}

function normalizeSizeMode(value: string): ImageSizeMode {
  const raw = value.trim().toLowerCase();
  return IMAGE_SIZE_MODES.includes(raw as ImageSizeMode) ? (raw as ImageSizeMode) : DEFAULT_IMAGE_SIZE_MODE;
}

function valueFromList<T extends string>(value: unknown, list: T[], fallback: T): T {
  return typeof value === "string" && list.includes(value as T) ? (value as T) : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? "").trim()).filter(Boolean)
    : typeof value === "string" && value.trim()
      ? [value.trim()]
      : [];
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 1 : 2)}MB`;
}
