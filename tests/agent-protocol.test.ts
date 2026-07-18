import { describe, expect, it } from "vitest";
import {
  buildAgentResponsePayload,
  filterAgentModels,
  parseAgentSseEvents,
  sanitizeAgentChatRequest
} from "../src/main/cloud/agent-protocol";

describe("agent protocol", () => {
  it("过滤非对话模型并保留站点同款 GPT 模型", () => {
    expect(filterAgentModels(["gpt-image-2", "video-v1", "gpt-5.5", "embedding-1", "gpt-5.4-mini"])).toEqual([
      "gpt-5.5",
      "gpt-5.4-mini"
    ]);
  });

  it("构造 /v1/responses 请求体，支持图片输入和 reasoning_effort", () => {
    const request = sanitizeAgentChatRequest({
      requestId: "req_1",
      model: "gpt-5.5",
      reasoningEffort: "high",
      messages: [
        {
          id: "m1",
          role: "user",
          content: "分析图片",
          createdAt: 1,
          attachments: [
            {
              id: "a1",
              name: "image.jpg",
              mimeType: "image/jpeg",
              dataUrl: "data:image/jpeg;base64,abc"
            }
          ]
        },
        { id: "m2", role: "assistant", content: "好的", createdAt: 2 }
      ]
    })!;

    expect(buildAgentResponsePayload(request)).toEqual({
      model: "gpt-5.5",
      stream: true,
      reasoning_effort: "high",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "分析图片" },
            { type: "input_image", image_url: "data:image/jpeg;base64,abc" }
          ]
        },
        { role: "assistant", content: [{ type: "output_text", text: "好的" }] }
      ]
    });
  });

  it("解析 Responses SSE 增量、完成和错误事件", () => {
    expect(
      parseAgentSseEvents(
        [
          'data: {"type":"response.output_text.delta","delta":"你"}',
          "",
          'data: {"type":"response.output_text.delta","delta":"好"}',
          "",
          'data: {"type":"response.completed","response":{"output":[]}}',
          "",
          ""
        ].join("\n")
      )
    ).toEqual([
      { type: "delta", delta: "你" },
      { type: "delta", delta: "好" },
      { type: "completed", outputText: "" }
    ]);

    expect(parseAgentSseEvents('data: {"type":"error","error":{"message":"bad"}}\n\n')).toEqual([
      { type: "error", error: "bad" }
    ]);
  });
});
