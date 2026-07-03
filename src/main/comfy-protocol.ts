import type { ImageDimensions } from "./types.js";

/**
 * ComfyUI 协议层纯逻辑：不依赖 electron / 网络 / 文件系统，
 * 供 comfy-engine 使用，也便于 vitest 直接单测。
 */

/** ComfyUI 工作流节点 id：buildStandardPrompt、进度映射、取输出共用，改工作流时单点维护。 */
export const NODE = { LOAD: "1", MODEL: "2", UPSCALE: "3", SCALE: "4", SAVE: "5" } as const;

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
    const ratio = state.state === "finished" ? 1 : value != null && max ? value / max : state.state === "running" ? 0 : null;
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
