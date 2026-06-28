import fs from "node:fs";
import path from "node:path";
import { logsRoot } from "./paths.js";

const LOG_FILE = "app.log";
const PREV_LOG_FILE = "app.prev.log";
const MAX_LOG_BYTES = 1_000_000; // 超过 1MB 轮转一次

function logFilePath(): string {
  return path.join(logsRoot(), LOG_FILE);
}

/** 追加一行带时间戳的日志；任何失败都不影响主流程。 */
export function log(message: string): void {
  try {
    rotateIfNeeded();
    fs.appendFileSync(logFilePath(), `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // 日志写入失败不致命。
  }
}

function rotateIfNeeded(): void {
  try {
    const stat = fs.statSync(logFilePath());
    if (stat.size > MAX_LOG_BYTES) {
      fs.renameSync(logFilePath(), path.join(logsRoot(), PREV_LOG_FILE));
    }
  } catch {
    // 文件不存在时无需轮转。
  }
}

/** 读取最近的日志尾部（默认 200KB），用于诊断导出。 */
export function readRecentLog(maxBytes = 200_000): string {
  try {
    const data = fs.readFileSync(logFilePath(), "utf8");
    return data.length > maxBytes ? data.slice(data.length - maxBytes) : data;
  } catch {
    return "";
  }
}

export { logsRoot };
