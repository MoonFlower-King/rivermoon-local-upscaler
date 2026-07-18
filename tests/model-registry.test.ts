import { describe, expect, it } from "vitest";
import {
  DEFAULT_UPSCALE_MODEL,
  UPSCALE_MODEL_REGISTRY,
  findModelSpec,
  normalizeUpscaleModel
} from "../src/main/model-registry";

describe("UPSCALE_MODEL_REGISTRY", () => {
  it("默认模型存在于注册表且为网站同款 UltraSharp", () => {
    expect(DEFAULT_UPSCALE_MODEL).toBe("4x-UltraSharp.pth");
    expect(findModelSpec(DEFAULT_UPSCALE_MODEL)).not.toBeNull();
  });

  it("至少提供一个可商用模型（发版授权底线）", () => {
    expect(UPSCALE_MODEL_REGISTRY.some((spec) => spec.commercial)).toBe(true);
  });

  it("每个条目具备完整的下载与校验信息", () => {
    for (const spec of UPSCALE_MODEL_REGISTRY) {
      expect(spec.fileName.endsWith(".pth")).toBe(true);
      expect(spec.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(spec.sizeBytes).toBeGreaterThan(1_000_000);
      expect(spec.urls.length).toBeGreaterThanOrEqual(2);
      for (const url of spec.urls) expect(url.startsWith("https://")).toBe(true);
    }
  });
});

describe("normalizeUpscaleModel", () => {
  it("注册表内文件名原样通过，非法值回退默认", () => {
    expect(normalizeUpscaleModel("RealESRGAN_x4plus.pth")).toBe("RealESRGAN_x4plus.pth");
    expect(normalizeUpscaleModel("RealESRGAN_x4plus_anime_6B.pth")).toBe("RealESRGAN_x4plus_anime_6B.pth");
    expect(normalizeUpscaleModel("evil.pth")).toBe(DEFAULT_UPSCALE_MODEL);
    expect(normalizeUpscaleModel(undefined)).toBe(DEFAULT_UPSCALE_MODEL);
    expect(normalizeUpscaleModel(42)).toBe(DEFAULT_UPSCALE_MODEL);
  });
});
