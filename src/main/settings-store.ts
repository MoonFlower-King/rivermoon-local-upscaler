import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_SETTINGS, sanitizeSettings } from "./settings.js";
import type { UpscaleSettings } from "./types.js";

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

/** 读取上次保存的设置；文件缺失或损坏时回退到默认值。 */
export function loadSettings(): UpscaleSettings {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    if (raw && typeof raw === "object" && !("engineMode" in raw)) {
      raw.engineMode = "comfyui";
      raw.qualityMode = "standard";
      raw.model = "4x-UltraSharp.pth";
      raw.maxSide = 4096;
      raw.enhance = false;
    }
    if (raw && typeof raw === "object" && !("qualityMode" in raw)) {
      raw.qualityMode = "standard";
    }
    return sanitizeSettings(raw);
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
