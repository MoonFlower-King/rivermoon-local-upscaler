import { describe, expect, it } from "vitest";
import {
  computeTargetDimensions,
  computeWebClearDimensions,
  computeWorkerOutputDimensions,
  outputExtension,
  readWorkerImageDimensions,
  resolveConcreteFormat
} from "../src/main/image";

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

describe("computeWebClearDimensions", () => {
  it("网页增强小图按长边放到 4096", () => {
    expect(computeWebClearDimensions({ width: 1000, height: 500 }, 4096)).toEqual({ width: 4096, height: 2048 });
  });

  it("网页增强受 16MP 输出像素上限约束", () => {
    expect(computeWebClearDimensions({ width: 2000, height: 2000 }, 4096)).toEqual({ width: 4096, height: 4096 });
  });

  it("网页增强不缩小超过 maxSide 的原图", () => {
    expect(computeWebClearDimensions({ width: 5000, height: 4000 }, 4096)).toEqual({ width: 5000, height: 4000 });
  });
});

describe("outputExtension", () => {
  it("各格式扩展名", () => {
    expect(outputExtension("jpg")).toBe("jpg");
    expect(outputExtension("png")).toBe("png");
    expect(outputExtension("webp")).toBe("webp");
  });
});

describe("resolveConcreteFormat", () => {
  it("auto 与网站一致：无透明输出 JPEG，有透明输出 PNG", () => {
    expect(resolveConcreteFormat("auto", false)).toBe("jpg");
    expect(resolveConcreteFormat("auto", true)).toBe("png");
  });

  it("用户指定格式时保留", () => {
    expect(resolveConcreteFormat("webp", false)).toBe("webp");
    expect(resolveConcreteFormat("png", false)).toBe("png");
  });
});

describe("worker-compatible image sizing", () => {
  it("按 worker 的 PNG 文件头解析尺寸并计算输出", async () => {
    const pngHeader = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(pngHeader, 0);
    pngHeader.writeUInt32BE(1000, 16);
    pngHeader.writeUInt32BE(500, 20);
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const filePath = path.join(os.tmpdir(), `rivermoon-worker-size-${Date.now()}.png`);
    await fs.writeFile(filePath, pngHeader);
    try {
      expect(await readWorkerImageDimensions(filePath)).toEqual({ width: 1000, height: 500 });
      expect(await computeWorkerOutputDimensions(filePath, 4096)).toEqual({ width: 4000, height: 2000 });
    } finally {
      await fs.rm(filePath, { force: true });
    }
  });
});
