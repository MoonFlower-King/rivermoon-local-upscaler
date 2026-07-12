import { describe, expect, it } from "vitest";
import {
  compareVersionStrings,
  checkForUpdates,
  GITHUB_RELEASES_URL,
  GITHUB_TAGS_URL,
  isAllowedUpdatePageUrl,
  LATEST_RELEASE_API,
  LATEST_TAGS_API
} from "../src/main/update-checker";

describe("update checker", () => {
  it("GitHub latest release 高于当前版本时返回可更新", async () => {
    const calls: string[] = [];
    const info = await checkForUpdates("0.1.0", async (input, init) => {
      calls.push(String(input));
      expect(new Headers(init?.headers).get("User-Agent")).toBe("RiverMoon-Local-Upscaler");
      return jsonResponse({
        tag_name: "v0.1.1",
        html_url: `${GITHUB_RELEASES_URL}/tag/v0.1.1`
      });
    });

    expect(calls).toEqual([LATEST_RELEASE_API]);
    expect(info).toMatchObject({
      ok: true,
      currentVersion: "0.1.0",
      latestVersion: "0.1.1",
      hasUpdate: true,
      source: "github-release",
      releaseUrl: `${GITHUB_RELEASES_URL}/tag/v0.1.1`,
      error: null
    });
  });

  it("GitHub latest release 等于当前版本时返回无更新", async () => {
    const info = await checkForUpdates("v0.1.0", async () =>
      jsonResponse({
        tag_name: "v0.1.0",
        html_url: `${GITHUB_RELEASES_URL}/tag/v0.1.0`
      })
    );

    expect(info.ok).toBe(true);
    expect(info.hasUpdate).toBe(false);
    expect(info.currentVersion).toBe("0.1.0");
    expect(info.latestVersion).toBe("0.1.0");
  });

  it("latest release 404 时回退读取最新 tag", async () => {
    const calls: string[] = [];
    const info = await checkForUpdates("0.1.0", async (input) => {
      calls.push(String(input));
      if (String(input) === LATEST_RELEASE_API) return jsonResponse({ message: "Not Found" }, 404);
      return jsonResponse([{ name: "v0.1.1" }]);
    });

    expect(calls).toEqual([LATEST_RELEASE_API, LATEST_TAGS_API]);
    expect(info).toMatchObject({
      ok: true,
      latestVersion: "0.1.1",
      hasUpdate: true,
      source: "github-tag",
      releaseUrl: GITHUB_TAGS_URL
    });
  });

  it("网络错误会返回中文失败结果而不是抛出", async () => {
    const info = await checkForUpdates("0.1.0", async () => {
      throw new Error("offline");
    });

    expect(info.ok).toBe(false);
    expect(info.hasUpdate).toBe(false);
    expect(info.error).toContain("无法连接 GitHub 更新服务");
  });

  it("版本比较支持 v 前缀和双位 minor", () => {
    expect(compareVersionStrings("v0.10.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersionStrings("0.1.0", "v0.1.0")).toBe(0);
    expect(compareVersionStrings("0.1.0", "0.1.1")).toBeLessThan(0);
  });

  it("打开更新页只允许当前 GitHub 仓库 releases/tags", () => {
    expect(isAllowedUpdatePageUrl(`${GITHUB_RELEASES_URL}/tag/v0.1.1`)).toBe(true);
    expect(isAllowedUpdatePageUrl(GITHUB_TAGS_URL)).toBe(true);
    expect(isAllowedUpdatePageUrl("https://github.com/other/repo/releases")).toBe(false);
    expect(isAllowedUpdatePageUrl("https://evil.example.com/MoonFlower-King/rivermoon-local-upscaler/releases")).toBe(
      false
    );
  });
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
