import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../src/main/settings";

describe("sanitizeSettings", () => {
  it("空/非法输入回退到默认值", () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings("garbage")).toEqual(DEFAULT_SETTINGS);
  });

  it("outputFormat 固定为 worker SaveImage PNG", () => {
    expect(sanitizeSettings({ outputFormat: "gif" } as unknown).outputFormat).toBe("png");
    expect(sanitizeSettings({ outputFormat: "auto" }).outputFormat).toBe("png");
    expect(sanitizeSettings({ outputFormat: "webp" }).outputFormat).toBe("png");
    expect(sanitizeSettings({ outputFormat: "jpg" }).outputFormat).toBe("png");
  });

  it("三种处理模式合法保留，非法值归一为默认组合模式", () => {
    expect(sanitizeSettings({ processingMode: "remoteAi" } as unknown).processingMode).toBe("aiUpscaleWebClear");
    expect(sanitizeSettings({ processingMode: "aiUpscale" }).processingMode).toBe("aiUpscale");
    expect(sanitizeSettings({ processingMode: "aiUpscaleWebClear" }).processingMode).toBe("aiUpscaleWebClear");
    expect(sanitizeSettings({ processingMode: "webClear" }).processingMode).toBe("webClear");
  });

  it("maxSide <=0 视为不限制(0)，否则夹到 [256, 16384]", () => {
    expect(sanitizeSettings({ maxSide: 0 }).maxSide).toBe(0);
    expect(sanitizeSettings({ maxSide: -5 }).maxSide).toBe(0);
    expect(sanitizeSettings({ maxSide: NaN }).maxSide).toBe(0);
    expect(sanitizeSettings({ maxSide: 100 }).maxSide).toBe(256);
    expect(sanitizeSettings({ maxSide: 99999 }).maxSide).toBe(16384);
    expect(sanitizeSettings({ maxSide: 4096 }).maxSide).toBe(4096);
  });

  it("空字符串 outputDirectory 归一为 null", () => {
    expect(sanitizeSettings({ outputDirectory: "" }).outputDirectory).toBeNull();
    expect(sanitizeSettings({ outputDirectory: "D:/out" }).outputDirectory).toBe("D:/out");
  });

  it("忽略已废弃的多余字段，只保留当前设置项", () => {
    const result = sanitizeSettings({ outputFormat: "png", model: "x", scale: 2, engineMode: "y" } as unknown);
    expect(result).toEqual({
      processingMode: "aiUpscaleWebClear",
      outputFormat: "png",
      outputDirectory: null,
      maxSide: 4096,
      upscaleModel: "4x-UltraSharp.pth"
    });
  });
});
