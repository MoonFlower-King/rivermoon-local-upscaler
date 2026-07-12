import { describe, expect, it } from "vitest";
import {
  RelayError,
  classifyRelayError,
  extractApiErrorMessage,
  isTransientRelayError,
  maskKey,
  parseModelsResponse,
  parseSubscriptionUsd,
  parseUsageUsd,
  shouldRetryTransientRelayError
} from "../src/main/cloud/relay-protocol";

describe("classifyRelayError", () => {
  it("401/403 → auth（提示检查 Key）", () => {
    expect(classifyRelayError(401, "").kind).toBe("auth");
    expect(classifyRelayError(403, "").kind).toBe("auth");
  });

  it("响应体含 quota/insufficient → quota（UI 追加充值引导）", () => {
    expect(classifyRelayError(400, '{"error":{"message":"insufficient quota"}}').kind).toBe("quota");
    expect(classifyRelayError(402, "账户余额不足").kind).toBe("quota");
  });

  it("429 → rate，5xx → server", () => {
    expect(classifyRelayError(429, "").kind).toBe("rate");
    expect(classifyRelayError(503, "").kind).toBe("server");
  });

  it("其他错误带出 OpenAI 风格 message", () => {
    const error = classifyRelayError(400, '{"error":{"message":"invalid size"}}');
    expect(error.kind).toBe("bad-response");
    expect(error.message).toContain("invalid size");
  });
});

describe("extractApiErrorMessage", () => {
  it("兼容 error.message / error 字符串 / 顶层 message / 纯文本", () => {
    expect(extractApiErrorMessage('{"error":{"message":"m1"}}')).toBe("m1");
    expect(extractApiErrorMessage('{"error":"m2"}')).toBe("m2");
    expect(extractApiErrorMessage('{"message":"m3"}')).toBe("m3");
    expect(extractApiErrorMessage("plain text")).toBe("plain text");
    expect(extractApiErrorMessage("")).toBeNull();
  });

  it("脱敏 Key、签名 URL query 和本地路径后再展示", () => {
    const message =
      "failed https://cdn.example.com/out/video.mp4?token=secret&signature=abc with sk-test_1234567890abcdef at C:\\Users\\Alice\\Pictures\\ref.png";

    expect(extractApiErrorMessage(JSON.stringify({ error: { message } }))).toBe(
      "failed https://cdn.example.com/out/video.mp4?... with sk-*** at [本地路径]\\ref.png"
    );
  });

  it("HTML 错误页不进入用户可见错误详情", () => {
    const html =
      "<!doctype html><html><body>upstream failed sk-test_1234567890abcdef C:\\Users\\Alice\\Pictures\\ref.png</body></html>";

    expect(extractApiErrorMessage(html)).toBe("上游返回 HTML 错误页");
    expect(classifyRelayError(400, html).message).toBe("请求被拒绝：上游返回 HTML 错误页");
  });

  it("错误详情里疑似 prompt 的内容会被压缩脱敏", () => {
    expect(extractApiErrorMessage('{"message":"prompt: a private client prompt with sensitive scene details"}')).toBe(
      "prompt: [prompt]"
    );
    expect(extractApiErrorMessage('{"error":"bad prompt a cinematic long prompt with private client context"}')).toBe(
      "bad prompt [prompt]"
    );
  });

  it("长错误详情最多展示 200 字符", () => {
    const detail = extractApiErrorMessage("x".repeat(250));

    expect(detail).toHaveLength(200);
  });
});

describe("parseModelsResponse", () => {
  it("提取 id 列表并排序去重", () => {
    const payload = { data: [{ id: "b" }, { id: "a" }, { id: "b" }, { notId: 1 }, null] };
    expect(parseModelsResponse(payload)).toEqual(["a", "b"]);
  });

  it("非法结构返回空数组", () => {
    expect(parseModelsResponse(null)).toEqual([]);
    expect(parseModelsResponse({ data: "x" })).toEqual([]);
  });
});

describe("billing 解析", () => {
  it("subscription 取 hard_limit_usd；usage 按 0.01 USD 换算", () => {
    expect(parseSubscriptionUsd({ hard_limit_usd: 12.5 })).toBe(12.5);
    expect(parseSubscriptionUsd({})).toBeNull();
    expect(parseUsageUsd({ total_usage: 18 })).toBe(0.18);
    expect(parseUsageUsd({})).toBeNull();
  });
});

describe("isTransientRelayError", () => {
  it("server/rate/network 可重试；quota/auth/其他错误不可", () => {
    expect(isTransientRelayError(new RelayError("server", "x"))).toBe(true);
    expect(isTransientRelayError(new RelayError("rate", "x"))).toBe(true);
    expect(isTransientRelayError(new RelayError("network", "x"))).toBe(true);
    expect(isTransientRelayError(new RelayError("quota", "x"))).toBe(false);
    expect(isTransientRelayError(new RelayError("auth", "x"))).toBe(false);
    expect(isTransientRelayError(new Error("x"))).toBe(false);
  });

  it("瞬时错误只在重试阈值内继续重试", () => {
    const error = new RelayError("network", "x");

    expect(shouldRetryTransientRelayError(error, 0, 5)).toBe(true);
    expect(shouldRetryTransientRelayError(error, 4, 5)).toBe(true);
    expect(shouldRetryTransientRelayError(error, 5, 5)).toBe(false);
    expect(shouldRetryTransientRelayError(new RelayError("quota", "x"), 0, 5)).toBe(false);
    expect(shouldRetryTransientRelayError(error, -1, 5)).toBe(false);
  });
});

describe("maskKey", () => {
  it("只留前缀与末 4 位", () => {
    expect(maskKey("sk-abcdefghijklmnop")).toBe("sk-ab…mnop");
    expect(maskKey("short")).toBe("sk-****");
  });
});
