import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings.js";
import type { UpscaleSettings } from "./types.js";

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

/** 读取上次保存的设置；文件缺失或损坏时回退到默认值。
 *  sanitizeSettings 只挑取合法的 outputFormat/outputDirectory/maxSide，旧版多余字段自动忽略。 */
export function loadSettings(): UpscaleSettings {
  try {
    return sanitizeSettings(JSON.parse(fs.readFileSync(settingsPath(), "utf8")));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** 规整并持久化设置；写盘失败不致命（返回规整后的值供 UI 使用）。 */
export function saveSettings(input: unknown): UpscaleSettings {
  const clean = sanitizeSettings(input);
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(clean, null, 2), "utf8");
  } catch {
    // 持久化失败不阻塞使用。
  }
  return clean;
}
