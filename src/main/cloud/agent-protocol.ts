import crypto from "node:crypto";
import type { AgentAttachment, AgentChatRequest, AgentMessage, AgentReasoningEffort, AgentRole } from "../types.js";

export const AGENT_GATEWAY_BASE_URL = "https://img.rivermoon7.com";
export const DEFAULT_AGENT_MODEL = "gpt-5.5";
export const DEFAULT_AGENT_REASONING_EFFORT: AgentReasoningEffort = "medium";
export const AGENT_REASONING_EFFORTS: AgentReasoningEffort[] = ["auto", "low", "medium", "high", "xhigh"];
export const DEFAULT_AGENT_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2"];

const MAX_AGENT_MESSAGES = 120;
const MAX_AGENT_PROMPT_CHARS = 20_000;
const MAX_AGENT_ATTACHMENTS_PER_MESSAGE = 4;
const MAX_AGENT_ATTACHMENT_DATA_URL_CHARS = 8 * 1024 * 1024;

export type AgentStreamEvent =
  | { type: "delta"; delta: string; final?: boolean }
  | { type: "completed"; outputText?: string }
  | { type: "error"; error: string };

export function sanitizeAgentChatRequest(input: unknown): AgentChatRequest | null {
  const raw = input && typeof input === "object" ? (input as Partial<AgentChatRequest>) : {};
  const requestId = typeof raw.requestId === "string" ? raw.requestId.trim().slice(0, 80) : "";
  const model = sanitizeAgentModel(raw.model);
  const reasoningEffort = sanitizeAgentReasoningEffort(raw.reasoningEffort);
  const messages = Array.isArray(raw.messages)
    ? raw.messages
        .map(sanitizeAgentMessage)
        .filter((message): message is AgentMessage => Boolean(message))
        .slice(-MAX_AGENT_MESSAGES)
    : [];
  if (!requestId || messages.length === 0 || !messages.some((message) => message.role === "user")) return null;
  return { requestId, model, reasoningEffort, messages };
}

export function sanitizeAgentModel(value: unknown): string {
  const model = typeof value === "string" ? value.trim() : "";
  return model && !isNonAgentModel(model) ? model.slice(0, 120) : DEFAULT_AGENT_MODEL;
}

export function sanitizeAgentReasoningEffort(value: unknown): AgentReasoningEffort {
  return typeof value === "string" && AGENT_REASONING_EFFORTS.includes(value as AgentReasoningEffort)
    ? (value as AgentReasoningEffort)
    : DEFAULT_AGENT_REASONING_EFFORT;
}

export function filterAgentModels(models: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const model of models) {
    const id = sanitizeAgentModel(model);
    if (!id || seen.has(id) || isNonAgentModel(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result.length > 0 ? result : DEFAULT_AGENT_MODELS;
}

export function buildAgentResponsePayload(request: AgentChatRequest): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: request.model || DEFAULT_AGENT_MODEL,
    stream: true,
    input: request.messages.map((message) => ({
      role: message.role,
      content: agentContentParts(message)
    }))
  };
  if (request.reasoningEffort !== "auto") payload.reasoning_effort = request.reasoningEffort;
  return payload;
}

export function parseAgentSseEvents(text: string): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  for (const block of text.split(/\n\n+/)) {
    const payload = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!payload) continue;
    if (payload === "[DONE]") {
      events.push({ type: "completed" });
      continue;
    }
    try {
      const parsed = JSON.parse(payload) as {
        type?: unknown;
        delta?: unknown;
        text?: unknown;
        response?: unknown;
        error?: unknown;
      };
      const type = typeof parsed.type === "string" ? parsed.type : "";
      if (type === "response.output_text.delta" && typeof parsed.delta === "string") {
        events.push({ type: "delta", delta: parsed.delta });
      } else if (type === "response.output_text.done") {
        const textValue = typeof parsed.text === "string" ? parsed.text : "";
        if (textValue) events.push({ type: "delta", delta: textValue, final: true });
      } else if (type === "response.completed") {
        events.push({ type: "completed", outputText: extractCompletedOutputText(parsed.response) });
      } else if (type === "error") {
        events.push({ type: "error", error: extractAgentError(parsed.error) ?? "GPT 请求失败" });
      }
    } catch {
      if (payload.trim().endsWith("}")) events.push({ type: "error", error: "无法解析 GPT 响应。" });
    }
  }
  return events;
}

export function extractCompletedOutputText(response: unknown): string {
  const output = response && typeof response === "object" ? (response as { output?: unknown }).output : null;
  if (!Array.isArray(output)) return "";
  return output
    .flatMap((item) => {
      const content = item && typeof item === "object" ? (item as { content?: unknown }).content : null;
      return Array.isArray(content) ? content : [];
    })
    .map((item) => (item && typeof item === "object" ? (item as { text?: unknown }).text : null))
    .filter((text): text is string => typeof text === "string" && text.length > 0)
    .join("");
}

function sanitizeAgentMessage(value: unknown): AgentMessage | null {
  const raw = value && typeof value === "object" ? (value as Partial<AgentMessage>) : {};
  const role = sanitizeAgentRole(raw.role);
  if (!role) return null;
  const content = typeof raw.content === "string" ? raw.content.slice(0, MAX_AGENT_PROMPT_CHARS) : "";
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments
        .map(sanitizeAgentAttachment)
        .filter((attachment): attachment is AgentAttachment => Boolean(attachment))
        .slice(0, MAX_AGENT_ATTACHMENTS_PER_MESSAGE)
    : [];
  if (!content.trim() && attachments.length === 0) return null;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id.slice(0, 80) : crypto.randomUUID(),
    role,
    content,
    createdAt: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    attachments
  };
}

function sanitizeAgentRole(value: unknown): AgentRole | null {
  return value === "user" || value === "assistant" ? value : null;
}

function sanitizeAgentAttachment(value: unknown): AgentAttachment | null {
  const raw = value && typeof value === "object" ? (value as Partial<AgentAttachment>) : {};
  const mimeType = typeof raw.mimeType === "string" ? raw.mimeType.trim().toLowerCase() : "";
  const dataUrl = typeof raw.dataUrl === "string" ? raw.dataUrl : "";
  if (!mimeType.startsWith("image/")) return null;
  if (!dataUrl.startsWith(`data:${mimeType};base64,`)) return null;
  if (dataUrl.length > MAX_AGENT_ATTACHMENT_DATA_URL_CHARS) return null;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id.slice(0, 80) : crypto.randomUUID(),
    name: typeof raw.name === "string" ? raw.name.slice(0, 180) : "image.jpg",
    mimeType,
    dataUrl,
    width: finitePositive(raw.width),
    height: finitePositive(raw.height),
    size: finitePositive(raw.size)
  };
}

function agentContentParts(message: AgentMessage): Array<Record<string, string>> {
  if (message.role === "assistant") return [{ type: "output_text", text: message.content || "" }];
  const parts: Array<Record<string, string>> = [];
  if (message.content.trim()) parts.push({ type: "input_text", text: message.content });
  for (const attachment of message.attachments ?? []) {
    if (
      attachment.mimeType.startsWith("image/") &&
      attachment.dataUrl.startsWith(`data:${attachment.mimeType};base64,`)
    ) {
      parts.push({ type: "input_image", image_url: attachment.dataUrl });
    }
  }
  if (parts.length === 0) parts.push({ type: "input_text", text: message.content || "" });
  return parts;
}

function isNonAgentModel(model: string): boolean {
  const value = model.toLowerCase();
  return (
    value === "image2.0" ||
    value === "image2.0-4k" ||
    value === "gpt-image-2" ||
    value.includes("image") ||
    value.includes("grok-imagine") ||
    value.includes("dall-e") ||
    value.includes("midjourney") ||
    value.includes("sora") ||
    value.includes("video") ||
    value.includes("embedding") ||
    value.includes("rerank") ||
    value.includes("whisper") ||
    /^image/.test(value)
  );
}

function extractAgentError(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim().slice(0, 300);
  if (value && typeof value === "object") {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 300);
  }
  return null;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}
