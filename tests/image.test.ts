import { describe, expect, it } from "vitest";
import { computeTargetDimensions, outputExtension } from "../src/main/image";

describe("computeTargetDimensions", () => {
  it("不限制(maxSide=0)时按 scale 放大", () => {
    expect(computeTargetDimensions({ width: 100, height: 50 }, 0, 4)).toEqual({ width: 400, height: 200 });
  });

  it("maxSide 限制长边（cap 小于 scale 时按 cap 放大）", () => {
    // 长边 1000，maxSide 2000 → cap=2 < scale=4 → 取 2 倍
    expect(computeTargetDimensions({ width: 1000, height: 500 }, 2000, 4)).toEqual({ width: 2000, height: 1000 });
  });

  it("与网页版一致：原图长边超过 maxSide 时缩小到 maxSide（4x 输出经 Lanczos 缩回=超采样）", () => {
    // 长边 5000 > 4096 → scale = 4096/5000 = 0.8192
    expect(computeTargetDimensions({ width: 5000, height: 4000 }, 4096, 4)).toEqual({ width: 4096, height: 3277 });
  });

  it("长边恰好等于 maxSide 时保持原尺寸", () => {
    expect(computeTargetDimensions({ width: 4096, height: 2048 }, 4096, 4)).toEqual({ width: 4096, height: 2048 });
  });

  it("输出至少 1 像素", () => {
    expect(computeTargetDimensions({ width: 1, height: 1 }, 0, 4)).toEqual({ width: 4, height: 4 });
  });
});

describe("outputExtension", () => {
  it("各格式扩展名", () => {
    expect(outputExtension("jpg")).toBe("jpg");
    expect(outputExtension("png")).toBe("png");
    expect(outputExtension("webp")).toBe("webp");
  });
});
