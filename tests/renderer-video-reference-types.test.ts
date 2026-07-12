import { describe, expect, it } from "vitest";
import { pruneVideoReferenceTypeMap, resolveRendererVideoReferenceTypes } from "../src/renderer/video-reference-types";

describe("renderer video reference types", () => {
  it("多参考图按逐图选择的类型提交，并用默认类型补齐未设置项", () => {
    expect(
      resolveRendererVideoReferenceTypes(
        "reference_to_video",
        ["C:/a.png", "C:/b.png", "C:/c.png"],
        "ordinary",
        {
          "C:/a.png": "character",
          "C:/b.png": "style"
        },
        ["ordinary", "character", "style"]
      )
    ).toEqual(["character", "style", "ordinary"]);
  });

  it("模型切换后不提交当前模型不支持的历史参考图类型", () => {
    expect(
      resolveRendererVideoReferenceTypes(
        "image_to_video",
        ["C:/a.png", "C:/b.png"],
        "ordinary",
        {
          "C:/a.png": "style",
          "C:/b.png": "character"
        },
        ["ordinary", "character"]
      )
    ).toEqual(["ordinary", "character"]);
  });

  it("首尾帧模式忽略手动类型，始终按参考图顺序提交首帧和尾帧", () => {
    expect(
      resolveRendererVideoReferenceTypes(
        "first_last_frame",
        ["C:/first.png", "C:/last.png", "C:/extra.png"],
        "style",
        {
          "C:/first.png": "character",
          "C:/last.png": "ordinary",
          "C:/extra.png": "style"
        },
        ["ordinary", "style", "character"]
      )
    ).toEqual(["first_frame", "last_frame", "reference"]);
  });

  it("移除参考图后清理不再使用的逐图类型", () => {
    expect(
      pruneVideoReferenceTypeMap(
        {
          "C:/a.png": "character",
          "C:/b.png": "style",
          "C:/removed.png": "ordinary"
        },
        ["C:/a.png", "C:/b.png"]
      )
    ).toEqual({
      "C:/a.png": "character",
      "C:/b.png": "style"
    });
  });
});
