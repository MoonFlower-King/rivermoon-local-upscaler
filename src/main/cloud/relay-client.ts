import { RelayError, classifyRelayError } from "./relay-protocol.js";

/** 中转站固定域名。充值页 URL 由 account 模块单独维护。 */
export const RELAY_BASE_URL = "https://rivermoon7.com";

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 统一的中转站请求入口：注入 Key、超时、错误中文化。
 * 只在主进程使用；Key 绝不出主进程。
 */
export async function relayFetch(
  path: string,
  key: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${RELAY_BASE_URL}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${key}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {})
      },
      signal: init.signal ?? AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new RelayError("network", "连接中转站超时，请检查网络后重试。");
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error; // 任务取消原样上抛，由队列层处理。
    }
    throw new RelayError("network", "无法连接中转站，请检查网络。");
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw classifyRelayError(response.status, bodyText);
  }
  return response;
}

export async function relayFetchJson<T>(
  path: string,
  key: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const response = await relayFetch(path, key, init, timeoutMs);
  try {
    return (await response.json()) as T;
  } catch {
    throw new RelayError("bad-response", "中转站返回了无法解析的响应。");
  }
}
