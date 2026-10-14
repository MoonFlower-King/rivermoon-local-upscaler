import path from "node:path";
import { fileURLToPath } from "node:url";

export const DEV_RENDERER_ORIGIN = "http://127.0.0.1:5173";

/**
 * 主窗口只允许停留在自己的页面上：开发态按 origin 精确比较（字符串前缀会被
 * `http://127.0.0.1:5173@evil.com` 这类 userinfo 地址绕过），打包态只允许渲染层入口文件本身。
 */
export function isAllowedAppNavigation(
  targetUrl: string,
  options: { packaged: boolean; rendererIndexPath: string }
): boolean {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    return false;
  }
  if (!options.packaged) {
    return url.origin === DEV_RENDERER_ORIGIN && url.username === "" && url.password === "";
  }
  if (url.protocol !== "file:" || url.host !== "") return false;
  try {
    return path.normalize(fileURLToPath(url)) === path.normalize(options.rendererIndexPath);
  } catch {
    return false;
  }
}
