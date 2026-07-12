import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildOutputPath, resolveCollisionFreePath } from "../src/main/output-path";

describe("buildOutputPath", () => {
  it("无冲突时直接使用 _upscaled 名称", () => {
    expect(buildOutputPath(path.join("C:", "in", "a.png"), path.join("C:", "out"), "png", () => false)).toBe(
      path.join("C:", "out", "a_upscaled.png")
    );
  });

  it("jpg 格式使用 .jpg 扩展名", () => {
    expect(buildOutputPath(path.join("C:", "in", "a.png"), path.join("C:", "out"), "jpg", () => false)).toBe(
      path.join("C:", "out", "a_upscaled.jpg")
    );
  });

  it("目标已存在时追加 _2/_3 序号，不覆盖旧输出", () => {
    const existing = new Set([path.join("C:", "out", "a_upscaled.png"), path.join("C:", "out", "a_upscaled_2.png")]);
    expect(
      buildOutputPath(path.join("C:", "in", "a.jpg"), path.join("C:", "out"), "png", (candidate) =>
        existing.has(candidate)
      )
    ).toBe(path.join("C:", "out", "a_upscaled_3.png"));
  });
});

describe("resolveCollisionFreePath", () => {
  it("第一个不存在的候选即返回", () => {
    let calls = 0;
    const result = resolveCollisionFreePath("base", "png", () => {
      calls += 1;
      return calls < 3;
    });
    expect(result).toBe("base_3.png");
  });
});
