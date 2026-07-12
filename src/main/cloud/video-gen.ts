import { app } from "electron";
import dns from "node:dns/promises";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  RelayError,
  classifyRelayError,
  isTransientRelayError,
  shouldRetryTransientRelayError
} from "./relay-protocol.js";
import {
  failedVideoContract,
  buildVideoJobRequestPayload,
  isVideoTerminalStatus,
  normalizeVideoContractCacheValue,
  parseUploadedVideoSource,
  parseVideoContract,
  parseVideoJobResponse,
  parseVideoJobsList,
  validateVideoSourceFileContent,
  validateVideoSourceFileMeta,
  type VideoJobSourceRef,
  type RemoteVideoJob
} from "./video-protocol.js";
import {
  VIDEO_DOWNLOAD_MAX_BYTES,
  VIDEO_BASE_URL,
  VIDEO_HOST,
  absoluteVideoUrl,
  extensionFromVideoResponse,
  isHttpsVideoGatewayUrl,
  redactVideoUrlForLog,
  resolveVideoDownloadPlan,
  validateVideoFileHeader,
  validateVideoDownloadHeaders
} from "./video-url.js";
import { log } from "../logger.js";
import type { VideoContract, VideoGatewayDiagnostics, VideoGenParams, VideoReferenceType } from "../types.js";

const VIDEO_CONTRACT_BASE_URLS = [VIDEO_BASE_URL, "http://video.rivermoon7.com"];

const CONTRACT_TIMEOUT_MS = 15_000;
const SOURCE_UPLOAD_TIMEOUT_MS = 120_000;
const SUBMIT_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 30_000;
const RECENT_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const EXECUTION_TIMEOUT_MS = 45 * 60 * 1000;
const POLL_INTERVAL_MS = 3500;
const RETRY_DELAYS_MS = [3000, 8000];
const MAX_POLL_TRANSIENT_ERRORS = 5;
const MAX_VIDEO_REDIRECTS = 3;

type VideoRequestInit = RequestInit & { baseUrl?: string; allowExternalRedirect?: boolean };

type UploadedVideoSource = VideoJobSourceRef;

export function videosAssetDir(now = new Date()): string {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return path.join(app.getPath("userData"), "assets", "videos", month);
}

function videoContractCachePath(): string {
  return path.join(app.getPath("userData"), "video-contract-cache.json");
}

export async function fetchVideoContract(signal?: AbortSignal): Promise<VideoContract> {
  let lastError: unknown = null;
  for (const baseUrl of VIDEO_CONTRACT_BASE_URLS) {
    try {
      return await fetchVideoContractFromBaseUrl(baseUrl, signal);
    } catch (error) {
      lastError = error;
    }
  }
  const cached = await loadVideoContractCache();
  if (cached) {
    return {
      ...cached,
      error: `视频合同同步失败，正在使用上次缓存：${lastError instanceof Error ? lastError.message : String(lastError)}`,
      fromCache: true
    };
  }
  return failedVideoContract(lastError);
}

export async function fetchFreshHttpsVideoContract(signal?: AbortSignal): Promise<VideoContract> {
  try {
    return await fetchVideoContractFromBaseUrl(VIDEO_BASE_URL, signal);
  } catch (error) {
    return failedVideoContract(
      new RelayError(
        "network",
        `提交前无法同步 HTTPS 视频合同：${error instanceof Error ? error.message : String(error)}`
      )
    );
  }
}

export async function runVideoGeneration(
  params: VideoGenParams,
  clientRequestId: string,
  key: string,
  signal: AbortSignal,
  onUpdate?: (job: RemoteVideoJob) => void
): Promise<{ outputPath: string; outputBytes: number; job: RemoteVideoJob }> {
  const sources = await uploadVideoSources(params.referencePaths, params.referenceTypes, key, signal);
  const submitted = await submitWithRetry(params, sources, clientRequestId, key, signal);
  if (!submitted.jobId) throw new RelayError("bad-response", "视频服务没有返回任务 ID，请稍后重试。");
  onUpdate?.(submitted);
  const finalJob = await waitForVideoJob(submitted.jobId, key, signal, submitted, onUpdate);
  return downloadCompletedVideo(finalJob, key, signal);
}

export async function resumeVideoGeneration(
  jobId: string,
  key: string,
  signal: AbortSignal,
  onUpdate?: (job: RemoteVideoJob) => void
): Promise<{ outputPath: string; outputBytes: number; job: RemoteVideoJob }> {
  const initial: RemoteVideoJob = {
    jobId,
    requestId: null,
    clientRequestId: null,
    status: "running",
    progress: null,
    model: null,
    prompt: null,
    endpoint: "text_to_video",
    aspectRatio: null,
    duration: null,
    resolution: null,
    dryRun: false,
    contentUrl: null,
    downloadUrl: null,
    outputUrl: null,
    errorMessage: null,
    message: "正在恢复远端视频任务",
    costUsd: null,
    estimatedCostUsd: null,
    charged: null,
    refunded: null
  };
  onUpdate?.(initial);
  const finalJob = await waitForVideoJob(jobId, key, signal, initial, onUpdate);
  return downloadCompletedVideo(finalJob, key, signal);
}

export async function fetchRecentVideoJobs(key: string, signal: AbortSignal): Promise<RemoteVideoJob[]> {
  const payload = await videoFetchJson<unknown>("/v1/video/jobs/recent", key, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(RECENT_TIMEOUT_MS)])
  });
  return parseVideoJobsList(payload);
}

export async function runVideoGatewayDiagnostics(): Promise<VideoGatewayDiagnostics> {
  const checkedAt = Date.now();
  const [dnsAddresses, https, httpFallback] = await Promise.all([
    lookupVideoDns(),
    probeVideoContract(`${VIDEO_BASE_URL}/v1/video/contract`, true),
    probeVideoContract("http://video.rivermoon7.com/v1/video/contract", false)
  ]);
  return { checkedAt, host: VIDEO_HOST, dnsAddresses, https, httpFallback };
}

async function downloadCompletedVideo(
  finalJob: RemoteVideoJob,
  key: string,
  signal: AbortSignal
): Promise<{ outputPath: string; outputBytes: number; job: RemoteVideoJob }> {
  if (finalJob.status !== "succeeded") {
    throw new RelayError("bad-response", finalJob.errorMessage || `视频任务未成功完成：${finalJob.status}`);
  }
  if (finalJob.dryRun) {
    throw new RelayError("bad-response", "视频服务当前处于 dry-run 模式，未产生可下载视频。");
  }
  const downloadPlan = resolveVideoDownloadPlan(
    finalJob.downloadUrl || finalJob.contentUrl || finalJob.outputUrl,
    finalJob.jobId
  );
  if (!downloadPlan.ok) throw new RelayError("bad-response", downloadPlan.error);

  const outputPath = await downloadVideoFromPlan(downloadPlan.requests, key, signal, finalJob.jobId);
  const outputBytes = await fsp
    .stat(outputPath)
    .then((stat) => stat.size)
    .catch(() => 0);
  return { outputPath, outputBytes, job: finalJob };
}

async function downloadVideoFromPlan(
  requests: Array<{ url: string; attachAuth: boolean }>,
  key: string,
  signal: AbortSignal,
  jobId: string
): Promise<string> {
  let lastError: unknown = null;
  for (const request of requests) {
    try {
      return await downloadVideo(request.url, request.attachAuth ? key : null, signal, jobId);
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
      lastError = error;
      log(
        `视频下载候选地址失败 url=${redactVideoUrlForLog(request.url)}：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  throw lastError instanceof Error ? lastError : new RelayError("bad-response", "视频下载失败，请稍后恢复同步。");
}

async function probeVideoContract(url: string, parseContract: true): Promise<VideoGatewayDiagnostics["https"]>;
async function probeVideoContract(url: string, parseContract: false): Promise<VideoGatewayDiagnostics["httpFallback"]>;
async function probeVideoContract(
  url: string,
  parseContract: boolean
): Promise<VideoGatewayDiagnostics["https"] | VideoGatewayDiagnostics["httpFallback"]> {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(CONTRACT_TIMEOUT_MS) });
    const durationMs = Date.now() - startedAt;
    if (!parseContract) {
      return {
        ok: response.ok,
        status: response.status,
        durationMs,
        error: response.ok ? null : `HTTP ${response.status}`
      };
    }
    const payload = (await response.json()) as unknown;
    const contract = parseVideoContract(payload);
    return {
      ok: response.ok && contract.ok,
      status: response.status,
      durationMs,
      modelCount: contract.models.length,
      contractVersion: extractContractVersion(payload),
      error: response.ok ? contract.error : `HTTP ${response.status}`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startedAt;
    if (!parseContract) return { ok: false, status: null, durationMs, error: message };
    return { ok: false, status: null, durationMs, modelCount: null, contractVersion: null, error: message };
  }
}

async function lookupVideoDns(): Promise<string[]> {
  return Promise.race([
    dns.lookup(VIDEO_HOST, { all: true }).then((addresses) => addresses.map((item) => item.address)),
    new Promise<string[]>((resolve) => setTimeout(() => resolve([]), 5000))
  ]).catch(() => []);
}

async function uploadVideoSources(
  referencePaths: string[],
  referenceTypes: VideoReferenceType[],
  key: string,
  signal: AbortSignal
): Promise<UploadedVideoSource[]> {
  const sources: UploadedVideoSource[] = [];
  for (const [index, referencePath] of referencePaths.entries()) {
    const referenceType = referenceTypes[index] ?? "ordinary";
    const source = await uploadVideoSource(referencePath, referenceType, key, signal);
    sources.push(source);
  }
  return sources;
}

async function uploadVideoSource(
  referencePath: string,
  referenceType: VideoReferenceType,
  key: string,
  signal: AbortSignal
): Promise<UploadedVideoSource> {
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(referencePath);
  } catch {
    throw new RelayError("bad-response", `参考图无法读取：${path.basename(referencePath)}`);
  }
  if (!stat.isFile()) throw new RelayError("bad-response", `参考图不是可读取文件：${path.basename(referencePath)}`);
  const metaError = validateVideoSourceFileMeta(referencePath, stat.size);
  if (metaError) throw new RelayError("bad-response", metaError);

  const buffer = await fsp.readFile(referencePath);
  const readError = validateVideoSourceFileContent(referencePath, buffer);
  if (readError) throw new RelayError("bad-response", readError);
  for (let attempt = 0; ; attempt += 1) {
    try {
      const payload = await videoFetchJson<unknown>("/v1/video/source-cache", key, {
        method: "POST",
        body: buildVideoSourceUploadBody(buffer, referencePath, referenceType),
        signal: AbortSignal.any([signal, AbortSignal.timeout(SOURCE_UPLOAD_TIMEOUT_MS)])
      });
      const source = parseUploadedVideoSource(payload);
      if (!source.sourceId && !source.sourceUrl) {
        throw new RelayError("bad-response", "视频服务没有返回参考图缓存地址。");
      }
      return source;
    } catch (error) {
      const delayMs = RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || signal.aborted || !isTransientRelayError(error)) throw error;
      log(
        `视频参考图上传遇到瞬时错误，${delayMs / 1000}s 后重试（第 ${attempt + 1} 次）：${error instanceof Error ? error.message : String(error)}`
      );
      await abortableDelay(delayMs, signal);
    }
  }
}

function buildVideoSourceUploadBody(
  buffer: Buffer,
  referencePath: string,
  referenceType: VideoReferenceType
): FormData {
  const body = new FormData();
  body.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: mimeFromPath(referencePath) }),
    path.basename(referencePath)
  );
  body.append("reference_type", referenceType);
  return body;
}

async function submitWithRetry(
  params: VideoGenParams,
  sources: UploadedVideoSource[],
  clientRequestId: string,
  key: string,
  signal: AbortSignal
): Promise<RemoteVideoJob> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const payload = await videoFetchJson<unknown>("/v1/video/jobs", key, {
        method: "POST",
        body: JSON.stringify(buildVideoJobRequestPayload(params, sources, clientRequestId)),
        signal: AbortSignal.any([signal, AbortSignal.timeout(SUBMIT_TIMEOUT_MS)])
      });
      return parseVideoJobResponse(payload);
    } catch (error) {
      const delayMs = RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || signal.aborted || !isTransientRelayError(error)) throw error;
      log(
        `视频提交遇到瞬时错误，${delayMs / 1000}s 后重试（第 ${attempt + 1} 次）：${error instanceof Error ? error.message : String(error)}`
      );
      await abortableDelay(delayMs, signal);
    }
  }
}

async function waitForVideoJob(
  jobId: string,
  key: string,
  signal: AbortSignal,
  initial: RemoteVideoJob,
  onUpdate?: (job: RemoteVideoJob) => void
): Promise<RemoteVideoJob> {
  const startedAt = Date.now();
  let current = initial;
  let transientPollErrors = 0;
  while (Date.now() - startedAt < EXECUTION_TIMEOUT_MS) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (isVideoTerminalStatus(current.status)) return current;
    await abortableDelay(POLL_INTERVAL_MS, signal);
    try {
      const payload = await videoFetchJson<unknown>(`/v1/video/jobs/${encodeURIComponent(jobId)}`, key, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(POLL_TIMEOUT_MS)])
      });
      transientPollErrors = 0;
      current = parseVideoJobResponse(payload, current);
      onUpdate?.(current);
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
      if (shouldRetryTransientRelayError(error, transientPollErrors, MAX_POLL_TRANSIENT_ERRORS)) {
        transientPollErrors += 1;
        log(
          `视频状态同步暂时失败，继续等待远端任务（${transientPollErrors}/${MAX_POLL_TRANSIENT_ERRORS}）：${error instanceof Error ? error.message : String(error)}`
        );
        continue;
      }
      throw error;
    }
  }
  throw new RelayError("server", "视频生成等待超时，请稍后到任务记录中检查或重试。");
}

async function downloadVideo(url: string, key: string | null, signal: AbortSignal, jobId: string): Promise<string> {
  const response = await videoFetch(url, key, {
    allowExternalRedirect: true,
    signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
  });
  const contentType = response.headers.get("Content-Type");
  const headerValidation = validateVideoDownloadHeaders(contentType, response.headers.get("Content-Length"));
  if (!headerValidation.ok) throw new RelayError("bad-response", headerValidation.error);
  if (!response.body) throw new RelayError("bad-response", "视频服务没有返回可下载内容。");

  const ext = extensionFromVideoResponse(url, contentType);
  const dir = videosAssetDir();
  await fsp.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
  const target = uniquePath(path.join(dir, `${stamp}_${safeName(jobId)}${ext}`));
  await streamVideoResponseToFile(response.body, target, signal, contentType);
  return target;
}

async function streamVideoResponseToFile(
  body: ReadableStream<Uint8Array>,
  target: string,
  signal: AbortSignal,
  contentType: string | null
): Promise<void> {
  const tmpPath = `${target}.download`;
  await fsp.rm(tmpPath, { force: true }).catch(() => {
    // 清理失败不阻断后续写入尝试。
  });
  const file = fs.createWriteStream(tmpPath);
  let receivedBytes = 0;
  const headerBytes: number[] = [];

  try {
    for await (const chunk of body) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const buffer = Buffer.from(chunk);
      if (headerBytes.length < 16) {
        headerBytes.push(...buffer.subarray(0, 16 - headerBytes.length));
      }
      receivedBytes += buffer.length;
      if (receivedBytes > VIDEO_DOWNLOAD_MAX_BYTES) {
        throw new RelayError("bad-response", "视频文件超过 2GB，无法保存。");
      }
      await new Promise<void>((resolve, reject) => file.write(buffer, (error) => (error ? reject(error) : resolve())));
    }
    await new Promise<void>((resolve, reject) => file.end((error: unknown) => (error ? reject(error) : resolve())));
    if (receivedBytes <= 0) throw new RelayError("bad-response", "视频下载为空，请稍后恢复同步。");
    const contentValidation = validateVideoFileHeader(Uint8Array.from(headerBytes), contentType);
    if (!contentValidation.ok) throw new RelayError("bad-response", contentValidation.error);
    await fsp.rename(tmpPath, target);
  } catch (error) {
    file.destroy();
    await fsp.rm(tmpPath, { force: true }).catch(() => {
      // 清理失败忽略，下一次下载会覆盖同名临时文件。
    });
    throw error;
  }
}

async function fetchVideoContractFromBaseUrl(baseUrl: string, signal?: AbortSignal): Promise<VideoContract> {
  const payload = await videoFetchJson<unknown>("/v1/video/contract", null, {
    baseUrl,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(CONTRACT_TIMEOUT_MS)])
      : AbortSignal.timeout(CONTRACT_TIMEOUT_MS)
  });
  const contract = parseVideoContract(payload, Date.now(), contractSourceFromBaseUrl(baseUrl));
  if (contract.ok) {
    void saveVideoContractCache(contract).catch((error) => {
      log(`视频合同缓存保存失败：${error instanceof Error ? error.message : String(error)}`);
    });
  }
  return contract;
}

function contractSourceFromBaseUrl(baseUrl: string): VideoContract["source"] {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol === "https:") return "https";
    if (parsed.protocol === "http:") return "http";
  } catch {
    // Fall through.
  }
  return "unknown";
}

async function videoFetchJson<T>(resource: string, key: string | null, init: VideoRequestInit = {}): Promise<T> {
  const response = await videoFetch(resource, key, init);
  try {
    return (await response.json()) as T;
  } catch {
    throw new RelayError("bad-response", "视频服务返回了无法解析的响应。");
  }
}

async function videoFetch(resource: string, key: string | null, init: VideoRequestInit = {}): Promise<Response> {
  const requestUrl = absoluteVideoUrl(resource, init.baseUrl) ?? resource;
  let response: Response;
  try {
    response = await fetchVideoResponse(requestUrl, key, init);
  } catch (error) {
    if (error instanceof RelayError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new RelayError("network", "连接视频服务超时，请检查网络后重试。");
    }
    throw new RelayError("network", "无法连接视频服务，请检查网络。");
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw classifyRelayError(response.status, bodyText);
  }
  return response;
}

async function fetchVideoResponse(
  requestUrl: string,
  key: string | null,
  init: VideoRequestInit,
  redirectCount = 0
): Promise<Response> {
  if (key && !isHttpsVideoGatewayUrl(requestUrl)) {
    throw new RelayError("auth", "视频认证请求必须使用 HTTPS 视频网关。");
  }
  const response = await fetch(requestUrl, {
    ...fetchInitWithoutBaseUrl(init),
    redirect: "manual",
    headers: videoRequestHeaders(init, key)
  });
  if (!isRedirectStatus(response.status)) return response;
  if (redirectCount >= MAX_VIDEO_REDIRECTS) {
    throw new RelayError("bad-response", "视频服务重定向次数过多，请稍后恢复同步。");
  }
  const nextUrl = resolveVideoRedirectUrl(response.headers.get("Location"), requestUrl);
  if (!nextUrl) throw new RelayError("bad-response", "视频服务返回了无效重定向地址。");
  const method = String(init.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new RelayError("bad-response", "视频服务返回了不安全的重定向，请稍后重试。");
  }
  const nextIsGateway = isHttpsVideoGatewayUrl(nextUrl);
  if (key && !nextIsGateway && init.allowExternalRedirect !== true) {
    throw new RelayError("bad-response", "视频服务返回了不安全的重定向，请稍后重试。");
  }
  const nextKey = key && nextIsGateway ? key : null;
  return fetchVideoResponse(nextUrl, nextKey, init, redirectCount + 1);
}

function fetchInitWithoutBaseUrl(init: VideoRequestInit): RequestInit {
  const { baseUrl: _baseUrl, allowExternalRedirect: _allowExternalRedirect, headers: _headers, ...rest } = init;
  return rest;
}

function videoRequestHeaders(init: VideoRequestInit, key: string | null): Record<string, string> {
  const headers = plainHeaders(init.headers);
  for (const header of Object.keys(headers)) {
    if (header.toLowerCase() === "authorization") delete headers[header];
  }
  if (key) headers.Authorization = `Bearer ${key}`;
  if (typeof init.body === "string" && !hasHeader(headers, "content-type")) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

function plainHeaders(value: HeadersInit | undefined): Record<string, string> {
  if (!value) return {};
  if (value instanceof Headers) {
    const result: Record<string, string> = {};
    value.forEach((headerValue, header) => {
      result[header] = headerValue;
    });
    return result;
  }
  if (Array.isArray(value)) {
    return Object.fromEntries(value.map(([header, headerValue]) => [header, headerValue]));
  }
  return { ...value };
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((header) => header.toLowerCase() === name.toLowerCase());
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function resolveVideoRedirectUrl(location: string | null, currentUrl: string): string | null {
  if (!location) return null;
  try {
    const url = new URL(location, currentUrl);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
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

function uniquePath(target: string): string {
  if (!fs.existsSync(target)) return target;
  const parsed = path.parse(target);
  for (let index = 2; ; index += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}_${index}${parsed.ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80) || "video";
}

function extractContractVersion(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const root = payload as Record<string, unknown>;
  const value = root.contract_version ?? root.contractVersion ?? root.version;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function mimeFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

async function saveVideoContractCache(contract: VideoContract): Promise<void> {
  const target = videoContractCachePath();
  const tmp = `${target}.tmp`;
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify({ ...contract, fromCache: false, error: null }, null, 2), "utf8");
  await fsp.rename(tmp, target);
}

async function loadVideoContractCache(): Promise<VideoContract | null> {
  try {
    return normalizeVideoContractCacheValue(JSON.parse(await fsp.readFile(videoContractCachePath(), "utf8")));
  } catch {
    return null;
  }
}
