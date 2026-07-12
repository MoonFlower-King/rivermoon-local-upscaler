import { describe, expect, it } from "vitest";
import { type VideoSubmitStateInput, videoSubmitBlockReason } from "../src/renderer/video-submit-state";

function submitState(overrides: Partial<VideoSubmitStateInput> = {}): VideoSubmitStateInput {
  return {
    connected: true,
    contractReady: true,
    contractFresh: true,
    hasModel: true,
    prompt: "camera move",
    endpoint: "text_to_video",
    referenceCapacityOk: true,
    referenceReady: true,
    referenceCountOk: true,
    requiredReferenceCount: 0,
    referenceCount: 0,
    referenceLimit: 0,
    ...overrides
  };
}

describe("renderer video submit state", () => {
  it("按优先级给出生成按钮禁用原因", () => {
    expect(videoSubmitBlockReason(submitState({ connected: false }))).toBe("请先连接账户。");
    expect(videoSubmitBlockReason(submitState({ contractReady: false }))).toBe("视频合同暂不可用，请同步合同后重试。");
    expect(videoSubmitBlockReason(submitState({ contractFresh: false }))).toBe(
      "当前不是 HTTPS 实时合同，请先同步合同。"
    );
    expect(videoSubmitBlockReason(submitState({ hasModel: false }))).toBe("请选择可用视频模型。");
    expect(videoSubmitBlockReason(submitState({ prompt: "   " }))).toBe("请填写视频描述。");
  });

  it("参考图模式给出可执行的阻断原因", () => {
    expect(
      videoSubmitBlockReason(
        submitState({
          endpoint: "image_to_video",
          referenceReady: false,
          requiredReferenceCount: 1,
          referenceCount: 0,
          referenceLimit: 1
        })
      )
    ).toBe("当前视频模式需要至少 1 张参考图。");
    expect(
      videoSubmitBlockReason(
        submitState({
          endpoint: "first_last_frame",
          referenceReady: false,
          requiredReferenceCount: 2,
          referenceCount: 1,
          referenceLimit: 2
        })
      )
    ).toBe("首尾帧模式需要 2 张参考图。");
    expect(
      videoSubmitBlockReason(
        submitState({
          endpoint: "reference_to_video",
          referenceCountOk: false,
          referenceCount: 3,
          referenceLimit: 2
        })
      )
    ).toBe("参考图数量超过当前模型上限（2 张），请删除多余素材。");
  });

  it("所有提交条件满足时不显示阻断原因", () => {
    expect(videoSubmitBlockReason(submitState())).toBeNull();
  });
});
