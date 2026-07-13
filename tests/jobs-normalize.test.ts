import { describe, expect, it } from "vitest";
import { normalizeDuration, normalizeJob, stableJobsForDisk } from "../src/main/jobs-normalize";

describe("normalizeDuration", () => {
  it("合法数值取整且非负", () => {
    expect(normalizeDuration(1234.6, null, null)).toBe(1235);
    expect(normalizeDuration(-5, null, null)).toBe(0);
  });

  it("无值时用 started/finished 差值，缺一则 null", () => {
    expect(normalizeDuration(null, 1000, 3000)).toBe(2000);
    expect(normalizeDuration(undefined, null, 3000)).toBeNull();
  });
});

describe("normalizeJob", () => {
  it("缺少必要字段返回 null", () => {
    expect(normalizeJob(null)).toBeNull();
    expect(normalizeJob({ id: "a" })).toBeNull();
  });

  it("running/queued 视为上次中断 → cancelled、进度 100", () => {
    const job = normalizeJob({ id: "a", inputPath: "x", fileName: "x.png", status: "running", createdAt: 1 }, 999);
    expect(job?.status).toBe("cancelled");
    expect(job?.progress).toBe(100);
    expect(job?.message).toContain("已停止");
  });

  it("丢弃旧字段 tileSize，outputBytes 规整为非负数或 null", () => {
    const job = normalizeJob({
      id: "a",
      inputPath: "x",
      fileName: "x.png",
      status: "succeeded",
      createdAt: 1,
      tileSize: 512,
      outputBytes: -5
    })!;
    expect("tileSize" in job).toBe(false);
    expect(job.outputBytes).toBe(0);

    const job2 = normalizeJob({
      id: "a",
      inputPath: "x",
      fileName: "x.png",
      status: "succeeded",
      createdAt: 1,
      outputBytes: 1234
    })!;
    expect(job2.outputBytes).toBe(1234);

    const job3 = normalizeJob({ id: "a", inputPath: "x", fileName: "x.png", status: "succeeded", createdAt: 1 })!;
    expect(job3.outputBytes).toBeNull();
  });

  it("保留终态任务并补算 durationMs 与合法 settings", () => {
    const job = normalizeJob({
      id: "a",
      inputPath: "x",
      fileName: "x.png",
      status: "succeeded",
      createdAt: 1,
      startedAt: 10,
      finishedAt: 30
    });
    expect(job?.status).toBe("succeeded");
    expect(job?.durationMs).toBe(20);
    expect(job?.settings).toEqual({
      processingMode: "aiUpscale",
      outputFormat: "png",
      outputDirectory: null,
      maxSide: 4096,
      upscaleModel: "4x-UltraSharp.pth"
    });
  });
});

describe("stableJobsForDisk", () => {
  it("按 createdAt 倒序排列", () => {
    const make = (id: string, createdAt: number) =>
      normalizeJob({ id, inputPath: "x", fileName: "x.png", status: "succeeded", createdAt })!;
    const result = stableJobsForDisk([make("a", 1), make("b", 3), make("c", 2)]);
    expect(result.map((job) => job.id)).toEqual(["b", "c", "a"]);
  });

  it("把仍在 running 的任务落盘为 cancelled", () => {
    const running = normalizeJob({ id: "r", inputPath: "x", fileName: "x.png", status: "succeeded", createdAt: 1 })!;
    running.status = "running";
    const [stored] = stableJobsForDisk([running], 12345);
    expect(stored.status).toBe("cancelled");
    expect(stored.finishedAt).toBe(12345);
  });
});
