import { RelayError, classifyRelayError } from "./relay-protocol.js";
import {
  AGENT_GATEWAY_BASE_URL,
  buildAgentResponsePayload,
  parseAgentSseEvents,
  sanitizeAgentChatRequest
} from "./agent-protocol.js";
import type { AgentChatRequest } from "../types.js";

const AGENT_TIMEOUT_MS = 5 * 60 * 1000;

export async function runAgentResponse(
  request: AgentChatRequest,
  key: string,
  signal: AbortSignal,
  onDelta: (delta: string) => void
): Promise<string> {
  const clean = sanitizeAgentChatRequest(request);
  if (!clean) throw new RelayError("bad-response", "GPT 对话参数无效。");

  const response = await agentGatewayFetch("/v1/responses", key, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream"
    },
    body: JSON.stringify(buildAgentResponsePayload(clean)),
    signal: AbortSignal.any([signal, AbortSignal.timeout(AGENT_TIMEOUT_MS)])
  });

  if (!response.body) throw new RelayError("bad-response", "GPT 网关没有返回流式响应。");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let sawDelta = false;
  let completed = false;

  const consume = (text: string) => {
    for (const event of parseAgentSseEvents(text)) {
      if (event.type === "error") throw new RelayError("bad-response", event.error);
      if (event.type === "delta") {
        const delta = event.final && sawDelta ? "" : event.delta;
        if (!delta) continue;
        sawDelta = true;
        output += delta;
        onDelta(delta);
      }
      if (event.type === "completed") {
        completed = true;
        if (!sawDelta && event.outputText) {
          output += event.outputText;
          onDelta(event.outputText);
        }
      }
    }
  };

  try {
    while (!completed) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const boundary = buffer.lastIndexOf("\n\n");
      if (boundary < 0) continue;
      const chunk = buffer.slice(0, boundary + 2);
      buffer = buffer.slice(boundary + 2);
      consume(chunk);
    }
    if (!completed && buffer.trim()) consume(buffer);
  } finally {
    if (signal.aborted) await reader.cancel().catch(() => undefined);
  }

  return output;
}

async function agentGatewayFetch(pathname: string, key: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${key}`);
    response = await fetch(`${AGENT_GATEWAY_BASE_URL}${pathname}`, {
      ...init,
      headers
    });
  } catch (error) {
    if (error instanceof DOMException) throw error;
    throw new RelayError("network", "无法连接 GPT 对话网关，请检查网络。");
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw classifyRelayError(response.status, bodyText);
  }
  return response;
}
