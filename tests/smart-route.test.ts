import { describe, expect, it } from "vitest";
import { fallbackDecision, parseSmartDecision } from "../src/main/smart-route";

describe("parseSmartDecision", () => {
  it("解析标准 JSON 决策并保留全部字段", () => {
    const decision = parseSmartDecision(
      JSON.stringify({
        category: "anime",
        reasoning: "二次元插画，线条平坦",
        recommended_pipeline: "realesrgan_anime",
        positive_prompt: "clean lineart",
        negative_prompt: "blurry",
        control_scale: 0.8,
        restoration_scale: 2.0
      })
    );
    expect(decision.recommendedPipeline).toBe("realesrgan_anime");
    expect(decision.positivePrompt).toBe("clean lineart");
    expect(decision.controlScale).toBe(0.8);
    expect(decision.restorationScale).toBe(2.0);
    expect(decision.fallback).toBe(false);
  });

  it("剥掉 markdown 围栏后仍能解析", () => {
    const wrapped = "```json\n" + JSON.stringify({ recommended_pipeline: "supir" }) + "\n```";
    expect(parseSmartDecision(wrapped).recommendedPipeline).toBe("supir");
  });

  it("缺失字段补节点同款默认值，非法管线归一为通用", () => {
    const decision = parseSmartDecision(JSON.stringify({ recommended_pipeline: "magic" }));
    expect(decision.recommendedPipeline).toBe("realesrgan_general");
    expect(decision.positivePrompt).toBe("high quality, detailed");
    expect(decision.controlScale).toBe(0.9);
  });

  it("control/restoration 夹到节点约定范围", () => {
    const decision = parseSmartDecision(
      JSON.stringify({ recommended_pipeline: "supir", control_scale: 5, restoration_scale: -9 })
    );
    expect(decision.controlScale).toBe(1.0);
    expect(decision.restorationScale).toBe(-1.0);
  });

  it("非 JSON 输入抛错（由调用方回退）", () => {
    expect(() => parseSmartDecision("not json")).toThrow();
  });
});

describe("fallbackDecision", () => {
  it("回退 = 节点 fallback_decision 同款：通用 ESRGAN + 标记 fallback", () => {
    const decision = fallbackDecision("网络失败");
    expect(decision.recommendedPipeline).toBe("realesrgan_general");
    expect(decision.fallback).toBe(true);
    expect(decision.reasoning).toBe("网络失败");
  });
});
