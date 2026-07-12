import { describe, expect, it } from "vitest";
import { redactDiagnosticsText } from "../src/main/diagnostics-redaction";

describe("diagnostics redaction", () => {
  it("脱敏最近日志里的 API Key", () => {
    expect(redactDiagnosticsText("Authorization: Bearer sk-test_1234567890abcdef")).toBe(
      "Authorization: Bearer sk-***"
    );
  });

  it("脱敏最近日志里的 Windows 绝对路径并保留文件名", () => {
    const redacted = redactDiagnosticsText("视频完成 -> C:\\Users\\Alice\\Videos\\result.mp4");

    expect(redacted).toBe("视频完成 -> [本地路径]\\result.mp4");
  });

  it("脱敏带空格的 Windows 绝对路径", () => {
    const redacted = redactDiagnosticsText("日志已导出 -> D:\\RiverMoon Local\\release check\\diag.txt");

    expect(redacted).toBe("日志已导出 -> [本地路径]\\diag.txt");
  });

  it("脱敏 Windows 文件路径时保留路径后的普通说明", () => {
    const redacted = redactDiagnosticsText("读取失败 C:\\Users\\Alice\\Pictures\\ref.png 请重新选择素材");

    expect(redacted).toBe("读取失败 [本地路径]\\ref.png 请重新选择素材");
  });

  it("脱敏 URL query，避免签名下载参数进入诊断包", () => {
    const redacted = redactDiagnosticsText(
      "download https://cdn.example.com/out/video.mp4?X-Amz-Signature=abc&token=secret, fallback https://video.rivermoon7.com/v1/video/jobs/job_1/download?key=secret"
    );

    expect(redacted).toBe(
      "download https://cdn.example.com/out/video.mp4?..., fallback https://video.rivermoon7.com/v1/video/jobs/job_1/download?..."
    );
  });

  it("脱敏 URL fragment，避免临时 token 进入诊断包", () => {
    const redacted = redactDiagnosticsText("download https://cdn.example.com/out/video.mp4#token=secret");

    expect(redacted).toBe("download https://cdn.example.com/out/video.mp4?...");
  });

  it("没有 query 的普通 URL 保持不变", () => {
    expect(redactDiagnosticsText("GET https://video.rivermoon7.com/v1/video/contract")).toBe(
      "GET https://video.rivermoon7.com/v1/video/contract"
    );
  });
});
