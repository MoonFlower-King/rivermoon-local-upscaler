import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgentResponse } from "../src/main/cloud/agent-gen";
import type { AgentChatRequest } from "../src/main/types";

describe("agent responses gateway e2e", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("按站点同款 /v1/responses 流式提交并读取增量", async () => {
    const deltas: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://img.rivermoon7.com/v1/responses");
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-key");
        expect(new Headers(init?.headers).get("Accept")).toBe("text/event-stream");
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "gpt-5.5",
          stream: true,
          reasoning_effort: "medium",
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "hello" }]
            }
          ]
        });
        return new Response(
          streamFromText(
            'data: {"type":"response.output_text.delta","delta":"你"}\n\ndata: {"type":"response.output_text.delta","delta":"好"}\n\ndata: {"type":"response.completed","response":{"output":[]}}\n\n'
          ),
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream" }
          }
        );
      })
    );

    const content = await runAgentResponse(agentRequest(), "test-key", new AbortController().signal, (delta) =>
      deltas.push(delta)
    );

    expect(content).toBe("你好");
    expect(deltas).toEqual(["你", "好"]);
  });

  it("非 2xx 响应会转成中文 RelayError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
            status: 401,
            headers: { "Content-Type": "application/json" }
          })
      )
    );

    await expect(
      runAgentResponse(agentRequest(), "bad-key", new AbortController().signal, () => undefined)
    ).rejects.toThrow("API Key 无效");
  });
});

function agentRequest(): AgentChatRequest {
  return {
    requestId: "req_1",
    model: "gpt-5.5",
    reasoningEffort: "medium",
    messages: [{ id: "m1", role: "user", content: "hello", createdAt: 1 }]
  };
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    }
  });
}
