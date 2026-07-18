import { describe, expect, it } from "vitest";
import {
  VIDEO_DOWNLOAD_MAX_BYTES,
  extensionFromVideoResponse,
  isHttpsVideoGatewayUrl,
  redactVideoUrlForLog,
  resolveVideoDownloadPlan,
  resolveVideoDownloadRequest,
  safePersistentVideoUrl,
  validateVideoFileHeader,
  validateVideoDownloadHeaders,
  videoJobDownloadFallbackUrls
} from "../src/main/cloud/video-url";

describe("video url policy", () => {
  it("相对视频下载地址走 HTTPS 视频网关并附带认证", () => {
    expect(resolveVideoDownloadRequest("/v1/video/jobs/vjob_1/download")).toEqual({
      ok: true,
      url: "https://video.rivermoon7.com/v1/video/jobs/vjob_1/download",
      attachAuth: true
    });
  });

  it("HTTPS 视频网关下载地址附带认证", () => {
    expect(resolveVideoDownloadRequest("https://video.rivermoon7.com/v1/video/jobs/vjob_1/content")).toEqual({
      ok: true,
      url: "https://video.rivermoon7.com/v1/video/jobs/vjob_1/content",
      attachAuth: true
    });
  });

  it("外部 HTTPS 签名下载地址不附带 RiverMoon Key", () => {
    expect(resolveVideoDownloadRequest("https://cdn.example.com/out/vjob_1.mp4?signature=abc")).toEqual({
      ok: true,
      url: "https://cdn.example.com/out/vjob_1.mp4?signature=abc",
      attachAuth: false
    });
  });

  it("下载请求会剥离 URL fragment，避免临时 token 进入 fetch 计划", () => {
    expect(resolveVideoDownloadRequest("https://cdn.example.com/out/vjob_1.mp4?signature=abc#token=secret")).toEqual({
      ok: true,
      url: "https://cdn.example.com/out/vjob_1.mp4?signature=abc",
      attachAuth: false
    });
    expect(resolveVideoDownloadRequest("/v1/video/jobs/vjob_1/download#token=secret")).toEqual({
      ok: true,
      url: "https://video.rivermoon7.com/v1/video/jobs/vjob_1/download",
      attachAuth: true
    });
  });

  it("拒绝 HTTP 视频下载地址", () => {
    expect(resolveVideoDownloadRequest("http://video.rivermoon7.com/v1/video/jobs/vjob_1/download")).toMatchObject({
      ok: false,
      error: "视频下载地址必须使用 HTTPS，请同步远端任务或稍后重试。"
    });
    expect(resolveVideoDownloadRequest("http://cdn.example.com/out.mp4")).toMatchObject({ ok: false });
  });

  it("只有 HTTPS 视频网关允许附带认证", () => {
    expect(isHttpsVideoGatewayUrl("https://video.rivermoon7.com/v1/video/jobs")).toBe(true);
    expect(isHttpsVideoGatewayUrl("http://video.rivermoon7.com/v1/video/jobs")).toBe(false);
    expect(isHttpsVideoGatewayUrl("https://cdn.example.com/v1/video/jobs")).toBe(false);
    expect(isHttpsVideoGatewayUrl("https://user:pass@video.rivermoon7.com/v1/video/jobs")).toBe(false);
  });

  it("拒绝带内嵌凭据的视频下载地址", () => {
    expect(resolveVideoDownloadRequest("https://user:pass@cdn.example.com/out/vjob_1.mp4")).toMatchObject({
      ok: false,
      error: "视频下载地址不能包含内嵌凭据，请同步远端任务或稍后重试。"
    });
    expect(
      resolveVideoDownloadRequest("https://user:pass@video.rivermoon7.com/v1/video/jobs/vjob_1/download")
    ).toMatchObject({
      ok: false
    });
  });

  it("远端成功但没有直连下载地址时按 job_id 尝试网关 download/content", () => {
    expect(resolveVideoDownloadPlan(null, "vjob_1")).toEqual({
      ok: true,
      requests: [
        {
          url: "https://video.rivermoon7.com/v1/video/jobs/vjob_1/download",
          attachAuth: true
        },
        {
          url: "https://video.rivermoon7.com/v1/video/jobs/vjob_1/content",
          attachAuth: true
        }
      ]
    });
  });

  it("外部 HTTPS 签名地址优先且不带 Key，同时保留网关 fallback", () => {
    expect(resolveVideoDownloadPlan("https://cdn.example.com/out/vjob_1.mp4?signature=abc", "vjob_1")).toEqual({
      ok: true,
      requests: [
        {
          url: "https://cdn.example.com/out/vjob_1.mp4?signature=abc",
          attachAuth: false
        },
        {
          url: "https://video.rivermoon7.com/v1/video/jobs/vjob_1/download",
          attachAuth: true
        },
        {
          url: "https://video.rivermoon7.com/v1/video/jobs/vjob_1/content",
          attachAuth: true
        }
      ]
    });
  });

  it("下载计划中的直链不会携带 URL fragment，但仍保留 query 签名", () => {
    expect(
      resolveVideoDownloadPlan("https://cdn.example.com/out/vjob_1.mp4?signature=abc#token=secret", "vjob_1")
    ).toEqual({
      ok: true,
      requests: [
        {
          url: "https://cdn.example.com/out/vjob_1.mp4?signature=abc",
          attachAuth: false
        },
        {
          url: "https://video.rivermoon7.com/v1/video/jobs/vjob_1/download",
          attachAuth: true
        },
        {
          url: "https://video.rivermoon7.com/v1/video/jobs/vjob_1/content",
          attachAuth: true
        }
      ]
    });
  });

  it("HTTP 直链不使用；有 job_id 时仍可回退安全网关地址", () => {
    expect(resolveVideoDownloadPlan("http://cdn.example.com/out.mp4", "vjob_1")).toMatchObject({
      ok: true,
      requests: [
        {
          url: "https://video.rivermoon7.com/v1/video/jobs/vjob_1/download",
          attachAuth: true
        },
        {
          url: "https://video.rivermoon7.com/v1/video/jobs/vjob_1/content",
          attachAuth: true
        }
      ]
    });
    expect(resolveVideoDownloadPlan("http://cdn.example.com/out.mp4", null)).toMatchObject({ ok: false });
  });

  it("带内嵌凭据的直链不使用；有 job_id 时仍可回退安全网关地址", () => {
    expect(resolveVideoDownloadPlan("https://user:pass@cdn.example.com/out.mp4", "vjob_1")).toMatchObject({
      ok: true,
      requests: [
        {
          url: "https://video.rivermoon7.com/v1/video/jobs/vjob_1/download",
          attachAuth: true
        },
        {
          url: "https://video.rivermoon7.com/v1/video/jobs/vjob_1/content",
          attachAuth: true
        }
      ]
    });
    expect(resolveVideoDownloadPlan("https://user:pass@cdn.example.com/out.mp4", null)).toMatchObject({ ok: false });
  });

  it("直链已经是网关 fallback 时不重复加入同一个地址", () => {
    const plan = resolveVideoDownloadPlan("/v1/video/jobs/vjob_1/download", "vjob_1");

    expect(plan).toMatchObject({ ok: true });
    if (plan.ok) {
      expect(plan.requests.map((request) => request.url)).toEqual([
        "https://video.rivermoon7.com/v1/video/jobs/vjob_1/download",
        "https://video.rivermoon7.com/v1/video/jobs/vjob_1/content"
      ]);
    }
  });

  it("构造网关 fallback 地址时编码 job id", () => {
    expect(videoJobDownloadFallbackUrls("job 1/2")).toEqual([
      "/v1/video/jobs/job%201%2F2/download",
      "/v1/video/jobs/job%201%2F2/content"
    ]);
  });

  it("视频下载响应头只允许视频或二进制内容", () => {
    expect(validateVideoDownloadHeaders("video/mp4", "1024")).toEqual({ ok: true, expectedBytes: 1024 });
    expect(validateVideoDownloadHeaders("application/octet-stream", null)).toEqual({
      ok: true,
      expectedBytes: null
    });
    expect(validateVideoDownloadHeaders("application/json", "128")).toMatchObject({
      ok: false,
      error: "视频服务返回的不是视频文件，请稍后恢复同步。"
    });
    expect(validateVideoDownloadHeaders("text/html; charset=utf-8", "128")).toMatchObject({ ok: false });
  });

  it("视频下载响应头拒绝空文件和超大文件", () => {
    expect(validateVideoDownloadHeaders("video/mp4", "0")).toMatchObject({
      ok: false,
      error: "视频下载为空，请稍后恢复同步。"
    });
    expect(validateVideoDownloadHeaders("video/mp4", String(VIDEO_DOWNLOAD_MAX_BYTES + 1))).toMatchObject({
      ok: false,
      error: "视频文件超过 2GB，无法保存。"
    });
  });

  it("按响应类型或下载地址推断视频扩展名", () => {
    expect(extensionFromVideoResponse("https://cdn.example.com/out?id=1", "video/webm")).toBe(".webm");
    expect(extensionFromVideoResponse("https://cdn.example.com/out", "video/quicktime")).toBe(".mov");
    expect(extensionFromVideoResponse("https://cdn.example.com/out/file.m4v?sig=1", null)).toBe(".m4v");
    expect(extensionFromVideoResponse("https://cdn.example.com/out/file.bin", "application/octet-stream")).toBe(".mp4");
  });

  it("二进制或未知类型下载需要可识别的视频文件头", () => {
    const mp4Header = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const webmHeader = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);
    const jsonHeader = new TextEncoder().encode('{"error":"not ready"}');

    expect(validateVideoFileHeader(mp4Header, "application/octet-stream")).toEqual({ ok: true });
    expect(validateVideoFileHeader(webmHeader, null)).toEqual({ ok: true });
    expect(validateVideoFileHeader(jsonHeader, "application/octet-stream")).toMatchObject({
      ok: false,
      error: "视频下载内容是错误响应，不是可保存的视频文件，请稍后恢复同步。"
    });
  });

  it("明确 video content-type 时不过度依赖文件头", () => {
    const shortHeader = new Uint8Array([1, 2, 3, 4]);

    expect(validateVideoFileHeader(shortHeader, "video/mp4")).toEqual({ ok: true });
  });

  it("即使响应头伪装成 video 也拒绝明显 JSON/HTML 错误体", () => {
    const jsonHeader = new TextEncoder().encode(' {"error":"download not ready"}');
    const htmlHeader = new TextEncoder().encode("<!doctype html><html><body>bad gateway</body></html>");

    expect(validateVideoFileHeader(jsonHeader, "video/mp4")).toMatchObject({
      ok: false,
      error: "视频下载内容是错误响应，不是可保存的视频文件，请稍后恢复同步。"
    });
    expect(validateVideoFileHeader(htmlHeader, "video/mp4")).toMatchObject({
      ok: false
    });
  });

  it("持久化视频 URL 时移除签名 query 并优先使用网关 fallback", () => {
    expect(
      safePersistentVideoUrl("https://cdn.example.com/out/vjob_1.mp4?signature=abc&token=secret", "vjob_1", "download")
    ).toBe("/v1/video/jobs/vjob_1/download");
    expect(
      safePersistentVideoUrl(
        "https://video.rivermoon7.com/v1/video/jobs/vjob_1/content?token=secret",
        "vjob_1",
        "content"
      )
    ).toBe("/v1/video/jobs/vjob_1/content");
  });

  it("持久化视频 URL 时不保存 fragment token", () => {
    expect(safePersistentVideoUrl("https://cdn.example.com/out/vjob_1.mp4#token=secret", "vjob_1", "download")).toBe(
      "/v1/video/jobs/vjob_1/download"
    );
    expect(safePersistentVideoUrl("https://cdn.example.com/out/vjob_1.mp4#token=secret", null, "download")).toBe(
      "https://cdn.example.com/out/vjob_1.mp4"
    );
  });

  it("持久化视频 URL 时保留无 query 的 HTTPS 直链", () => {
    expect(safePersistentVideoUrl("https://cdn.example.com/out/vjob_1.mp4", "vjob_1", "download")).toBe(
      "https://cdn.example.com/out/vjob_1.mp4"
    );
    expect(safePersistentVideoUrl("/v1/video/jobs/vjob_1/download", "vjob_1", "download")).toBe(
      "/v1/video/jobs/vjob_1/download"
    );
  });

  it("持久化视频 URL 时不保存内嵌凭据", () => {
    expect(safePersistentVideoUrl("https://user:pass@cdn.example.com/out/vjob_1.mp4", "vjob_1", "download")).toBe(
      "/v1/video/jobs/vjob_1/download"
    );
    expect(safePersistentVideoUrl("https://user:pass@cdn.example.com/out/vjob_1.mp4", null, "download")).toBeNull();
  });

  it("日志里的视频 URL 会脱敏 query、fragment 和内嵌凭据", () => {
    expect(redactVideoUrlForLog("https://cdn.example.com/out/vjob_1.mp4?signature=abc#token=secret")).toBe(
      "https://cdn.example.com/out/vjob_1.mp4?..."
    );
    expect(redactVideoUrlForLog("https://user:pass@cdn.example.com/out/vjob_1.mp4")).toBe(
      "https://cdn.example.com/out/vjob_1.mp4"
    );
    expect(redactVideoUrlForLog("/v1/video/jobs/vjob_1/download?token=secret")).toBe(
      "https://video.rivermoon7.com/v1/video/jobs/vjob_1/download?..."
    );
  });
});
