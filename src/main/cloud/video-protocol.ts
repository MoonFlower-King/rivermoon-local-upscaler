import path from "node:path";
import type {
  VideoContract,
  VideoContractModel,
  VideoEndpoint,
  VideoGenParams,
  VideoGenTask,
  VideoReferenceType
} from "../types.js";

export const MAX_SAVED_VIDEO_TASKS = 100;
export const VIDEO_SOURCE_MAX_BYTES = 20 * 1024 * 1024;

const FALLBACK_VIDEO_RATIOS = ["16:9", "9:16", "1:1"];
const FALLBACK_VIDEO_DURATIONS = [5, 10];
const FALLBACK_VIDEO_RESOLUTIONS = ["720p", "1080p"];
const DEFAULT_VIDEO_RATIO = "16:9";
const DEFAULT_VIDEO_DURATION = 5;
const DEFAULT_VIDEO_RESOLUTION = "720p";
const DEFAULT_REFERENCE_TYPE: VideoReferenceType = "ordinary";
const VIDEO_SOURCE_ALLOWED_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const VIDEO_REFERENCE_TYPES = new Set<VideoReferenceType>([
  "ordinary",
  "reference",
  "first_frame",
  "last_frame",
  "character",
  "style"
]);

export type RemoteVideoJob = {
  jobId: string;
  requestId: string | null;
  clientRequestId: string | null;
  status: VideoGenTask["status"];
  progress: number | null;
  model: string | null;
  prompt: string | null;
  endpoint: VideoEndpoint;
  aspectRatio: string | null;
  duration: number | null;
  resolution: string | null;
  dryRun: boolean;
  contentUrl: string | null;
  downloadUrl: string | null;
  outputUrl: string | null;
  errorMessage: string | null;
  message: string | null;
  costUsd: number | null;
  estimatedCostUsd: number | null;
  charged: boolean | null;
  refunded: boolean | null;
};

export function parseVideoContract(
  payload: unknown,
  fetchedAt = Date.now(),
  source: VideoContract["source"] = "https"
): VideoContract {
  const root = asRecord(payload);
  const defaults = asRecord(root?.defaults);
  const defaultModelId = firstString(defaults?.primary_model, defaults?.default_model, defaults?.model);
  const contractReferenceTypes = referenceTypeArray(root?.reference_types ?? root?.supported_reference_types);
  const rawModels = collectModels(payload);
  const models = rawModels
    .map((model) => normalizeContractModel(model, defaultModelId, contractReferenceTypes))
    .filter((model): model is VideoContractModel => Boolean(model));
  return {
    ok: models.some((model) => model.enabled),
    models,
    defaultModelId,
    fetchedAt,
    error: models.length > 0 ? null : "视频合同没有返回可用模型。",
    fromCache: false,
    source
  };
}

export function failedVideoContract(error: unknown, fetchedAt = Date.now()): VideoContract {
  return {
    ok: false,
    models: [],
    defaultModelId: null,
    fetchedAt,
    error: error instanceof Error ? error.message : String(error),
    fromCache: false,
    source: "unknown"
  };
}

export function normalizeVideoContractCacheValue(value: unknown): VideoContract | null {
  const parsed = asRecord(value);
  if (!parsed || parsed.ok !== true || !Array.isArray(parsed.models) || typeof parsed.fetchedAt !== "number") {
    return null;
  }
  const defaultModelId = typeof parsed.defaultModelId === "string" ? parsed.defaultModelId : null;
  const models = parsed.models
    .map((model) => normalizeCachedContractModel(model, defaultModelId))
    .filter((model): model is VideoContractModel => Boolean(model));
  if (!models.some((model) => model.enabled)) return null;
  return {
    ok: true,
    models,
    defaultModelId,
    fetchedAt: parsed.fetchedAt,
    error: null,
    fromCache: true,
    source: "cache"
  };
}

export function sanitizeVideoParams(input: unknown): VideoGenParams | null {
  const raw = (input && typeof input === "object" ? input : {}) as Partial<VideoGenParams>;
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim().slice(0, 8000) : "";
  if (!model || !prompt) return null;
  const endpoint = normalizeEndpoint(raw.endpoint);
  const referencePaths = Array.isArray(raw.referencePaths)
    ? raw.referencePaths.filter((item): item is string => typeof item === "string" && item.length > 0).slice(0, 8)
    : [];
  const referenceType = normalizeReferenceType(raw.referenceType);
  return {
    model,
    prompt,
    endpoint,
    requestEndpoint: normalizeRequestEndpoint(raw.requestEndpoint, endpoint),
    aspectRatio:
      typeof raw.aspectRatio === "string" && /^[0-9]{1,2}:[0-9]{1,2}$/.test(raw.aspectRatio)
        ? raw.aspectRatio
        : DEFAULT_VIDEO_RATIO,
    duration:
      typeof raw.duration === "number" && Number.isFinite(raw.duration)
        ? Math.min(60, Math.max(1, Math.round(raw.duration)))
        : DEFAULT_VIDEO_DURATION,
    resolution:
      typeof raw.resolution === "string" && raw.resolution.trim() ? raw.resolution.trim() : DEFAULT_VIDEO_RESOLUTION,
    referencePaths,
    referenceType,
    referenceTypes: resolveVideoReferenceTypes(endpoint, referencePaths, referenceType, raw.referenceTypes)
  };
}

export type VideoParamsContractValidation =
  { ok: true; estimatedCostUsd: number | null; requestEndpoint: string } | { ok: false; error: string };

export function validateVideoParamsAgainstContract(
  params: VideoGenParams,
  contract: VideoContract
): VideoParamsContractValidation {
  if (!contract.ok) return { ok: false, error: contract.error || "视频合同暂不可用，请稍后重试。" };
  if (contract.fromCache) {
    return { ok: false, error: contract.error || "当前视频合同来自缓存，请先同步最新合同后再提交。" };
  }
  if (contract.source !== "https") {
    return { ok: false, error: "提交视频任务必须使用 HTTPS 实时合同，请同步视频合同后重试。" };
  }
  const model = contract.models.find((item) => item.id === params.model && item.enabled);
  if (!model) return { ok: false, error: "当前视频模型不可用，请同步视频合同后重试。" };
  if (!model.endpoints.includes(params.endpoint)) {
    return { ok: false, error: `当前模型不支持 ${endpointLabel(params.endpoint)}。` };
  }
  if (!model.aspectRatios.includes(params.aspectRatio)) {
    return { ok: false, error: `当前模型不支持 ${params.aspectRatio} 比例。` };
  }
  if (!model.durations.includes(params.duration)) {
    return { ok: false, error: `当前模型不支持 ${params.duration} 秒视频。` };
  }
  if (!model.resolutions.includes(params.resolution)) {
    return { ok: false, error: `当前模型不支持 ${params.resolution} 清晰度。` };
  }
  const referenceLimit = videoReferenceLimit(params.endpoint, model.maxReferences);
  const minReferences = minimumVideoReferenceCount(params.endpoint);
  if (params.endpoint === "text_to_video" && params.referencePaths.length > 0) {
    return { ok: false, error: "文生视频不能携带参考图。" };
  }
  if (referenceLimit < minReferences) {
    return { ok: false, error: `当前模型${endpointLabel(params.endpoint)}参考图上限不足，请同步视频合同或切换模型。` };
  }
  if (params.referencePaths.length < minReferences) {
    if (params.endpoint === "first_last_frame") return { ok: false, error: "首尾帧模式需要首帧和尾帧 2 张参考图。" };
    return { ok: false, error: "当前视频模式需要至少 1 张参考图。" };
  }
  if (params.referencePaths.length > referenceLimit) {
    return { ok: false, error: `参考图数量超过当前模型上限（${referenceLimit} 张）。` };
  }
  if (params.referenceTypes.length !== params.referencePaths.length) {
    return { ok: false, error: "参考图类型数量和参考图不一致。" };
  }
  if (
    params.endpoint === "first_last_frame" &&
    (params.referenceTypes[0] !== "first_frame" || params.referenceTypes[1] !== "last_frame")
  ) {
    return { ok: false, error: "首尾帧模式第 1 张必须是首帧，第 2 张必须是尾帧。" };
  }
  for (const referenceType of params.referenceTypes) {
    if (!model.referenceTypes.includes(referenceType)) {
      return { ok: false, error: `当前模型不支持${referenceTypeLabel(referenceType)}参考图。` };
    }
  }
  return {
    ok: true,
    estimatedCostUsd: model.estimatedPriceUsd,
    requestEndpoint: model.requestEndpoints?.[params.endpoint] ?? params.endpoint
  };
}

export function minimumVideoReferenceCount(endpoint: VideoEndpoint): number {
  if (endpoint === "text_to_video") return 0;
  if (endpoint === "first_last_frame") return 2;
  return 1;
}

export function videoReferenceLimit(endpoint: VideoEndpoint, modelMaxReferences: number): number {
  if (endpoint === "text_to_video") return 0;
  const minimum = minimumVideoReferenceCount(endpoint);
  return modelMaxReferences > 0 ? modelMaxReferences : minimum;
}

export function resolveVideoReferenceTypes(
  endpoint: VideoEndpoint,
  referencePaths: string[],
  referenceType: VideoReferenceType = DEFAULT_REFERENCE_TYPE,
  referenceTypes?: unknown
): VideoReferenceType[] {
  if (endpoint === "text_to_video" || referencePaths.length === 0) return [];
  const normalizedInput = Array.isArray(referenceTypes) ? referenceTypes.map(normalizeReferenceType) : [];
  if (endpoint === "first_last_frame") {
    return referencePaths.map((_, index) => {
      if (index === 0) return "first_frame";
      if (index === 1) return "last_frame";
      return normalizedInput[index] ?? "reference";
    });
  }
  return referencePaths.map((_, index) => normalizedInput[index] ?? referenceType);
}

export function validateVideoSourceFileMeta(filePath: string, byteLength: number): string | null {
  const name = path.basename(filePath) || "参考图";
  if (!VIDEO_SOURCE_ALLOWED_EXTENSIONS.has(path.extname(filePath).toLowerCase())) {
    return `参考图只支持 JPG、PNG、WebP 或 GIF：${name}`;
  }
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    return `参考图为空：${name}`;
  }
  if (byteLength > VIDEO_SOURCE_MAX_BYTES) {
    return `参考图不能超过 20MB：${name}`;
  }
  return null;
}

export function validateVideoSourceFileContent(filePath: string, bytes: Uint8Array): string | null {
  const metaError = validateVideoSourceFileMeta(filePath, bytes.byteLength);
  if (metaError) return metaError;
  const name = path.basename(filePath) || "参考图";
  if (!hasExpectedVideoSourceImageHeader(filePath, bytes)) {
    return `参考图内容不是有效图片：${name}`;
  }
  return null;
}

function hasExpectedVideoSourceImageHeader(filePath: string, bytes: Uint8Array): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (ext === ".png") {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  if (ext === ".webp") {
    return (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  }
  if (ext === ".gif") {
    return (
      bytes.length >= 6 &&
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) &&
      bytes[5] === 0x61
    );
  }
  return false;
}

export type VideoJobSourceRef = {
  sourceId: string | null;
  sourceUrl: string | null;
};

export function parseUploadedVideoSource(payload: unknown): VideoJobSourceRef {
  const root = asRecord(payload) ?? {};
  const rawResponse = asRecord(parseMaybeJson(root.raw_response_json));
  const records = [
    root,
    asRecord(root.data),
    asRecord(root.source),
    asRecord(root.asset),
    asRecord(root.file),
    asRecord(root.result),
    rawResponse,
    asRecord(rawResponse?.data),
    asRecord(rawResponse?.source),
    asRecord(rawResponse?.asset),
    asRecord(rawResponse?.file),
    asRecord(rawResponse?.result)
  ];
  return {
    sourceId: firstStringFromRecords(
      records,
      "source_id",
      "sourceId",
      "cache_id",
      "cacheId",
      "asset_id",
      "assetId",
      "id"
    ),
    sourceUrl: firstStringFromRecords(
      records,
      "source_url",
      "sourceUrl",
      "asset_url",
      "assetUrl",
      "file_url",
      "fileUrl",
      "url"
    )
  };
}

export function buildVideoJobRequestPayload(
  params: VideoGenParams,
  sources: VideoJobSourceRef[],
  clientRequestId: string
): Record<string, unknown> {
  const { sourceIds, sourceUrls } = orderedVideoSourceLists(sources);
  const requestEndpoint = normalizeRequestEndpoint(params.requestEndpoint, params.endpoint);
  return {
    model: params.model,
    prompt: params.prompt,
    endpoint: requestEndpoint,
    mode: requestEndpoint,
    aspect_ratio: params.aspectRatio,
    duration: params.duration,
    resolution: params.resolution,
    quality: params.resolution,
    reference_type: params.referenceTypes[0] ?? params.referenceType,
    source_ids: sourceIds,
    source_urls: sourceUrls,
    reference_types: Object.fromEntries(
      sources.map((_, index) => [String(index + 1), params.referenceTypes[index] ?? params.referenceType])
    ),
    dry_run: false,
    client_request_id: clientRequestId
  };
}

function orderedVideoSourceLists(sources: VideoJobSourceRef[]): { sourceIds: string[]; sourceUrls: string[] } {
  if (sources.length === 0) return { sourceIds: [], sourceUrls: [] };
  const sourceIds = sources.map((source) => source.sourceId);
  if (sourceIds.every(Boolean)) return { sourceIds: sourceIds as string[], sourceUrls: [] };
  const sourceUrls = sources.map((source) => source.sourceUrl);
  if (sourceUrls.every(Boolean)) return { sourceIds: [], sourceUrls: sourceUrls as string[] };
  throw new Error("视频参考图缓存返回不完整，无法保持参考图顺序，请稍后重试。");
}

export function parseVideoJobResponse(payload: unknown, fallback?: Partial<RemoteVideoJob>): RemoteVideoJob {
  const root = asRecord(payload) ?? {};
  const rootData = asRecord(root.data);
  const rootResult = asRecord(root.result);
  const rootOutput = asRecord(root.output);
  const rootJob = asRecord(root.job);
  const raw =
    rootJob ??
    asRecord(rootData?.job) ??
    asRecord(rootData?.task) ??
    asRecord(rootResult?.job) ??
    asRecord(rootResult?.task) ??
    asRecord(rootOutput?.job) ??
    asRecord(rootOutput?.task) ??
    rootData ??
    rootResult ??
    rootOutput ??
    root;
  const nestedResponse = parseMaybeJson(
    firstValue(
      raw.raw_response_json,
      root.raw_response_json,
      rootData?.raw_response_json,
      rootResult?.raw_response_json,
      rootOutput?.raw_response_json
    )
  );
  const rawResponse = asRecord(nestedResponse);
  const rawData = asRecord(raw.data);
  const rawOutput = asRecord(raw.output);
  const rawResult = asRecord(raw.result);
  const rawResponseData = asRecord(rawResponse?.data);
  const rawResponseOutput = asRecord(rawResponse?.output);
  const rawResponseResult = asRecord(rawResponse?.result);
  const rawResponseJob = asRecord(rawResponse?.job);
  const rawResponseDataJob = asRecord(rawResponseData?.job);
  const rawResponseResultJob = asRecord(rawResponseResult?.job);
  const rawResponseOutputJob = asRecord(rawResponseOutput?.job);
  const rawResponseJobData = asRecord(rawResponseJob?.data);
  const rawResponseJobResult = asRecord(rawResponseJob?.result);
  const rawResponseJobOutput = asRecord(rawResponseJob?.output);
  const records = uniqueRecords([
    raw,
    rawData,
    rawResult,
    rawOutput,
    rootJob,
    rootData,
    rootResult,
    rootOutput,
    root,
    rawResponseJob,
    rawResponseDataJob,
    rawResponseResultJob,
    rawResponseOutputJob,
    rawResponseJobData,
    rawResponseJobResult,
    rawResponseJobOutput,
    rawResponse,
    rawResponseData,
    rawResponseResult,
    rawResponseOutput
  ]);
  const status = normalizeRemoteStatus(firstStringFromRecords(records, "status", "state") ?? fallback?.status);
  return {
    jobId: firstString(firstStringFromRecords(records, "job_id", "jobId", "id"), fallback?.jobId) ?? "",
    requestId: firstString(firstStringFromRecords(records, "request_id", "requestId"), fallback?.requestId),
    clientRequestId: firstString(
      firstStringFromRecords(records, "client_request_id", "clientRequestId"),
      fallback?.clientRequestId
    ),
    status,
    progress: parseProgressFromRecords(records),
    model: firstString(firstStringFromRecords(records, "model"), fallback?.model),
    prompt: firstString(firstStringFromRecords(records, "prompt", "input_prompt", "text_prompt"), fallback?.prompt),
    endpoint: normalizeEndpoint(firstStringFromRecords(records, "endpoint", "mode", "type") ?? fallback?.endpoint),
    aspectRatio: firstString(
      firstStringFromRecords(records, "aspect_ratio", "aspectRatio", "ratio"),
      fallback?.aspectRatio
    ),
    duration: firstNumber(firstValueFromRecords(records, "duration", "duration_seconds"), fallback?.duration),
    resolution: firstString(firstStringFromRecords(records, "resolution", "quality"), fallback?.resolution),
    dryRun: boolValue(firstValueFromRecords(records, "dry_run", "dryRun"), fallback?.dryRun) === true,
    contentUrl: firstString(firstStringFromRecords(records, "content_url", "contentUrl"), fallback?.contentUrl),
    downloadUrl: firstString(firstStringFromRecords(records, "download_url", "downloadUrl"), fallback?.downloadUrl),
    outputUrl: firstString(
      firstStringFromRecords(records, "output_url", "outputUrl", "video_url", "videoUrl", "file_url", "fileUrl", "url"),
      fallback?.outputUrl
    ),
    errorMessage: firstString(
      firstStringFromRecords(records, "error_message", "errorMessage", "error"),
      firstStringFromRecords(records, "message"),
      fallback?.errorMessage
    ),
    message: firstString(root.message, firstStringFromRecords(records, "message", "status_message"), fallback?.message),
    costUsd: positiveNumber(
      ...valuesFromRecords(
        records,
        "cost_usd",
        "actual_cost_usd",
        "charged_usd",
        "charge_usd",
        "usage_usd",
        "costUsd",
        "actualCostUsd",
        "chargedUsd"
      ),
      ...valuesFromRecords(
        records.map((record) => asRecord(record.usage)),
        "total_usd",
        "totalUsd"
      )
    ),
    estimatedCostUsd: positiveNumber(
      ...valuesFromRecords(
        records,
        "estimated_cost_usd",
        "estimated_price_usd",
        "estimatedCostUsd",
        "estimatedPriceUsd"
      )
    ),
    charged: boolValue(...valuesFromRecords(records, "charged", "is_charged", "billed"), fallback?.charged),
    refunded: boolValue(...valuesFromRecords(records, "refunded", "is_refunded"), fallback?.refunded)
  };
}

export function parseVideoJobsList(payload: unknown): RemoteVideoJob[] {
  const root = asRecord(payload);
  const rootData = asRecord(root?.data);
  const rootResult = asRecord(root?.result);
  const rawResponse = asRecord(parseMaybeJson(root?.raw_response_json));
  const rawResponseData = asRecord(rawResponse?.data);
  const rawResponseResult = asRecord(rawResponse?.result);
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.jobs)
      ? root.jobs
      : Array.isArray(root?.data)
        ? root.data
        : (firstArrayFromRecords(
            [rootData, rootResult, rawResponse, rawResponseData, rawResponseResult, root],
            "jobs",
            "items",
            "results",
            "tasks",
            "list"
          ) ?? []);
  return list.map((item) => parseVideoJobResponse(item)).filter((job) => job.jobId.length > 0);
}

export function normalizeVideoTask(value: unknown, now: number = Date.now()): VideoGenTask | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<VideoGenTask>;
  if (typeof raw.id !== "string") return null;
  const params = sanitizeVideoParams(raw.params);
  if (!params) return null;
  const status = isVideoStatus(raw.status) ? raw.status : "failed";
  const remoteJobId = typeof raw.remoteJobId === "string" && raw.remoteJobId.length > 0 ? raw.remoteJobId : null;
  const recoverable =
    (status === "running" || status === "queued") && remoteJobId !== null && typeof raw.outputPath !== "string";
  const interrupted = !recoverable && (status === "running" || status === "queued");
  return {
    id: raw.id,
    params,
    status: recoverable ? "queued" : interrupted ? "cancelled" : status,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now,
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : null,
    finishedAt: recoverable ? null : typeof raw.finishedAt === "number" ? raw.finishedAt : interrupted ? now : null,
    durationMs: recoverable ? null : typeof raw.durationMs === "number" ? Math.max(0, raw.durationMs) : null,
    message: recoverable
      ? "等待恢复远端视频任务"
      : interrupted
        ? "上次关闭软件时已停止"
        : typeof raw.message === "string"
          ? raw.message
          : "",
    error: typeof raw.error === "string" ? raw.error : null,
    needsTopup: raw.needsTopup === true,
    progress:
      typeof raw.progress === "number" && Number.isFinite(raw.progress)
        ? Math.max(0, Math.min(100, raw.progress))
        : null,
    remoteJobId,
    requestId: typeof raw.requestId === "string" ? raw.requestId : null,
    clientRequestId:
      typeof raw.clientRequestId === "string" && raw.clientRequestId.length > 0 ? raw.clientRequestId : null,
    dryRun: raw.dryRun === true,
    outputPath: typeof raw.outputPath === "string" ? raw.outputPath : null,
    outputBytes:
      typeof raw.outputBytes === "number" && Number.isFinite(raw.outputBytes) && raw.outputBytes >= 0
        ? raw.outputBytes
        : null,
    contentUrl: typeof raw.contentUrl === "string" ? raw.contentUrl : null,
    downloadUrl: typeof raw.downloadUrl === "string" ? raw.downloadUrl : null,
    costUsd: typeof raw.costUsd === "number" && Number.isFinite(raw.costUsd) && raw.costUsd >= 0 ? raw.costUsd : null,
    estimatedCostUsd:
      typeof raw.estimatedCostUsd === "number" && Number.isFinite(raw.estimatedCostUsd) && raw.estimatedCostUsd >= 0
        ? raw.estimatedCostUsd
        : null,
    charged: raw.charged === true,
    refunded: raw.refunded === true
  };
}

export function isVideoTerminalStatus(status: VideoGenTask["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "expired";
}

function collectModels(payload: unknown): Array<Record<string, unknown>> {
  const root = asRecord(payload);
  if (!root) return [];
  if (Array.isArray(root.models)) return root.models.filter(isRecord);
  if (Array.isArray(root.data)) return root.data.filter(isRecord);
  if (Array.isArray(root.video_models)) return root.video_models.filter(isRecord);
  if (isRecord(root.families)) {
    return Object.entries(root.families).flatMap(([family, value]) => {
      const familyRecord = asRecord(value);
      const list = Array.isArray(value) ? value : Array.isArray(familyRecord?.models) ? familyRecord.models : [];
      return list
        .filter(isRecord)
        .map((model) => ({ ...model, family: typeof model.family === "string" ? model.family : family }));
    });
  }
  return [];
}

function normalizeContractModel(
  raw: Record<string, unknown>,
  defaultModelId: string | null,
  contractReferenceTypes: VideoReferenceType[]
): VideoContractModel | null {
  const id = firstString(raw.model, raw.public_name, raw.internal_name, raw.id, raw.name);
  if (!id) return null;
  const rawEndpoints = stringArray(raw.endpoints ?? raw.modes ?? raw.capabilities);
  const endpoints = rawEndpoints
    .filter((endpoint) => normalizeKnownEndpoint(endpoint) !== null)
    .map((endpoint) => normalizeEndpoint(endpoint));
  const requestEndpoints = normalizeRequestEndpoints(rawEndpoints);
  const aspectRatios = stringArray(raw.aspect_ratios ?? raw.ratios ?? raw.supported_aspect_ratios ?? raw.sizes);
  const durations = numberArray(
    raw.durations ?? raw.duration_options ?? raw.supported_durations ?? raw.video_durations
  );
  const resolutions = stringArray(raw.resolutions ?? raw.qualities ?? raw.quality_options);
  const referenceTypes = referenceTypeArray(raw.reference_types ?? raw.supported_reference_types);
  const visible = raw.visible !== false;
  const enabled = visible && raw.enabled !== false && raw.status !== "disabled" && endpoints.length > 0;
  const primary = raw.primary === true || (defaultModelId !== null && id === defaultModelId);
  const defaultAspectRatio = firstString(raw.default_aspect_ratio, raw.defaultAspectRatio);
  const defaultDuration = firstNumber(raw.default_duration, raw.defaultDuration);
  const defaultResolution = firstString(raw.default_resolution, raw.defaultResolution);
  return {
    id,
    label: firstString(raw.label, raw.display_name, raw.public_name, raw.model) ?? id,
    family: firstString(raw.family) ?? inferFamily(id),
    enabled,
    endpoints: unique(endpoints),
    aspectRatios: unique(aspectRatios.length ? aspectRatios : FALLBACK_VIDEO_RATIOS),
    durations: uniqueNumbers(durations.length ? durations : FALLBACK_VIDEO_DURATIONS),
    resolutions: unique(resolutions.length ? resolutions : FALLBACK_VIDEO_RESOLUTIONS),
    maxReferences:
      firstNumber(raw.max_reference_images, raw.max_reference_assets, raw.maxReferences, raw.reference_count) ?? 0,
    referenceTypes: unique(
      referenceTypes.length
        ? referenceTypes
        : contractReferenceTypes.length
          ? contractReferenceTypes
          : Array.from(VIDEO_REFERENCE_TYPES)
    ),
    requestEndpoints,
    primary,
    defaultAspectRatio,
    defaultDuration,
    defaultResolution,
    estimatedPriceUsd: positiveNumber(
      raw.estimated_price_usd,
      raw.estimatedPriceUsd,
      raw.price_usd,
      raw.priceUsd,
      raw.unit_price_usd,
      raw.cost_usd
    ),
    notice: firstString(raw.disabled_reason, raw.notice) ?? null
  };
}

function normalizeCachedContractModel(value: unknown, defaultModelId: string | null): VideoContractModel | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const id = firstString(raw.id, raw.model, raw.public_name, raw.internal_name, raw.name);
  if (!id) return null;
  const rawEndpoints = stringArray(raw.endpoints);
  const endpoints = rawEndpoints
    .filter((endpoint) => normalizeKnownEndpoint(endpoint) !== null)
    .map((endpoint) => normalizeEndpoint(endpoint));
  const requestEndpoints = normalizeCachedRequestEndpoints(rawEndpoints, asRecord(raw.requestEndpoints));
  const referenceTypes = referenceTypeArray(raw.referenceTypes ?? raw.reference_types ?? raw.supported_reference_types);
  const aspectRatios = unique(stringArray(raw.aspectRatios ?? raw.aspect_ratios ?? raw.ratios ?? raw.sizes));
  const durations = uniqueNumbers(numberArray(raw.durations ?? raw.duration_options ?? raw.video_durations));
  const resolutions = unique(stringArray(raw.resolutions ?? raw.qualities ?? raw.quality_options));
  return {
    id,
    label: firstString(raw.label, raw.display_name, raw.public_name, raw.model) ?? id,
    family: firstString(raw.family) ?? inferFamily(id),
    enabled: raw.enabled === true && endpoints.length > 0,
    endpoints: unique(endpoints),
    aspectRatios: aspectRatios.length ? aspectRatios : FALLBACK_VIDEO_RATIOS,
    durations: durations.length ? durations : FALLBACK_VIDEO_DURATIONS,
    resolutions: resolutions.length ? resolutions : FALLBACK_VIDEO_RESOLUTIONS,
    maxReferences:
      firstNumber(raw.maxReferences, raw.max_reference_images, raw.max_reference_assets, raw.reference_count) ?? 0,
    referenceTypes: unique(referenceTypes.length ? referenceTypes : Array.from(VIDEO_REFERENCE_TYPES)),
    requestEndpoints,
    primary: raw.primary === true || (defaultModelId !== null && id === defaultModelId),
    defaultAspectRatio: firstString(raw.defaultAspectRatio, raw.default_aspect_ratio),
    defaultDuration: firstNumber(raw.defaultDuration, raw.default_duration),
    defaultResolution: firstString(raw.defaultResolution, raw.default_resolution),
    estimatedPriceUsd: positiveNumber(
      raw.estimatedPriceUsd,
      raw.estimated_price_usd,
      raw.priceUsd,
      raw.price_usd,
      raw.unit_price_usd,
      raw.cost_usd
    ),
    notice: firstString(raw.notice, raw.disabled_reason) ?? null
  };
}

function normalizeCachedRequestEndpoints(
  rawEndpoints: string[],
  rawRequestEndpoints: Record<string, unknown> | null
): Partial<Record<VideoEndpoint, string>> {
  const result: Partial<Record<VideoEndpoint, string>> = {};
  if (rawRequestEndpoints) {
    for (const [key, value] of Object.entries(rawRequestEndpoints)) {
      const endpoint = normalizeKnownEndpoint(key);
      const requestEndpoint = typeof value === "string" ? value.trim() : "";
      if (endpoint && requestEndpoint && normalizeKnownEndpoint(requestEndpoint) === endpoint) {
        result[endpoint] = requestEndpoint;
      }
    }
  }
  for (const rawEndpoint of rawEndpoints) {
    const requestEndpoint = rawEndpoint.trim();
    const endpoint = normalizeKnownEndpoint(requestEndpoint);
    if (endpoint && requestEndpoint && !result[endpoint]) result[endpoint] = requestEndpoint;
  }
  return result;
}

function normalizeEndpoint(value: unknown): VideoEndpoint {
  return normalizeKnownEndpoint(value) ?? "text_to_video";
}

function normalizeKnownEndpoint(value: unknown): VideoEndpoint | null {
  const normalized = normalizeEndpointText(value);
  const compact = normalized.replace(/_/g, "");
  if (
    normalized === "first_last_frame" ||
    normalized === "first_frame_last_frame" ||
    compact === "firstlastframe" ||
    compact === "firstframelastframe"
  ) {
    return "first_last_frame";
  }
  if (
    normalized === "reference" ||
    normalized === "reference_to_video" ||
    normalized === "reference_video" ||
    normalized === "multi_reference" ||
    normalized === "multi_reference_video" ||
    normalized === "multi_reference_to_video" ||
    normalized === "image_reference_video" ||
    normalized === "image_reference_to_video"
  ) {
    return "reference_to_video";
  }
  if (
    normalized === "image" ||
    normalized === "image_to_video" ||
    normalized === "image_video" ||
    normalized === "img_to_video"
  ) {
    return "image_to_video";
  }
  if (
    normalized === "text" ||
    normalized === "text_to_video" ||
    normalized === "text_video" ||
    normalized === "txt_to_video"
  ) {
    return "text_to_video";
  }
  return null;
}

function normalizeEndpointText(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeRequestEndpoint(value: unknown, fallback: VideoEndpoint): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text && normalizeEndpoint(text) === fallback) return text;
  return fallback;
}

function normalizeRequestEndpoints(rawEndpoints: string[]): Partial<Record<VideoEndpoint, string>> {
  const result: Partial<Record<VideoEndpoint, string>> = {};
  for (const rawEndpoint of rawEndpoints) {
    const requestEndpoint = rawEndpoint.trim();
    if (!requestEndpoint) continue;
    const endpoint = normalizeKnownEndpoint(requestEndpoint);
    if (!endpoint) continue;
    if (!result[endpoint]) result[endpoint] = requestEndpoint;
  }
  return result;
}

function normalizeReferenceType(value: unknown): VideoReferenceType {
  const text = String(value || "")
    .trim()
    .toLowerCase();
  return VIDEO_REFERENCE_TYPES.has(text as VideoReferenceType) ? (text as VideoReferenceType) : DEFAULT_REFERENCE_TYPE;
}

function referenceTypeArray(value: unknown): VideoReferenceType[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return list
    .map((item) => (isRecord(item) ? item.id : item))
    .filter(
      (item): item is VideoReferenceType =>
        typeof item === "string" && VIDEO_REFERENCE_TYPES.has(item as VideoReferenceType)
    )
    .filter((item, index, self) => self.indexOf(item) === index);
}

function endpointLabel(value: VideoEndpoint): string {
  if (value === "text_to_video") return "文生视频";
  if (value === "image_to_video") return "图生视频";
  if (value === "reference_to_video") return "多参考图";
  return "首尾帧";
}

function referenceTypeLabel(value: VideoReferenceType): string {
  if (value === "ordinary") return "普通";
  if (value === "reference") return "主体";
  if (value === "first_frame") return "首帧";
  if (value === "last_frame") return "尾帧";
  if (value === "character") return "角色";
  return "风格";
}

function normalizeRemoteStatus(value: string | null | undefined): VideoGenTask["status"] {
  const text = String(value || "").toLowerCase();
  if (text === "succeeded" || text === "success" || text === "completed" || text === "complete") return "succeeded";
  if (text === "failed" || text === "error") return "failed";
  if (text === "expired") return "expired";
  if (text === "cancelled" || text === "canceled") return "cancelled";
  if (text === "queued" || text === "pending") return "queued";
  return "running";
}

function isVideoStatus(value: unknown): value is VideoGenTask["status"] {
  return (
    value === "queued" ||
    value === "running" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "expired"
  );
}

function parseProgress(value: unknown): number | null {
  const hasPercentSign = typeof value === "string" && value.includes("%");
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace("%", "")) : NaN;
  if (!Number.isFinite(numeric)) return null;
  const percent = !hasPercentSign && numeric > 0 && numeric <= 1 ? numeric * 100 : numeric;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

function parseProgressFromRecords(records: Array<Record<string, unknown> | null>): number | null {
  const explicit = parseProgress(
    firstValueFromRecords(
      records,
      "progress",
      "percent",
      "percentage",
      "progress_percent",
      "progressPercent",
      "progress_percentage",
      "progressPercentage",
      "progress_ratio",
      "progressRatio",
      "completion",
      "completion_ratio",
      "completionRatio"
    )
  );
  if (explicit !== null) return explicit;
  return parseProgressFromText(
    firstStringFromRecords(
      records,
      "progress_text",
      "progressText",
      "status_message",
      "statusMessage",
      "message",
      "description"
    )
  );
}

function parseProgressFromText(value: string | null): number | null {
  if (!value) return null;
  const text = value.replace(/％/g, "%");
  const percentMatch = text.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (percentMatch) return parseProgress(`${percentMatch[1]}%`);
  const keywordMatch = text.match(
    /(?:progress|percent|percentage|completion|进度|完成度)[^\d-]{0,24}(-?\d+(?:\.\d+)?)/i
  );
  return keywordMatch ? parseProgress(keywordMatch[1]) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(asRecord(value));
}

function parseMaybeJson(value: unknown): unknown {
  if (!value || typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  return list.map((item) => String(item).trim()).filter(Boolean);
}

function numberArray(value: unknown): number[] {
  const list = Array.isArray(value) ? value : typeof value === "number" || typeof value === "string" ? [value] : [];
  return list
    .map((item) => Number.parseInt(String(item).replace("s", ""), 10))
    .filter((item) => Number.isFinite(item) && item > 0);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstStringFromRecords(records: Array<Record<string, unknown> | null>, ...keys: string[]): string | null {
  for (const record of records) {
    if (!record) continue;
    const value = firstString(...keys.map((key) => record[key]));
    if (value) return value;
  }
  return null;
}

function firstValueFromRecords(records: Array<Record<string, unknown> | null>, ...keys: string[]): unknown {
  for (const record of records) {
    if (!record) continue;
    const value = firstValue(...keys.map((key) => record[key]));
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function valuesFromRecords(records: Array<Record<string, unknown> | null>, ...keys: string[]): unknown[] {
  return records.flatMap((record) => (record ? keys.map((key) => record[key]) : []));
}

function firstArrayFromRecords(records: Array<Record<string, unknown> | null>, ...keys: string[]): unknown[] | null {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (Array.isArray(value)) return value;
    }
  }
  return null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    const cleaned = typeof value === "number" ? value : String(value).replace(/[^0-9.+-]/g, "");
    if (cleaned === "") continue;
    const numeric = typeof cleaned === "number" ? cleaned : Number(cleaned);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function boolValue(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
    if (typeof value === "string" && value.trim()) {
      const text = value.trim().toLowerCase();
      if (["1", "true", "yes", "paid", "charged", "billed"].includes(text)) return true;
      if (["0", "false", "no", "none", "unpaid", "refunded"].includes(text)) return false;
    }
  }
  return null;
}

function positiveNumber(...values: unknown[]): number | null {
  const value = firstNumber(...values);
  return value !== null && value >= 0 ? value : null;
}

function firstValue(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function uniqueRecords(records: Array<Record<string, unknown> | null>): Record<string, unknown>[] {
  return records.filter(
    (record, index): record is Record<string, unknown> => Boolean(record) && records.indexOf(record) === index
  );
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function inferFamily(model: string): string {
  const value = model.toLowerCase();
  if (value.includes("sora")) return "sora";
  if (value.includes("grok")) return "grok";
  if (value.includes("veo")) return "veo";
  if (value.includes("omni")) return "omni";
  if (value.includes("seedance") || value.includes("doubao") || value.includes("video-v1") || value.includes("wf-sd")) {
    return "seedance";
  }
  return "video";
}
