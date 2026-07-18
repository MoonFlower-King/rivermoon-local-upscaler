import { RelayError, maskKey, parseModelsResponse, parseSubscriptionUsd, parseUsageUsd } from "./relay-protocol.js";
import { relayFetchJson } from "./relay-client.js";
import { clearKey, loadKey, saveKey } from "./key-store.js";
import { log } from "../logger.js";
import type { AccountStatus } from "../types.js";

/** 充值页；正式 URL 待产品方提供（TASKBOARD 4.1），暂跳首页。 */
export const TOPUP_URL = "https://rivermoon7.com/";

const STATUS_CACHE_MS = 5 * 60 * 1000;

let cached: { status: AccountStatus; at: number } | null = null;

/** 用 /v1/models 一石二鸟：校验 Key + 拿到该 Key 分组可用的模型列表（驱动生图 UI）。 */
async function fetchStatusWithKey(key: string): Promise<AccountStatus> {
  const models = parseModelsResponse(await relayFetchJson("/v1/models", key));
  // 余额/用量是展示性信息，失败不影响“已连接”判定。
  const [totalUsd, usedUsd] = await Promise.all([
    relayFetchJson("/v1/dashboard/billing/subscription", key)
      .then(parseSubscriptionUsd)
      .catch(() => null),
    relayFetchJson("/v1/dashboard/billing/usage", key)
      .then(parseUsageUsd)
      .catch(() => null)
  ]);
  return { connected: true, maskedKey: maskKey(key), models, totalUsd, usedUsd, error: null };
}

export async function getAccountStatus(force = false): Promise<AccountStatus> {
  const key = loadKey();
  if (!key) return { connected: false, maskedKey: null, models: [], totalUsd: null, usedUsd: null, error: null };
  if (!force && cached && Date.now() - cached.at < STATUS_CACHE_MS) return cached.status;

  try {
    const status = await fetchStatusWithKey(key);
    cached = { status, at: Date.now() };
    log(`账户状态刷新 connected=true 模型=${status.models.length}`);
    return status;
  } catch (error) {
    const message = error instanceof RelayError ? error.message : "连接中转站失败。";
    // Key 失效与网络故障区分开：网络故障保留“已配置”状态让用户重试，不逼用户重填 Key。
    const authFailed = error instanceof RelayError && error.kind === "auth";
    return {
      connected: false,
      maskedKey: maskKey(key),
      models: [],
      totalUsd: null,
      usedUsd: null,
      error: authFailed ? message : `${message}（Key 已保存，可点重试）`
    };
  }
}

/** 校验通过才落盘保存；失败原样抛 RelayError 给 UI 显示。 */
export async function setAccountKey(rawKey: unknown): Promise<AccountStatus> {
  const key = typeof rawKey === "string" ? rawKey.trim() : "";
  if (!key.startsWith("sk-") || key.length < 20) {
    throw new RelayError("auth", "Key 格式不正确，应以 sk- 开头。");
  }
  const status = await fetchStatusWithKey(key); // 先校验后保存
  saveKey(key);
  cached = { status, at: Date.now() };
  log(`账户已连接 模型=${status.models.length}`);
  return status;
}

export function clearAccountKey(): AccountStatus {
  clearKey();
  cached = null;
  return { connected: false, maskedKey: null, models: [], totalUsd: null, usedUsd: null, error: null };
}

/** 云任务完成后调用：让下次状态查询强制刷新余额。 */
export function invalidateAccountCache(): void {
  cached = null;
}
