import { describe, expect, it } from "vitest";
import { videoTaskDiagnosticText } from "../src/renderer/video-diagnostics";
import type { VideoGenTask } from "../src/main/types";

function videoTask(overrides: Partial<VideoGenTask> = {}): VideoGenTask {
  return {
    id: "local_task",
    params: {
      model: "videos_stable",
      prompt: "a private cinematic prompt",
      endpoint: "reference_to_video",
      requestEndpoint: "multi_reference",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: ["C:\\Users\\Alice\\Pictures\\first.png", "D:\\Private\\style.png"],
      referenceType: "ordinary",
      referenceTypes: ["ordinary", "style"]
    },
    status: "failed",
    createdAt: 0,
    startedAt: 1000,
    finishedAt: 5000,
    durationMs: 4000,
    message:
      "远端返回 a private cinematic prompt，参考图 C:\\Users\\Alice\\Pictures\\first.png，下载 https://cdn.example.com/video.mp4?signature=secret",
    error: "Key sk-test_1234567890abcdef failed at D:\\Private\\style.png 请重试",
    needsTopup: false,
    progress: 42,
    remoteJobId: "vjob_1",
    requestId: "req_1",
    clientRequestId: "client_request_1234567890abcdef",
    dryRun: false,
    outputPath: "C:\\Users\\Alice\\Videos\\out.mp4",
    outputBytes: 1024,
    contentUrl: "https://video.rivermoon7.com/v1/video/jobs/vjob_1/content?token=secret",
    downloadUrl: "https://cdn.example.com/video.mp4?signature=secret",
    costUsd: 0.1,
    estimatedCostUsd: 0.12,
    charged: true,
    refunded: false,
    ...overrides
  };
}

describe("renderer video diagnostics", () => {
  it("复制视频任务诊断时不包含完整 prompt、本地路径、Key 或签名 URL query", () => {
    const text = videoTaskDiagnosticText(videoTask());
    const payload = JSON.parse(text) as Record<string, unknown>;

    expect(payload).toMatchObject({
      kind: "rivermoon-video-task",
      local_task_id: "local_...task",
      remote_job_id: "vjob_1",
      request_id: "req_1",
      client_request_id: "client...cdef",
      reference_count: 2,
      reference_types: ["ordinary", "style"],
      prompt_length: "a private cinematic prompt".length,
      output_file: "out.mp4"
    });
    expect(payload).not.toHaveProperty("prompt");
    expect(payload).not.toHaveProperty("reference_paths");
    expect(payload).not.toHaveProperty("download_url");
    expect(payload).not.toHaveProperty("content_url");
    expect(text).not.toContain("client_request_1234567890abcdef");
    expect(text).not.toContain("a private cinematic prompt");
    expect(text).not.toContain("C:\\Users\\Alice");
    expect(text).not.toContain("D:\\Private");
    expect(text).not.toContain("sk-test_1234567890abcdef");
    expect(text).not.toContain("signature=secret");
    expect(text).toContain("[prompt]");
    expect(text).toContain("sk-***");
    expect(text).toContain("[本地路径]\\\\first.png");
    expect(text).toContain("https://cdn.example.com/video.mp4?...");
  });
});
