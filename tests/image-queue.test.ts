import { describe, expect, it, vi } from "vitest";
import { stableImageTaskForDisk } from "../src/main/cloud/image-queue";
import type { ImageGenTask } from "../src/main/types";

vi.mock("electron", () => ({
  app: {
    getPath: () => "C:\\Temp\\rivermoon-test"
  }
}));

describe("image queue persistence", () => {
  it("写盘时成功任务不保留本地参考图绝对路径", () => {
    const stable = stableImageTaskForDisk(
      imageTask({
        status: "succeeded",
        referencePaths: ["C:\\Users\\Alice\\Pictures\\first.png", "D:\\Private\\style.png"],
        outputPaths: ["C:\\out\\1.png"]
      })
    );

    expect(stable.params.referencePaths).toEqual(["[已上传参考图]", "[已上传参考图]"]);
  });

  it("写盘时未成功的失败任务保留参考图路径以便重试", () => {
    const stable = stableImageTaskForDisk(
      imageTask({
        status: "failed",
        referencePaths: ["C:\\Users\\Alice\\Pictures\\first.png"],
        outputPaths: []
      })
    );

    expect(stable.params.referencePaths).toEqual(["C:\\Users\\Alice\\Pictures\\first.png"]);
  });

  it("写盘时关闭中的排队任务标记取消并脱敏参考图", () => {
    const stable = stableImageTaskForDisk(
      imageTask({
        status: "queued",
        referencePaths: ["C:\\Users\\Alice\\Pictures\\first.png"],
        outputPaths: []
      }),
      123
    );

    expect(stable.status).toBe("cancelled");
    expect(stable.finishedAt).toBe(123);
    expect(stable.params.referencePaths).toEqual(["[已上传参考图]"]);
  });
});

function imageTask({
  status,
  referencePaths,
  outputPaths
}: {
  status: ImageGenTask["status"];
  referencePaths: string[];
  outputPaths: string[];
}): ImageGenTask {
  return {
    id: "img_1",
    params: {
      model: "gpt-image-2",
      prompt: "city",
      size: "3840x2160",
      count: 1,
      quality: "high",
      outputFormat: "png",
      fitMode: "contain",
      sizeMode: "postprocess",
      referencePaths
    },
    status,
    createdAt: 1,
    startedAt: status === "queued" ? null : 2,
    finishedAt: status === "queued" ? null : 3,
    durationMs: null,
    message: "",
    error: null,
    needsTopup: false,
    outputPaths,
    outputSizes: outputPaths.map(() => 100)
  };
}
