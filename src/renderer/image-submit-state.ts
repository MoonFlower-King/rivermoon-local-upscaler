import type { AccountStatus } from "../main/types";

export const IMAGE_TOPUP_REQUIRED_MESSAGE = "账户余额不足，请充值后重试。";

const UNLIMITED_BALANCE_THRESHOLD = 1_000_000;

export function imageAccountNeedsTopup(
  account: Pick<AccountStatus, "connected" | "totalUsd" | "usedUsd"> | null
): boolean {
  if (!account?.connected || account.totalUsd == null || account.usedUsd == null) return false;
  if (account.totalUsd >= UNLIMITED_BALANCE_THRESHOLD) return false;
  return account.totalUsd - account.usedUsd <= 0;
}
