import { describe, expect, it } from "vitest";
import {
  RelayError,
  classifyRelayError,
  extractApiErrorMessage,
  isTransientRelayError,
  maskKey,
  parseModelsResponse,
  parseSubscriptionUsd,
  parseUsageUsd
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
});

describe("maskKey", () => {
  it("只留前缀与末 4 位", () => {
    expect(maskKey("sk-abcdefghijklmnop")).toBe("sk-ab…mnop");
    expect(maskKey("short")).toBe("sk-****");
  });
});
