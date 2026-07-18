import type { ImageDimensions } from "./types.js";

/**
 * ComfyUI 协议层纯逻辑：不依赖 electron / 网络 / 文件系统，
 * 供 comfy-engine 使用，也便于 vitest 直接单测。
 */

/** ComfyUI 工作流节点 id：buildStandardPrompt、进度映射、取输出共用，改工作流时单点维护。 */
export const NODE = { LOAD: "1", MODEL: "2", UPSCALE: "3", SCALE: "4", SAVE: "5" } as const;

export const STANDARD_WORKFLOW_STEPS = [
  { node: NODE.LOAD, classType: "LoadImage" },
  { node: NODE.MODEL, classType: "UpscaleModelLoader", detail: "4x-UltraSharp.pth" },
  { node: NODE.UPSCALE, classType: "ImageUpscaleWithModel" },
  { node: NODE.SCALE, classType: "ImageScale", detail: "Lanczos target width/height" },
  { node: NODE.SAVE, classType: "SaveImage" }
] as const;

export type ComfyHistoryItem = {
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: unknown[];
  };
  outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }>;
};

export type ComfyPromptResponse = {
  prompt_id?: string;
  node_errors?: unknown;
};

export type ComfyProgressPayload = {
  type?: string;
  data?: {
    prompt_id?: string;
    node?: string | null;
    value?: number;
    max?: number;
    nodes?: Record<
      string,
      {
        value?: number;
        max?: number;
        state?: string;
        node_id?: string;
        prompt_id?: string;
      }
    >;
    exception_message?: string;
    exception_type?: string;
  };
};

/**
 * ComfyUI 已明确报告执行失败。
 * 与连接类错误严格区分：不允许回退轮询继续等待，必须立刻判败。
 */
export class ComfyExecutionError extends Error {}

/**
 * 校验 history 条目的健康状态：
 * - status_str === "error"（失败任务 completed=false，只能靠它识别）→ 抛 ComfyExecutionError；
 * - completed 但状态不是 success/completed → 同样判败。
 * 正常执行中 / 成功的条目静默通过。
 */
export function assertHistoryHealthy(item: ComfyHistoryItem): void {
  const statusStr = (item.status?.status_str ?? "").toLowerCase();
  if (statusStr === "error") {
    const detail = extractExecutionMessage(item.status?.messages) ?? JSON.stringify(item.status);
    throw new ComfyExecutionError(`ComfyUI 执行失败：${detail}`);
  }
  if (item.status?.completed && statusStr !== "success" && statusStr !== "completed") {
    throw new ComfyExecutionError(`ComfyUI 执行失败：${JSON.stringify(item.status)}`);
  }
}

/** history 的 messages 形如 [["execution_error", { exception_message, ... }], ...]，取出人类可读错误。 */
export function extractExecutionMessage(messages: unknown[] | undefined): string | null {
  if (!Array.isArray(messages)) return null;
  for (const entry of messages) {
    if (!Array.isArray(entry) || entry[0] !== "execution_error") continue;
    const detail = entry[1] as { exception_message?: unknown; exception_type?: unknown } | undefined;
    if (typeof detail?.exception_message === "string") return detail.exception_message;
    if (typeof detail?.exception_type === "string") return detail.exception_type;
  }
  return null;
}

export function buildStandardPrompt(
  inputName: string,
  modelName: string,
  target: ImageDimensions,
  filenamePrefix: string
): Record<string, unknown> {
  return {
    [NODE.LOAD]: {
      class_type: "LoadImage",
      inputs: { image: inputName }
    },
    [NODE.MODEL]: {
      class_type: "UpscaleModelLoader",
      inputs: { model_name: modelName }
    },
    [NODE.UPSCALE]: {
      class_type: "ImageUpscaleWithModel",
      inputs: {
        upscale_model: [NODE.MODEL, 0],
        image: [NODE.LOAD, 0]
      }
    },
    [NODE.SCALE]: {
      class_type: "ImageScale",
      inputs: {
        image: [NODE.UPSCALE, 0],
        upscale_method: "lanczos",
        width: target.width,
        height: target.height,
        crop: "disabled"
      }
    },
    [NODE.SAVE]: {
      class_type: "SaveImage",
      inputs: {
        images: [NODE.SCALE, 0],
        filename_prefix: filenamePrefix
      }
    }
  };
}

export function describeStandardWorkflow(): string {
  return STANDARD_WORKFLOW_STEPS.map((step) =>
    "detail" in step ? `${step.classType}(${step.detail})` : step.classType
  ).join(" -> ");
}

/**
 * SUPIR 扩散修复参数——逐项照抄本机 CodexSmartEnhance 节点（medium 档）与
 * Codex_AI_Smart_Enhancer_Workflow.json 存档值。注意：这是本机智能增强工作流；
 * 网站生产 ai-enhance 派发的是 ai_4x_ultrasharp 预设（= aiUpscale 模式的 UltraSharp 链），
 * 已经服务器 server.js 派发段核实（2026-07-16）。
 * 影响输出的参数不得改动；keep_model_loaded 是纯运维参数，
 * 桌面版取 false 以便任务后释放显存（不影响画质）。
 */
export const SUPIR_DEFAULTS = {
  supirModel: "SUPIR-v0Q_fp16.safetensors",
  sdxlModel: "sd_xl_base_1.0.safetensors",
  // high 档（steps 25 / cfg 5.0）×4：对齐用户 2026-05-25 亲手跑出并认可的
  // CodexEnhanced_00008/00010 成品的 PNG 元数据参数（enhancement_level=high, upscale_factor=4）。
  steps: 25,
  cfgScale: 5.0,
  controlScale: 0.9,
  restorationScale: 1.0,
  positivePrompt: "high quality, detailed",
  negativePrompt: "bad quality, blurry, messy, noisy",
  seed: 12345,
  maxScale: 4
} as const;

/** SUPIR 修复工作流：LoadImage -> SUPIR_Upscale -> SaveImage。节点 id 复用 NODE 常量，进度映射零改动。 */
export function buildSupirPrompt(inputName: string, scaleBy: number, filenamePrefix: string): Record<string, unknown> {
  return {
    [NODE.LOAD]: {
      class_type: "LoadImage",
      inputs: { image: inputName }
    },
    [NODE.UPSCALE]: {
      class_type: "SUPIR_Upscale",
      inputs: {
        supir_model: SUPIR_DEFAULTS.supirModel,
        sdxl_model: SUPIR_DEFAULTS.sdxlModel,
        image: [NODE.LOAD, 0],
        seed: SUPIR_DEFAULTS.seed,
        resize_method: "lanczos",
        scale_by: scaleBy,
        steps: SUPIR_DEFAULTS.steps,
        restoration_scale: SUPIR_DEFAULTS.restorationScale,
        cfg_scale: SUPIR_DEFAULTS.cfgScale,
        a_prompt: SUPIR_DEFAULTS.positivePrompt,
        n_prompt: SUPIR_DEFAULTS.negativePrompt,
        s_churn: 5,
        s_noise: 1.003,
        control_scale: SUPIR_DEFAULTS.controlScale,
        cfg_scale_start: 4.0,
        control_scale_start: 0.0,
        color_fix_type: "Wavelet",
        keep_model_loaded: false,
        use_tiled_vae: true,
        encoder_tile_size_pixels: 512,
        decoder_tile_size_latent: 64,
        captions: "",
        diffusion_dtype: "auto",
        encoder_dtype: "auto",
        batch_size: 1,
        use_tiled_sampling: true,
        sampler_tile_size: 1024,
        sampler_tile_stride: 512,
        fp8_unet: true,
        fp8_vae: true,
        sampler: "RestoreDPMPP2MSampler"
      }
    },
    [NODE.SAVE]: {
      class_type: "SaveImage",
      inputs: {
        images: [NODE.UPSCALE, 0],
        filename_prefix: filenamePrefix
      }
    }
  };
}

export function describeSupirWorkflow(): string {
  return `LoadImage -> SUPIR_Upscale(${SUPIR_DEFAULTS.supirModel} + ${SUPIR_DEFAULTS.sdxlModel}, steps ${SUPIR_DEFAULTS.steps}, RestoreDPMPP2MSampler, Wavelet) -> SaveImage`;
}

export function buildStandardPromptTemplate(modelName: string): Record<string, unknown> {
  return {
    [NODE.LOAD]: {
      class_type: "LoadImage",
      inputs: { image: "<comfy_input_file>" }
    },
    [NODE.MODEL]: {
      class_type: "UpscaleModelLoader",
      inputs: { model_name: modelName }
    },
    [NODE.UPSCALE]: {
      class_type: "ImageUpscaleWithModel",
      inputs: {
        upscale_model: [NODE.MODEL, 0],
        image: [NODE.LOAD, 0]
      }
    },
    [NODE.SCALE]: {
      class_type: "ImageScale",
      inputs: {
        image: [NODE.UPSCALE, 0],
        upscale_method: "lanczos",
        width: "<target_width>",
        height: "<target_height>",
        crop: "disabled"
      }
    },
    [NODE.SAVE]: {
      class_type: "SaveImage",
      inputs: {
        images: [NODE.SCALE, 0],
        filename_prefix: "<output_prefix>"
      }
    }
  };
}

/** 从 progress_state 事件的 nodes 快照映射出全局百分比（取各节点中最靠后的进度）。 */
export function progressFromState(
  nodes: NonNullable<ComfyProgressPayload["data"]>["nodes"],
  promptId: string
): number | null {
  if (!nodes) return null;
  let best: number | null = null;

  for (const [key, state] of Object.entries(nodes)) {
    if (state.prompt_id && state.prompt_id !== promptId) continue;
    const node = state.node_id || key;
    const value = typeof state.value === "number" ? state.value : null;
    const max = typeof state.max === "number" && state.max > 0 ? state.max : null;
    const ratio =
      state.state === "finished" ? 1 : value != null && max ? value / max : state.state === "running" ? 0 : null;
    if (ratio == null) continue;
    const nodeBase = progressBaseForNode(node);
    const nodeSpan = progressSpanForNode(node);
    const nodeProgress = Math.min(90, nodeBase + Math.round(Math.max(0, Math.min(1, ratio)) * nodeSpan));
    best = best == null ? nodeProgress : Math.max(best, nodeProgress);
  }

  return best;
}

export function progressBaseForNode(node: string): number {
  if (node === NODE.UPSCALE) return 20;
  if (node === NODE.SCALE) return 78;
  if (node === NODE.SAVE) return 88;
  return 15;
}

export function progressSpanForNode(node: string): number {
  if (node === NODE.UPSCALE) return 58;
  if (node === NODE.SCALE) return 10;
  if (node === NODE.SAVE) return 2;
  return 10;
}
