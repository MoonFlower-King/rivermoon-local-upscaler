import sharp from "sharp";
import { loadKey } from "./cloud/key-store.js";
import { relayFetchJson } from "./cloud/relay-client.js";
import { log } from "./logger.js";

/**
 * 智能模式（aiAuto）的 GPT 分流：复刻本机 CodexSmartEnhance 节点的 _analyze_image——
 * 图片缩到 512 长边 JPEG q80，发 /v1/chat/completions（gpt-5.5，temperature 0），
 * 由模型返回 分类/管线/提示词/强度。提示词原文逐字照抄节点，勿改动。
 * 失败或未连接 Key 时回退 realesrgan_general（与节点的 fallback_decision 一致）。
 */

export type SmartPipeline = "supir" | "realesrgan_anime" | "realesrgan_general";

export type SmartDecision = {
  category: string;
  reasoning: string;
  recommendedPipeline: SmartPipeline;
  positivePrompt: string;
  negativePrompt: string;
  controlScale: number;
  restorationScale: number;
  /** true = 未走 GPT（无 Key/网络失败），按安全默认路由。 */
  fallback: boolean;
};

export const SMART_ROUTE_MODELS: Record<Exclude<SmartPipeline, "supir">, string> = {
  realesrgan_anime: "RealESRGAN_x4plus_anime_6B.pth",
  realesrgan_general: "RealESRGAN_x4plus.pth"
};

const ANALYZE_MODEL = "gpt-5.5";
const ANALYZE_TIMEOUT_MS = 20_000;

const ANALYZE_PROMPT = `
    You are an expert AI image restoration engineer. Analyze the provided image to decide the best enhancement pipeline and parameters.

    CRITICAL: You MUST write the "reasoning" key in Chinese (中文) to explain in detail:
    1. What is in the image (subject, texture, content).
    2. The quality of the image (lighting, clarity, noise, compression artifacts).
    3. Why you chose this specific model/pipeline (e.g., SUPIR for realistic photo detail reconstruction, Real-ESRGAN Anime to preserve flat illustration outlines and avoid realistic texture hallucination, or Real-ESRGAN General for UI/text).

    All other keys (category, recommended_pipeline, positive_prompt, negative_prompt) MUST remain in English because the downstream diffusion/ESRGAN models only understand English prompts.

    Respond with ONLY a valid JSON object (do not include markdown wrapping or other text) in the following format:
    {
      "category": "photo" or "anime" or "text",
      "reasoning": "用中文详细描述图像内容、光影、清晰度、噪声情况，以及为什么选择该精修模型和工作流管道。",
      "recommended_pipeline": "supir" or "realesrgan_anime" or "realesrgan_general",
      "positive_prompt": "A detailed descriptive prompt in English for a diffusion model to reconstruct details (e.g. 'sharp portrait, skin pores, detailed eyes' or 'beautiful landscape, sharp foliage, clean water'). Describe what is in the image, keeping it realistic.",
      "negative_prompt": "bad quality, blurry, low-res, noisy, jpeg compression artifacts, distorted face, bad anatomy, deformed",
      "control_scale": 0.85,  // A float between 0.70 and 1.00. Use lower values (0.7-0.85) if the image is extremely blurry and needs the AI to reinvent details. Use higher values (0.9-1.0) if the image is already sharp and we want to preserve its structure exactly.
      "restoration_scale": 1.0 // A float between -1.0 and 4.0. Lower values mean less correction, higher values mean stronger correction of compression/noise. Use 1.0 or 2.0 as default, or 4.0 for high noise.
    }

    Guidelines for recommended_pipeline:
    1. "supir": Choose for real-life photos, 3D renders, landscapes, human portraits, objects, and any image where you want to reconstruct textures, improve lighting, enhance depth, and add realistic details.
    2. "realesrgan_anime": Choose for 2D anime illustrations, cartoons, digital drawings with flat coloring and clear outlines. SUPIR will ruin 2D anime by adding realistic 3D textures.
    3. "realesrgan_general": Choose for screenshots, text, documents, logos, line art, diagrams, UI interfaces. SUPIR will hallucinate and scramble text and vector elements.
    `;

export function fallbackDecision(reason: string): SmartDecision {
  return {
    category: "photo",
    reasoning: reason,
    recommendedPipeline: "realesrgan_general",
    positivePrompt: "high quality, detailed, sharp",
    negativePrompt: "bad quality, blurry, messy, noisy, low-res",
    controlScale: 0.9,
    restorationScale: 1.0,
    fallback: true
  };
}

/** 解析 GPT 返回的决策 JSON：剥 ``` 围栏、补默认值、夹参数范围。非法输入抛错由调用方回退。 */
export function parseSmartDecision(content: string): SmartDecision {
  let text = content.trim();
  if (text.startsWith("```")) {
    const lines = text.split("\n");
    if (lines[0]?.startsWith("```")) lines.shift();
    if (lines[lines.length - 1]?.startsWith("```")) lines.pop();
    text = lines.join("\n").trim();
  }
  const parsed = JSON.parse(text) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object") throw new Error("决策响应不是 JSON 对象");

  const pipeline = parsed.recommended_pipeline;
  const clamp = (value: unknown, min: number, max: number, fallbackValue: number) => {
    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallbackValue;
  };
  return {
    category: typeof parsed.category === "string" ? parsed.category : "photo",
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "Parsed response successfully.",
    recommendedPipeline:
      pipeline === "supir" || pipeline === "realesrgan_anime" || pipeline === "realesrgan_general"
        ? pipeline
        : "realesrgan_general",
    positivePrompt: typeof parsed.positive_prompt === "string" ? parsed.positive_prompt : "high quality, detailed",
    negativePrompt:
      typeof parsed.negative_prompt === "string" ? parsed.negative_prompt : "bad quality, blurry, messy, noisy",
    controlScale: clamp(parsed.control_scale, 0.7, 1.0, 0.9),
    restorationScale: clamp(parsed.restoration_scale, -1.0, 4.0, 1.0),
    fallback: false
  };
}

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
};

export async function analyzeImageForRoute(inputPath: string, signal?: AbortSignal): Promise<SmartDecision> {
  const key = loadKey();
  if (!key) return fallbackDecision("未连接中转 Key，已按通用模型处理（连接 Key 后智能模式才会让 GPT 看图分流）。");

  try {
    const buffer = await sharp(inputPath)
      .rotate()
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    const payload = {
      model: ANALYZE_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: ANALYZE_PROMPT },
            { type: "image_url", image_url: { url: `data:image/jpeg;base64,${buffer.toString("base64")}` } }
          ]
        }
      ],
      temperature: 0.0,
      max_tokens: 500
    };
    const response = await relayFetchJson<ChatCompletionResponse>(
      "/v1/chat/completions",
      key,
      { method: "POST", body: JSON.stringify(payload), signal },
      ANALYZE_TIMEOUT_MS
    );
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error("GPT 未返回内容");
    return parseSmartDecision(content);
  } catch (error) {
    if (signal?.aborted) throw new Error("任务已取消。", { cause: error });
    const detail = error instanceof Error ? error.message : String(error);
    log(`智能模式 GPT 分析失败，回退通用模型：${detail}`);
    return fallbackDecision(`GPT 分析失败（${detail}），已按通用模型处理。`);
  }
}
