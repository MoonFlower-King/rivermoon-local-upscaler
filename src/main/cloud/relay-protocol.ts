/**
 * 中转站（NewAPI）协议纯逻辑：错误分类/中文化、响应解析。
 * 不依赖 electron / 网络，vitest 可直测。
 */

import { redactDiagnosticsText } from "../diagnostics-redaction.js";

export type RelayErrorKind = "auth" | "quota" | "rate" | "server" | "network" | "bad-response";

export class RelayError extends Error {
  constructor(
    public readonly kind: RelayErrorKind,
    message: string
  ) {
    super(message);
  }
}

/** 把 HTTP 状态码 + 响应体映射成用户可读的中文错误。quota 类由 UI 追加充值引导。 */
export function classifyRelayError(status: number, bodyText: string): RelayError {
  const lower = bodyText.toLowerCase();
  if (status === 401 || status === 403) {
    return new RelayError("auth", "API Key 无效或已过期，请在设置里检查 Key。");
  }
  if (lower.includes("quota") || lower.includes("余额") || lower.includes("insufficient")) {
    return new RelayError("quota", "账户余额不足，请充值后重试。");
  }
  if (status === 429) {
    return new RelayError("rate", "请求过于频繁或通道排队中，请稍后重试。");
  }
  if (status >= 500) {
    return new RelayError("server", `中转站服务暂时不可用（${status}），请稍后重试。`);
  }
  const detail = extractApiErrorMessage(bodyText);
  return new RelayError("bad-response", detail ? `请求被拒绝：${detail}` : `请求失败（HTTP ${status}）。`);
}

/** 尽力从 OpenAI 风格错误体里挖出 message；失败返回 null。 */
export function extractApiErrorMessage(bodyText: string): string | null {
  try {
    const parsed = JSON.parse(bodyText) as {
      detail?: { error?: unknown; message?: unknown } | string;
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    if (typeof parsed.error === "string") return sanitizeApiErrorDetail(parsed.error);
    if (parsed.error && typeof parsed.error === "object" && typeof parsed.error.message === "string") {
      return sanitizeApiErrorDetail(parsed.error.message);
    }
    if (typeof parsed.detail === "string") return sanitizeApiErrorDetail(parsed.detail);
    if (parsed.detail && typeof parsed.detail === "object") {
      if (typeof parsed.detail.message === "string") return sanitizeApiErrorDetail(parsed.detail.message);
      if (typeof parsed.detail.error === "string") return sanitizeApiErrorDetail(parsed.detail.error);
    }
    if (typeof parsed.message === "string") return sanitizeApiErrorDetail(parsed.message);
  } catch {
    // 非 JSON 响应。
  }
  const trimmed = bodyText.trim();
  return trimmed ? sanitizeApiErrorDetail(trimmed) : null;
}

function sanitizeApiErrorDetail(detail: string): string | null {
  if (looksLikeHtmlError(detail)) return "上游返回 HTML 错误页";

  const redacted = redactDiagnosticsText(detail)
    .replace(/\b(prompt|提示词)\b\s*[:：=]\s*[^。；;\r\n]{8,}/gi, "$1: [prompt]")
    .replace(/\b(bad prompt|invalid prompt|prompt rejected)\b\s+[^。；;\r\n]{8,}/gi, "$1 [prompt]")
    .replace(/\s+/g, " ")
    .trim();

  return redacted ? redacted.slice(0, 200) : null;
}

function looksLikeHtmlError(detail: string): boolean {
  return /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<\/html>|<\/body>/i.test(detail);
}

/** /v1/models 响应 → 模型 id 列表（排序去重）。 */
export function parseModelsResponse(payload: unknown): string[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const ids = data
    .map((item) => (item && typeof item === "object" ? (item as { id?: unknown }).id : null))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** billing/subscription → 总额度（USD）；缺失返回 null。 */
export function parseSubscriptionUsd(payload: unknown): number | null {
  const value = (payload as { hard_limit_usd?: unknown })?.hard_limit_usd;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** billing/usage → 已用（USD）。NewAPI 的 total_usage 以 0.01 USD 为单位。 */
export function parseUsageUsd(payload: unknown): number | null {
  const value = (payload as { total_usage?: unknown })?.total_usage;
  return typeof value === "number" && Number.isFinite(value) ? value / 100 : null;
}

/** 瞬时错误（上游 503/限流/网络抖动）值得自动重试；配额/鉴权/参数类立即上抛。 */
export function isTransientRelayError(error: unknown): boolean {
  return error instanceof RelayError && (error.kind === "server" || error.kind === "rate" || error.kind === "network");
}

export function shouldRetryTransientRelayError(error: unknown, attempt: number, maxAttempts: number): boolean {
  return Number.isInteger(attempt) && attempt >= 0 && attempt < maxAttempts && isTransientRelayError(error);
}

/** 掩码展示 Key：只留前缀与末 4 位，渲染层只能见到这个。 */
export function maskKey(key: string): string {
  if (key.length <= 8) return "sk-****";
  return `${key.slice(0, 5)}…${key.slice(-4)}`;
}
