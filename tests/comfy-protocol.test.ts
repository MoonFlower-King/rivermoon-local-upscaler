import { describe, expect, it } from "vitest";
import {
  ComfyExecutionError,
  NODE,
  SUPIR_DEFAULTS,
  assertHistoryHealthy,
  buildStandardPromptTemplate,
  buildSupirPrompt,
  describeStandardWorkflow,
  extractExecutionMessage,
  progressFromState
} from "../src/main/comfy-protocol";

describe("assertHistoryHealthy", () => {
  it("status_str=error 且 completed=false 时立刻判败（ComfyUI 失败任务不会有 completed=true）", () => {
    const item = {
      status: {
        status_str: "error",
        completed: false,
        messages: [["execution_error", { exception_message: "CUDA out of memory" }]]
      }
    };
    expect(() => assertHistoryHealthy(item)).toThrowError(ComfyExecutionError);
    expect(() => assertHistoryHealthy(item)).toThrowError(/CUDA out of memory/);
  });

  it("completed 但状态不是 success/completed 同样判败", () => {
    expect(() => assertHistoryHealthy({ status: { status_str: "weird", completed: true } })).toThrowError(
      ComfyExecutionError
    );
  });

  it("成功与执行中的条目静默通过", () => {
    expect(() => assertHistoryHealthy({ status: { status_str: "success", completed: true } })).not.toThrow();
    expect(() => assertHistoryHealthy({ status: { status_str: "running", completed: false } })).not.toThrow();
    expect(() => assertHistoryHealthy({})).not.toThrow();
  });
});

describe("extractExecutionMessage", () => {
  it("从 messages 里取出 execution_error 的 exception_message", () => {
    const messages = [
      ["execution_start", {}],
      ["execution_error", { exception_message: "无法解码图片", exception_type: "RuntimeError" }]
    ];
    expect(extractExecutionMessage(messages)).toBe("无法解码图片");
  });

  it("没有 exception_message 时回退 exception_type，找不到返回 null", () => {
    expect(extractExecutionMessage([["execution_error", { exception_type: "OOM" }]])).toBe("OOM");
    expect(extractExecutionMessage([["execution_start", {}]])).toBeNull();
    expect(extractExecutionMessage(undefined)).toBeNull();
  });
});

describe("progressFromState", () => {
  it("上采样节点 50% 映射到 base 20 + span 58 的一半", () => {
    const nodes = { [NODE.UPSCALE]: { value: 5, max: 10, state: "running" } };
    expect(progressFromState(nodes, "p1")).toBe(20 + Math.round(0.5 * 58));
  });

  it("finished 节点按 100% 计，且忽略其他 prompt 的节点", () => {
    const nodes = {
      [NODE.SCALE]: { state: "finished", prompt_id: "p1" },
      other: { value: 9, max: 10, prompt_id: "p2" }
    };
    expect(progressFromState(nodes, "p1")).toBe(88);
  });

  it("整体进度封顶 90，等待完成信号收尾", () => {
    const nodes = { [NODE.SAVE]: { state: "finished" } };
    expect(progressFromState(nodes, "p1")).toBeLessThanOrEqual(90);
  });

  it("空或无有效节点返回 null", () => {
    expect(progressFromState({}, "p1")).toBeNull();
    expect(progressFromState(undefined, "p1")).toBeNull();
  });
});

describe("describeStandardWorkflow", () => {
  it("输出网站同款 AI 的稳定节点链路摘要", () => {
    expect(describeStandardWorkflow()).toBe(
      "LoadImage -> UpscaleModelLoader(4x-UltraSharp.pth) -> ImageUpscaleWithModel -> ImageScale(Lanczos target width/height) -> SaveImage"
    );
  });

  it("输出不含本地路径的标准 ComfyUI prompt 模板", () => {
    expect(buildStandardPromptTemplate("4x-UltraSharp.pth")).toMatchObject({
      [NODE.LOAD]: { inputs: { image: "<comfy_input_file>" } },
      [NODE.MODEL]: { inputs: { model_name: "4x-UltraSharp.pth" } },
      [NODE.SCALE]: { inputs: { width: "<target_width>", height: "<target_height>", upscale_method: "lanczos" } },
      [NODE.SAVE]: { inputs: { filename_prefix: "<output_prefix>" } }
    });
  });
});

describe("buildSupirPrompt", () => {
  it("SUPIR 参数与网站 CodexSmartEnhance medium 档逐项一致", () => {
    const prompt = buildSupirPrompt("in.png", 1.5, "prefix") as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    expect(prompt[NODE.LOAD]).toMatchObject({ class_type: "LoadImage", inputs: { image: "in.png" } });
    expect(prompt[NODE.SAVE]).toMatchObject({ class_type: "SaveImage", inputs: { filename_prefix: "prefix" } });
    expect(prompt[NODE.UPSCALE].class_type).toBe("SUPIR_Upscale");
    expect(prompt[NODE.UPSCALE].inputs).toMatchObject({
      supir_model: SUPIR_DEFAULTS.supirModel,
      sdxl_model: SUPIR_DEFAULTS.sdxlModel,
      scale_by: 1.5,
      steps: 25,
      cfg_scale: 5.0,
      control_scale: 0.9,
      restoration_scale: 1.0,
      s_churn: 5,
      s_noise: 1.003,
      color_fix_type: "Wavelet",
      resize_method: "lanczos",
      use_tiled_vae: true,
      use_tiled_sampling: true,
      fp8_unet: true,
      fp8_vae: true,
      sampler: "RestoreDPMPP2MSampler"
    });
  });

  it("SUPIR 节点复用 NODE.UPSCALE id，进度映射无需改动", () => {
    const prompt = buildSupirPrompt("in.png", 1.12, "p");
    expect(Object.keys(prompt).sort()).toEqual([NODE.LOAD, NODE.UPSCALE, NODE.SAVE].sort());
  });
});
