import { describe, expect, it } from "vitest";
import { normalizeImageTask, parseImagesResponse, sanitizeImageParams } from "../src/main/cloud/image-protocol";

describe("parseImagesResponse", () => {
  it("兼容 b64_json 与 url 混合返回", () => {
    const payload = { data: [{ b64_json: "abc" }, { url: "https://x/1.png" }, { other: 1 }, null] };
    expect(parseImagesResponse(payload)).toEqual([{ b64: "abc", url: undefined }, { b64: undefined, url: "https://x/1.png" }]);
  });

  it("非法结构返回空数组", () => {
    expect(parseImagesResponse(null)).toEqual([]);
    expect(parseImagesResponse({ data: "x" })).toEqual([]);
  });
});

describe("sanitizeImageParams", () => {
  it("空 prompt 或空 model 拒绝开任务", () => {
    expect(sanitizeImageParams({ model: "m", prompt: "  " })).toBeNull();
    expect(sanitizeImageParams({ model: "", prompt: "hi" })).toBeNull();
    expect(sanitizeImageParams(null)).toBeNull();
  });

  it("size 白名单校验、count 夹到 1-4", () => {
    expect(sanitizeImageParams({ model: "m", prompt: "p", size: "bad", count: 99 })).toEqual({
      model: "m",
      prompt: "p",
      size: "1024x1024",
      count: 4
    });
    expect(sanitizeImageParams({ model: "m", prompt: "p", size: "1536x1024", count: 0 })).toEqual({
      model: "m",
      prompt: "p",
      size: "1536x1024",
      count: 1
    });
  });
});

describe("normalizeImageTask", () => {
  const base = { id: "t1", params: { model: "m", prompt: "p" }, createdAt: 1 };

  it("上次退出时仍在 running/queued 的任务标记为已中断", () => {
    const task = normalizeImageTask({ ...base, status: "running" }, 999)!;
    expect(task.status).toBe("cancelled");
    expect(task.message).toContain("已停止");
    expect(task.finishedAt).toBe(999);
  });

  it("终态任务保留输出路径，过滤非法项", () => {
    const task = normalizeImageTask({ ...base, status: "succeeded", outputPaths: ["a.png", 3, ""] })!;
    expect(task.status).toBe("succeeded");
    expect(task.outputPaths).toEqual(["a.png"]);
  });

  it("缺少必要字段返回 null", () => {
    expect(normalizeImageTask({ id: "x" })).toBeNull();
    expect(normalizeImageTask({ ...base, params: { model: "m", prompt: "" } })).toBeNull();
  });
});
