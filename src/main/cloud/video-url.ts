export const VIDEO_BASE_URL = "https://video.rivermoon7.com";
export const VIDEO_HOST = "video.rivermoon7.com";
export const VIDEO_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024;

export type VideoDownloadRequest = { ok: true; url: string; attachAuth: boolean } | { ok: false; error: string };
export type VideoDownloadPlan =
  { ok: true; requests: Array<{ url: string; attachAuth: boolean }> } | { ok: false; error: string };
export type VideoDownloadHeaderValidation = { ok: true; expectedBytes: number | null } | { ok: false; error: string };
export type VideoDownloadContentValidation = { ok: true } | { ok: false; error: string };

export function absoluteVideoUrl(value: string | null | undefined, baseUrl = VIDEO_BASE_URL): string | null {
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `${baseUrl}${value.startsWith("/") ? value : `/${value}`}`;
}

export function isHttpsVideoGatewayUrl(value: string, gatewayBaseUrl = VIDEO_BASE_URL): boolean {
  try {
    const parsed = new URL(value);
    const gateway = new URL(gatewayBaseUrl);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === gateway.hostname &&
      parsed.port === gateway.port &&
      !hasUrlCredentials(parsed)
    );
  } catch {
    return false;
  }
}

export function resolveVideoDownloadRequest(value: string | null | undefined): VideoDownloadRequest {
  const url = absoluteVideoUrl(value);
  if (!url) return { ok: false, error: "视频任务已完成，但没有返回下载地址。" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "视频服务返回了无效下载地址。" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, error: "视频下载地址必须使用 HTTPS，请同步远端任务或稍后重试。" };
  }
  if (hasUrlCredentials(parsed)) {
    return { ok: false, error: "视频下载地址不能包含内嵌凭据，请同步远端任务或稍后重试。" };
  }
  parsed.hash = "";
  const sanitizedUrl = parsed.toString();
  return { ok: true, url: sanitizedUrl, attachAuth: isHttpsVideoGatewayUrl(sanitizedUrl) };
}

export function resolveVideoDownloadPlan(
  value: string | null | undefined,
  jobId: string | null | undefined
): VideoDownloadPlan {
  const requests: Array<{ url: string; attachAuth: boolean }> = [];
  const direct = resolveVideoDownloadRequest(value);
  if (direct.ok) requests.push({ url: direct.url, attachAuth: direct.attachAuth });

  const normalizedJobId = typeof jobId === "string" ? jobId.trim() : "";
  if (normalizedJobId) {
    for (const fallbackUrl of videoJobDownloadFallbackUrls(normalizedJobId)) {
      const fallback = resolveVideoDownloadRequest(fallbackUrl);
      if (fallback.ok && !requests.some((request) => request.url === fallback.url)) {
        requests.push({ url: fallback.url, attachAuth: fallback.attachAuth });
      }
    }
  }

  if (requests.length > 0) return { ok: true, requests };
  return direct.ok ? { ok: false, error: "视频任务已完成，但没有可用下载地址。" } : direct;
}

export function videoJobDownloadFallbackUrls(jobId: string): string[] {
  const encoded = encodeURIComponent(jobId.trim());
  if (!encoded) return [];
  return [`/v1/video/jobs/${encoded}/download`, `/v1/video/jobs/${encoded}/content`];
}

export function safePersistentVideoUrl(
  value: string | null | undefined,
  jobId: string | null | undefined,
  fallbackKind: "download" | "content"
): string | null {
  const normalizedJobId = typeof jobId === "string" ? jobId.trim() : "";
  const fallback = normalizedJobId
    ? (videoJobDownloadFallbackUrls(normalizedJobId)[fallbackKind === "download" ? 0 : 1] ?? null)
    : null;
  if (!value) return null;

  const absolute = absoluteVideoUrl(value);
  if (!absolute) return fallback;
  try {
    const parsed = new URL(absolute);
    if (parsed.protocol !== "https:") return fallback;
    if (hasUrlCredentials(parsed)) return fallback;
    if (parsed.search || parsed.hash) return fallback ?? `${parsed.origin}${parsed.pathname}`;
    parsed.hash = "";
    if (isHttpsVideoGatewayUrl(absolute)) return parsed.pathname;
    return parsed.toString();
  } catch {
    return fallback;
  }
}

export function redactVideoUrlForLog(value: string): string {
  const absolute = absoluteVideoUrl(value);
  if (!absolute) return "[invalid-video-url]";
  try {
    const parsed = new URL(absolute);
    return `${parsed.origin}${parsed.pathname}${parsed.search || parsed.hash ? "?..." : ""}`;
  } catch {
    return "[invalid-video-url]";
  }
}

function hasUrlCredentials(value: URL): boolean {
  return value.username.length > 0 || value.password.length > 0;
}

export function validateVideoDownloadHeaders(
  contentType: string | null,
  contentLength: string | null,
  maxBytes = VIDEO_DOWNLOAD_MAX_BYTES
): VideoDownloadHeaderValidation {
  const lowerType = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (
    lowerType &&
    !lowerType.startsWith("video/") &&
    lowerType !== "application/octet-stream" &&
    lowerType !== "binary/octet-stream"
  ) {
    return { ok: false, error: "视频服务返回的不是视频文件，请稍后恢复同步。" };
  }

  const expectedBytes = parseContentLength(contentLength);
  if (expectedBytes === 0) return { ok: false, error: "视频下载为空，请稍后恢复同步。" };
  if (expectedBytes !== null && expectedBytes > maxBytes) {
    return { ok: false, error: `视频文件超过 ${formatBytes(maxBytes)}，无法保存。` };
  }
  return { ok: true, expectedBytes };
}

export function extensionFromVideoResponse(url: string, contentType: string | null): string {
  const lowerType = (contentType ?? "").toLowerCase();
  if (lowerType.includes("webm")) return ".webm";
  if (lowerType.includes("quicktime") || lowerType.includes("mov")) return ".mov";
  try {
    const ext = new URL(url).pathname.split("/").pop()?.toLowerCase() ?? "";
    if (ext.endsWith(".mp4")) return ".mp4";
    if (ext.endsWith(".webm")) return ".webm";
    if (ext.endsWith(".mov")) return ".mov";
    if (ext.endsWith(".m4v")) return ".m4v";
  } catch {
    // Fall through.
  }
  return ".mp4";
}

export function validateVideoFileHeader(
  header: Uint8Array,
  contentType: string | null
): VideoDownloadContentValidation {
  const lowerType = (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (looksLikeTextErrorBody(header)) {
    return { ok: false, error: "视频下载内容是错误响应，不是可保存的视频文件，请稍后恢复同步。" };
  }
  if (lowerType.startsWith("video/")) return { ok: true };
  if (isMp4LikeHeader(header) || isWebmHeader(header)) return { ok: true };
  return { ok: false, error: "视频下载内容不是可识别的视频文件，请稍后恢复同步。" };
}

function isMp4LikeHeader(header: Uint8Array): boolean {
  return header.length >= 12 && header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70;
}

function isWebmHeader(header: Uint8Array): boolean {
  return header.length >= 4 && header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
}

function looksLikeTextErrorBody(header: Uint8Array): boolean {
  const text = new TextDecoder()
    .decode(header.subarray(0, Math.min(header.length, 64)))
    .trimStart()
    .toLowerCase();
  return (
    text.startsWith("{") ||
    text.startsWith("[") ||
    text.startsWith("<!doctype") ||
    text.startsWith("<html") ||
    text.startsWith("<body") ||
    text.startsWith("<?xml")
  );
}

function parseContentLength(value: string | null): number | null {
  if (!value || !value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024 * 1024) return `${Math.floor(value / (1024 * 1024 * 1024))}GB`;
  if (value >= 1024 * 1024) return `${Math.floor(value / (1024 * 1024))}MB`;
  return `${value}B`;
}
