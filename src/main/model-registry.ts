/**
 * 超分模型注册表：纯数据模块（无 electron/网络依赖），
 * model-downloader、settings、渲染层与测试共用同一份真相。
 * SHA256 均为本机权重实测值（2026-07-13），与官方发布一致。
 */

export type UpscaleModelSpec = {
  fileName: string;
  displayName: string;
  sizeBytes: number;
  sha256: string;
  license: string;
  /** 是否允许商用（决定 UI 徽章与发版建议）。 */
  commercial: boolean;
  /** 简短定位说明，帮用户选型。 */
  tagline: string;
  urls: readonly string[];
};

export const UPSCALE_MODEL_REGISTRY: readonly UpscaleModelSpec[] = [
  {
    fileName: "4x-UltraSharp.pth",
    displayName: "4x-UltraSharp",
    sizeBytes: 66_961_958,
    sha256: "a5812231fc936b42af08a5edba784195495d303d5b3248c24489ef0c4021fe01",
    license: "CC-BY-NC-SA 4.0（仅限非商业用途）",
    commercial: false,
    tagline: "网站同款效果，锐利细节",
    urls: [
      "https://hf-mirror.com/lokCX/4x-Ultrasharp/resolve/main/4x-UltraSharp.pth",
      "https://huggingface.co/lokCX/4x-Ultrasharp/resolve/main/4x-UltraSharp.pth"
    ]
  },
  {
    fileName: "RealESRGAN_x4plus.pth",
    displayName: "RealESRGAN x4plus",
    sizeBytes: 67_040_989,
    sha256: "4fa0d38905f75ac06eb49a7951b426670021be3018265fd191d2125df9d682f1",
    license: "BSD 3-Clause（可商用）",
    commercial: true,
    tagline: "通用画质稳定，商用无忧",
    urls: [
      "https://hf-mirror.com/lllyasviel/Annotators/resolve/main/RealESRGAN_x4plus.pth",
      "https://huggingface.co/lllyasviel/Annotators/resolve/main/RealESRGAN_x4plus.pth",
      "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"
    ]
  },
  {
    fileName: "RealESRGAN_x4plus_anime_6B.pth",
    displayName: "RealESRGAN Anime6B",
    sizeBytes: 17_938_799,
    sha256: "f872d837d3c90ed2e05227bed711af5671a6fd1c9f7d7e91c911a61f155e99da",
    license: "BSD 3-Clause（可商用）",
    commercial: true,
    tagline: "动漫/插画专用，线条干净，秒级出图",
    urls: [
      "https://hf-mirror.com/dtarnow/UPscaler/resolve/main/RealESRGAN_x4plus_anime_6B.pth",
      "https://huggingface.co/dtarnow/UPscaler/resolve/main/RealESRGAN_x4plus_anime_6B.pth",
      "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth"
    ]
  }
] as const;

/** 产品默认模型：保持网站同款效果不变。 */
export const DEFAULT_UPSCALE_MODEL = UPSCALE_MODEL_REGISTRY[0]!.fileName;

export function findModelSpec(fileName: string): UpscaleModelSpec | null {
  return UPSCALE_MODEL_REGISTRY.find((spec) => spec.fileName === fileName) ?? null;
}

/** 把任意值规整为注册表内的合法模型文件名；非法值回退默认模型。 */
export function normalizeUpscaleModel(value: unknown): string {
  return typeof value === "string" && findModelSpec(value) ? value : DEFAULT_UPSCALE_MODEL;
}
