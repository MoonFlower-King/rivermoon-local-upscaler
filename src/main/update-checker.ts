import type { UpdateInfo, UpdateCheckSource } from "./types.js";

export const GITHUB_OWNER = "MoonFlower-King";
export const GITHUB_REPO = "rivermoon-local-upscaler";
export const GITHUB_REPOSITORY_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;
export const GITHUB_RELEASES_URL = `${GITHUB_REPOSITORY_URL}/releases`;
export const GITHUB_TAGS_URL = `${GITHUB_REPOSITORY_URL}/tags`;
export const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;
export const LATEST_TAGS_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/tags?per_page=1`;

const CHECK_TIMEOUT_MS = 10_000;
const REQUEST_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "RiverMoon-Local-Upscaler"
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

type FetchJsonResult = {
  ok: boolean;
  status: number;
  payload: unknown;
};

export async function checkForUpdates(currentVersionRaw: string, fetchImpl: FetchLike = fetch): Promise<UpdateInfo> {
  const currentVersion = sanitizeCurrentVersion(currentVersionRaw);

  try {
    const release = await fetchJson(fetchImpl, LATEST_RELEASE_API);
    if (release.status === 404) return checkLatestTag(currentVersion, fetchImpl);
    if (!release.ok) {
      return failed(
        currentVersion,
        "none",
        `GitHub Release 检查失败（HTTP ${release.status}），请稍后重试或确认仓库 Release 可公开访问。`
      );
    }

    const record = asRecord(release.payload);
    const tagName = asNonEmptyString(record?.tag_name);
    if (!tagName) return failed(currentVersion, "github-release", "GitHub Release 响应缺少版本号 tag_name。");

    const latestVersion = normalizeVersionLabel(tagName) ?? tagName;
    return okResult({
      currentVersion,
      latestVersion,
      releaseUrl: safeUpdateUrl(asNonEmptyString(record?.html_url), releaseTagUrl(tagName)),
      source: "github-release"
    });
  } catch (error) {
    return failed(currentVersion, "none", githubNetworkError(error));
  }
}

export function compareVersionStrings(left: string | null | undefined, right: string | null | undefined): number {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  if (!leftParts || !rightParts) return 0;
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue > rightValue) return 1;
    if (leftValue < rightValue) return -1;
  }
  return 0;
}

export function normalizeVersionLabel(value: string | null | undefined): string | null {
  const parts = parseVersionParts(value);
  return parts ? parts.join(".") : null;
}

export function isAllowedUpdatePageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.hostname !== "github.com") return false;
  const releasesPath = `/${GITHUB_OWNER}/${GITHUB_REPO}/releases`;
  const tagsPath = `/${GITHUB_OWNER}/${GITHUB_REPO}/tags`;
  return (
    url.pathname === releasesPath ||
    url.pathname.startsWith(`${releasesPath}/`) ||
    url.pathname === tagsPath ||
    url.pathname.startsWith(`${tagsPath}/`)
  );
}

async function checkLatestTag(currentVersion: string, fetchImpl: FetchLike): Promise<UpdateInfo> {
  try {
    const tags = await fetchJson(fetchImpl, LATEST_TAGS_API);
    if (!tags.ok) {
      return failed(
        currentVersion,
        "none",
        `GitHub Release 未找到，tag 列表也不可读取（HTTP ${tags.status}）。请确认新版本发布到 GitHub Releases。`
      );
    }

    const tagName = latestTagName(tags.payload);
    if (!tagName) {
      return failed(currentVersion, "none", "GitHub Release 未找到，仓库也没有可用 tag。请先发布 GitHub Release。");
    }

    const latestVersion = normalizeVersionLabel(tagName) ?? tagName;
    return okResult({
      currentVersion,
      latestVersion,
      releaseUrl: GITHUB_TAGS_URL,
      source: "github-tag"
    });
  } catch (error) {
    return failed(currentVersion, "none", githubNetworkError(error));
  }
}

async function fetchJson(fetchImpl: FetchLike, url: string): Promise<FetchJsonResult> {
  const response = await fetchImpl(url, {
    headers: REQUEST_HEADERS,
    signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { ok: response.ok, status: response.status, payload };
}

function okResult(input: {
  currentVersion: string;
  latestVersion: string;
  releaseUrl: string;
  source: UpdateCheckSource;
}): UpdateInfo {
  return {
    ok: true,
    currentVersion: input.currentVersion,
    latestVersion: input.latestVersion,
    hasUpdate: compareVersionStrings(input.latestVersion, input.currentVersion) > 0,
    releaseUrl: input.releaseUrl,
    source: input.source,
    checkedAt: Date.now(),
    error: null
  };
}

function failed(currentVersion: string, source: UpdateCheckSource, error: string): UpdateInfo {
  return {
    ok: false,
    currentVersion,
    latestVersion: null,
    hasUpdate: false,
    releaseUrl: source === "github-release" ? GITHUB_RELEASES_URL : null,
    source,
    checkedAt: Date.now(),
    error
  };
}

function sanitizeCurrentVersion(value: string): string {
  const trimmed = value.trim();
  return normalizeVersionLabel(trimmed) ?? (trimmed || "0.0.0");
}

function parseVersionParts(value: string | null | undefined): number[] | null {
  const match = String(value ?? "")
    .trim()
    .match(/\d+(?:\.\d+)*/);
  if (!match) return null;
  const parts = match[0]
    .split(".")
    .slice(0, 4)
    .map((part) => Number(part));
  return parts.length > 0 && parts.every((part) => Number.isInteger(part) && part >= 0) ? parts : null;
}

function latestTagName(payload: unknown): string | null {
  if (!Array.isArray(payload)) return null;
  for (const item of payload) {
    const record = asRecord(item);
    const name = asNonEmptyString(record?.name);
    if (name) return name;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function safeUpdateUrl(value: string | null, fallback: string): string {
  return value && isAllowedUpdatePageUrl(value) ? value : fallback;
}

function releaseTagUrl(tagName: string): string {
  return `${GITHUB_RELEASES_URL}/tag/${encodeURIComponent(tagName)}`;
}

function githubNetworkError(error: unknown): string {
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "连接 GitHub 更新服务超时，请稍后重试。";
  }
  const detail = error instanceof Error ? error.message : String(error);
  return `无法连接 GitHub 更新服务：${detail}`;
}
