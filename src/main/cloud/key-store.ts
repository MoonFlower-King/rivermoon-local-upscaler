import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { log } from "../logger.js";

/**
 * API Key 保管：safeStorage（Windows DPAPI）加密后落盘。
 * - 磁盘上只有密文；渲染层只能拿到掩码（见 relay-protocol.maskKey）。
 * - 极少数环境 safeStorage 不可用时，Key 只保留在内存（重启后需重填），不落明文。
 */

let memoryKey: string | null = null;
let loaded = false;

function keyFilePath(): string {
  return path.join(app.getPath("userData"), "relay-key.json");
}

export function loadKey(): string | null {
  if (loaded) return memoryKey;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(keyFilePath(), "utf8")) as { encrypted?: string };
    if (raw.encrypted && safeStorage.isEncryptionAvailable()) {
      memoryKey = safeStorage.decryptString(Buffer.from(raw.encrypted, "base64"));
    }
  } catch {
    // 文件缺失/损坏/解密失败：视为未配置。
  }
  return memoryKey;
}

export function saveKey(key: string): void {
  memoryKey = key;
  loaded = true;
  if (!safeStorage.isEncryptionAvailable()) {
    log("safeStorage 不可用，Key 仅保存在内存（重启后需重填）");
    return;
  }
  try {
    const encrypted = safeStorage.encryptString(key).toString("base64");
    fs.writeFileSync(keyFilePath(), JSON.stringify({ encrypted }), "utf8");
  } catch (error) {
    log(`Key 落盘失败（仅内存保存）：${error instanceof Error ? error.message : String(error)}`);
  }
}

export function clearKey(): void {
  memoryKey = null;
  loaded = true;
  try {
    fs.rmSync(keyFilePath(), { force: true });
  } catch {
    // 删除失败忽略。
  }
}
