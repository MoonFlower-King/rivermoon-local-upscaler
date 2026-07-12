import type { VideoEndpoint } from "../main/types";

export type VideoSubmitStateInput = {
  connected: boolean;
  contractReady: boolean;
  contractFresh: boolean;
  hasModel: boolean;
  prompt: string;
  endpoint: VideoEndpoint;
  referenceCapacityOk: boolean;
  referenceReady: boolean;
  referenceCountOk: boolean;
  requiredReferenceCount: number;
  referenceCount: number;
  referenceLimit: number;
};

export function videoSubmitBlockReason(input: VideoSubmitStateInput): string | null {
  if (!input.connected) return "请先连接账户。";
  if (!input.contractReady) return "视频合同暂不可用，请同步合同后重试。";
  if (!input.contractFresh) return "当前不是 HTTPS 实时合同，请先同步合同。";
  if (!input.hasModel) return "请选择可用视频模型。";
  if (!input.prompt.trim()) return "请填写视频描述。";
  if (!input.referenceCapacityOk) return "当前模型参考图上限不足以使用该模式，请切换模型或同步合同。";
  if (!input.referenceReady) {
    if (input.endpoint === "first_last_frame") {
      return `首尾帧模式需要 ${input.requiredReferenceCount} 张参考图。`;
    }
    return "当前视频模式需要至少 1 张参考图。";
  }
  if (!input.referenceCountOk) {
    return `参考图数量超过当前模型上限（${input.referenceLimit} 张），请删除多余素材。`;
  }
  return null;
}
