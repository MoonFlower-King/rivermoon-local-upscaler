import { describe, expect, it } from "vitest";
import {
  VideoTaskQueue,
  isClearableFinishedVideoTask,
  isRecoverableRemoteVideoTask,
  isStoppedRemoteSyncTask,
  markQueuedVideoTaskCancelled,
  matchesRemoteVideoTask,
  minimizeLoadedVideoTaskForMemory,
  prepareVideoTaskRetry,
  sanitizeVideoTaskError,
  shouldStopLocalVideoSyncAfterError,
  stableVideoTaskForDisk
} from "../src/main/cloud/video-queue";
import type { RemoteVideoJob } from "../src/main/cloud/video-protocol";
import { RelayError } from "../src/main/cloud/relay-protocol";
import type { VideoGenTask } from "../src/main/types";

function queuedTask(overrides: Partial<VideoGenTask> = {}): VideoGenTask {
  return {
    id: "local",
    params: {
      model: "video-v1",
      prompt: "prompt",
      endpoint: "text_to_video",
      aspectRatio: "16:9",
      duration: 5,
      resolution: "720p",
      referencePaths: [],
      referenceType: "ordinary",
      referenceTypes: []
    },
    status: "queued",
    createdAt: 1,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    message: "排队中",
    error: null,
    needsTopup: false,
    progress: null,
    remoteJobId: null,
    requestId: null,
    clientRequestId: "client_1",
    dryRun: false,
    outputPath: null,
    outputBytes: null,
    contentUrl: null,
    downloadUrl: null,
    costUsd: null,
    estimatedCostUsd: null,
    charged: false,
    refunded: false,
    ...overrides
  };
}

function remoteJob(overrides: Partial<RemoteVideoJob> = {}): RemoteVideoJob {
  return {
    jobId: "vjob_1",
    requestId: null,
    clientRequestId: null,
    status: "running",
    progress: null,
    model: null,
    prompt: null,
    endpoint: "text_to_video",
    aspectRatio: null,
    duration: null,
    resolution: null,
    dryRun: false,
    contentUrl: null,
    downloadUrl: null,
    outputUrl: null,
    errorMessage: null,
    message: null,
    costUsd: null,
    estimatedCostUsd: null,
    charged: null,
    refunded: null,
    ...overrides
  };
}

describe("video queue", () => {
  it("取消未提交远端的 queued 视频任务时显示本地取消", () => {
    const task = queuedTask({ startedAt: 10 });

    markQueuedVideoTaskCancelled(task, 25);

    expect(task.status).toBe("cancelled");
    expect(task.finishedAt).toBe(25);
    expect(task.durationMs).toBe(15);
    expect(task.message).toBe("已取消");
  });

  it("停止已有远端 job 的 queued 视频任务时提示只是停止本地同步", () => {
    const task = queuedTask({ remoteJobId: "vjob_1" });

    markQueuedVideoTaskCancelled(task, 25);

    expect(task.status).toBe("cancelled");
    expect(task.message).toBe("已停止本地同步，远端任务可能仍在处理或计费");
  });

  it("停止同步且未下载输出的远端任务不能被清空", () => {
    const task = queuedTask({ status: "cancelled", remoteJobId: "vjob_1", outputPath: null });

    expect(isStoppedRemoteSyncTask(task)).toBe(true);
    expect(isRecoverableRemoteVideoTask(task)).toBe(true);
    expect(isClearableFinishedVideoTask(task)).toBe(false);
  });

  it("远端已成功但本地下载失败的任务不能被清空", () => {
    const task = queuedTask({
      status: "failed",
      remoteJobId: "vjob_1",
      outputPath: null,
      downloadUrl: "/v1/video/jobs/vjob_1/download"
    });

    expect(isRecoverableRemoteVideoTask(task)).toBe(true);
    expect(isClearableFinishedVideoTask(task)).toBe(false);
  });

  it("远端明确失败且没有下载地址的任务可以被清空", () => {
    const task = queuedTask({
      status: "failed",
      remoteJobId: "vjob_1",
      outputPath: null,
      downloadUrl: null,
      contentUrl: null
    });

    expect(isRecoverableRemoteVideoTask(task)).toBe(false);
    expect(isClearableFinishedVideoTask(task)).toBe(true);
  });

  it("本地终态视频任务可以被清空", () => {
    expect(isClearableFinishedVideoTask(queuedTask({ status: "succeeded", outputPath: "D:\\out.mp4" }))).toBe(true);
    expect(isClearableFinishedVideoTask(queuedTask({ status: "failed" }))).toBe(true);
    expect(isClearableFinishedVideoTask(queuedTask({ status: "cancelled", remoteJobId: null }))).toBe(true);
    expect(isClearableFinishedVideoTask(queuedTask({ status: "expired" }))).toBe(true);
  });

  it("已下载输出的远端取消记录可以被清空", () => {
    const task = queuedTask({ status: "cancelled", remoteJobId: "vjob_1", outputPath: "D:\\out.mp4" });

    expect(isStoppedRemoteSyncTask(task)).toBe(false);
    expect(isClearableFinishedVideoTask(task)).toBe(true);
  });

  it("写盘时保留已提交远端但尚未下载的 queued 任务为可恢复状态", () => {
    const stable = stableVideoTaskForDisk(queuedTask({ status: "queued", remoteJobId: "vjob_1", finishedAt: 50 }), 99);

    expect(stable.status).toBe("queued");
    expect(stable.finishedAt).toBeNull();
    expect(stable.message).toBe("软件关闭时远端任务仍在运行，重启后会继续同步");
  });

  it("写盘时未提交远端的本地 queued 任务会标记为取消", () => {
    const stable = stableVideoTaskForDisk(queuedTask({ status: "queued", remoteJobId: null }), 99);

    expect(stable.status).toBe("cancelled");
    expect(stable.finishedAt).toBe(99);
    expect(stable.message).toBe("上次关闭软件时已停止");
  });

  it("重试未提交远端的失败任务时复用原 client_request_id", () => {
    const task = queuedTask({
      status: "failed",
      finishedAt: 50,
      durationMs: 40,
      progress: 20,
      error: "network",
      needsTopup: true,
      clientRequestId: "client_existing"
    });

    expect(prepareVideoTaskRetry(task)).toBe(true);

    expect(task.status).toBe("queued");
    expect(task.finishedAt).toBeNull();
    expect(task.durationMs).toBeNull();
    expect(task.progress).toBeNull();
    expect(task.error).toBeNull();
    expect(task.needsTopup).toBe(false);
    expect(task.clientRequestId).toBe("client_existing");
    expect(task.message).toBe("等待重试视频任务");
  });

  it("重试已有远端 job 的失败任务时转为恢复同步", () => {
    const task = queuedTask({
      status: "failed",
      remoteJobId: "vjob_1",
      finishedAt: 50,
      durationMs: 40,
      progress: 80,
      error: "download failed"
    });

    expect(prepareVideoTaskRetry(task)).toBe(true);

    expect(task.status).toBe("queued");
    expect(task.remoteJobId).toBe("vjob_1");
    expect(task.progress).toBe(80);
    expect(task.message).toBe("等待恢复远端视频任务");
  });

  it("远端 recent 任务可按 client_request_id 和本地任务去重", () => {
    const task = queuedTask({ remoteJobId: null, requestId: null, clientRequestId: "client_existing" });

    expect(
      matchesRemoteVideoTask(
        task,
        remoteJob({ jobId: "vjob_remote", requestId: null, clientRequestId: "client_existing" })
      )
    ).toBe(true);
  });

  it("远端成功但没有返回下载地址时写入网关 fallback 以便恢复下载", () => {
    const queue = new VideoTaskQueue(() => null);
    const task = (
      queue as unknown as {
        taskFromRemote(remote: RemoteVideoJob): VideoGenTask;
      }
    ).taskFromRemote(remoteJob({ status: "succeeded", downloadUrl: null, contentUrl: null, outputUrl: null }));

    expect(task.status).toBe("queued");
    expect(task.downloadUrl).toBe("/v1/video/jobs/vjob_1/download");
    expect(task.contentUrl).toBe("/v1/video/jobs/vjob_1/content");
    expect(isRecoverableRemoteVideoTask({ ...task, status: "failed" })).toBe(true);
  });

  it("recent 发现可恢复远端任务时清理旧失败状态", () => {
    const queue = new VideoTaskQueue(() => null);
    const task = queuedTask({
      status: "failed",
      remoteJobId: "vjob_1",
      finishedAt: 50,
      durationMs: 40,
      error: "旧下载失败",
      needsTopup: true,
      progress: 20,
      outputPath: null
    });

    const changed = (
      queue as unknown as {
        updateExistingFromRemote(task: VideoGenTask, remote: RemoteVideoJob): boolean;
      }
    ).updateExistingFromRemote(
      task,
      remoteJob({
        status: "succeeded",
        progress: 100,
        downloadUrl: "/v1/video/jobs/vjob_1/download",
        costUsd: 0.12,
        charged: true
      })
    );

    expect(changed).toBe(true);
    expect(task.status).toBe("queued");
    expect(task.finishedAt).toBeNull();
    expect(task.durationMs).toBeNull();
    expect(task.error).toBeNull();
    expect(task.needsTopup).toBe(false);
    expect(task.progress).toBe(100);
    expect(task.message).toBe("等待下载远端视频结果");
    expect(task.downloadUrl).toBe("/v1/video/jobs/vjob_1/download");
    expect(task.costUsd).toBe(0.12);
    expect(task.charged).toBe(true);
  });

  it("recent 发现远端取消或过期时清理旧失败状态", () => {
    const queue = new VideoTaskQueue(() => null);
    const update = (
      queue as unknown as {
        updateExistingFromRemote(task: VideoGenTask, remote: RemoteVideoJob): boolean;
      }
    ).updateExistingFromRemote.bind(queue);

    const cancelledTask = queuedTask({
      status: "failed",
      remoteJobId: "vjob_1",
      finishedAt: 50,
      durationMs: 40,
      error: "旧失败",
      needsTopup: true
    });
    const expiredTask = queuedTask({
      id: "local_2",
      status: "failed",
      remoteJobId: "vjob_2",
      finishedAt: 60,
      durationMs: 50,
      error: "旧余额错误",
      needsTopup: true
    });

    expect(update(cancelledTask, remoteJob({ status: "cancelled" }))).toBe(true);
    expect(update(expiredTask, remoteJob({ jobId: "vjob_2", status: "expired" }))).toBe(true);

    expect(cancelledTask.status).toBe("cancelled");
    expect(cancelledTask.message).toBe("远端任务已取消");
    expect(cancelledTask.error).toBeNull();
    expect(cancelledTask.needsTopup).toBe(false);
    expect(expiredTask.status).toBe("expired");
    expect(expiredTask.message).toBe("远端任务已过期");
    expect(expiredTask.error).toBeNull();
    expect(expiredTask.needsTopup).toBe(false);
  });

  it("从 recent 导入新远端任务时不保存远端完整 prompt", () => {
    const queue = new VideoTaskQueue(() => null);
    const task = (
      queue as unknown as {
        taskFromRemote(remote: RemoteVideoJob): VideoGenTask;
      }
    ).taskFromRemote(
      remoteJob({
        status: "failed",
        prompt: "a private cinematic prompt",
        message: "a private cinematic prompt failed at C:\\Users\\Alice\\Pictures\\ref.png",
        errorMessage: "blocked: a private cinematic prompt"
      })
    );

    expect(task.params.prompt).toBe("远端视频任务 vjob_1");
    expect(task.message).toBe("blocked: [prompt]");
    expect(task.error).toBe("blocked: [prompt]");
    expect(JSON.stringify(task)).not.toContain("a private cinematic prompt");
    expect(JSON.stringify(task)).not.toContain("C:\\Users\\Alice");
  });

  it("写盘时不持久化第三方签名下载 URL query", () => {
    const stable = stableVideoTaskForDisk(
      queuedTask({
        status: "succeeded",
        remoteJobId: "vjob_1",
        outputPath: null,
        downloadUrl: "https://cdn.example.com/out/vjob_1.mp4?signature=abc&token=secret",
        contentUrl: "https://video.rivermoon7.com/v1/video/jobs/vjob_1/content?token=secret"
      })
    );

    expect(stable.downloadUrl).toBe("/v1/video/jobs/vjob_1/download");
    expect(stable.contentUrl).toBe("/v1/video/jobs/vjob_1/content");
  });

  it("写盘时不为普通远端失败任务凭空补下载地址", () => {
    const stable = stableVideoTaskForDisk(
      queuedTask({
        status: "failed",
        remoteJobId: "vjob_1",
        outputPath: null,
        downloadUrl: null,
        contentUrl: null
      })
    );

    expect(stable.downloadUrl).toBeNull();
    expect(stable.contentUrl).toBeNull();
    expect(isRecoverableRemoteVideoTask(stable)).toBe(false);
  });

  it("写盘时已提交远端的任务不保留本地参考图绝对路径", () => {
    const params = {
      ...queuedTask().params,
      endpoint: "reference_to_video" as const,
      referencePaths: ["C:\\Users\\Alice\\Pictures\\first.png", "D:\\Private\\style.png"],
      referenceType: "ordinary" as const,
      referenceTypes: ["ordinary" as const, "style" as const]
    };
    const stable = stableVideoTaskForDisk(
      queuedTask({
        status: "queued",
        remoteJobId: "vjob_1",
        params
      })
    );

    expect(stable.params.referencePaths).toEqual(["[已上传参考图]", "[已上传参考图]"]);
    expect(stable.params.referenceTypes).toEqual(["ordinary", "style"]);
  });

  it("写盘时未提交远端的失败任务保留参考图路径以便重试上传", () => {
    const params = {
      ...queuedTask().params,
      endpoint: "image_to_video" as const,
      referencePaths: ["C:\\Users\\Alice\\Pictures\\first.png"],
      referenceType: "ordinary" as const,
      referenceTypes: ["ordinary" as const]
    };
    const stable = stableVideoTaskForDisk(
      queuedTask({
        status: "failed",
        remoteJobId: null,
        params
      })
    );

    expect(stable.params.referencePaths).toEqual(["C:\\Users\\Alice\\Pictures\\first.png"]);
  });

  it("读取旧任务时已提交远端的任务不带回本地参考图绝对路径", () => {
    const params = {
      ...queuedTask().params,
      endpoint: "reference_to_video" as const,
      referencePaths: ["C:\\Users\\Alice\\Pictures\\first.png", "D:\\Private\\style.png"],
      referenceType: "ordinary" as const,
      referenceTypes: ["ordinary" as const, "style" as const]
    };

    const loaded = minimizeLoadedVideoTaskForMemory(
      queuedTask({
        remoteJobId: "vjob_1",
        params
      })
    );

    expect(loaded.params.referencePaths).toEqual(["[已上传参考图]", "[已上传参考图]"]);
    expect(loaded.params.referenceTypes).toEqual(["ordinary", "style"]);
  });

  it("读取旧任务时已提交远端的任务不带回历史签名下载 URL", () => {
    const loaded = minimizeLoadedVideoTaskForMemory(
      queuedTask({
        remoteJobId: "vjob_1",
        contentUrl: "https://video.rivermoon7.com/v1/video/jobs/vjob_1/content?token=secret",
        downloadUrl: "https://cdn.example.com/out/vjob_1.mp4?signature=abc&token=secret"
      })
    );

    expect(loaded.contentUrl).toBe("/v1/video/jobs/vjob_1/content");
    expect(loaded.downloadUrl).toBe("/v1/video/jobs/vjob_1/download");
    expect(JSON.stringify(loaded)).not.toContain("signature=abc");
    expect(JSON.stringify(loaded)).not.toContain("token=secret");
  });

  it("读取旧任务时未提交远端的任务保留参考图路径以便重试上传", () => {
    const params = {
      ...queuedTask().params,
      endpoint: "image_to_video" as const,
      referencePaths: ["C:\\Users\\Alice\\Pictures\\first.png"],
      referenceType: "ordinary" as const,
      referenceTypes: ["ordinary" as const]
    };

    const loaded = minimizeLoadedVideoTaskForMemory(
      queuedTask({
        remoteJobId: null,
        params
      })
    );

    expect(loaded.params.referencePaths).toEqual(["C:\\Users\\Alice\\Pictures\\first.png"]);
  });

  it("远端 recent 任务空 client_request_id 不会误匹配", () => {
    const task = queuedTask({ remoteJobId: null, requestId: null, clientRequestId: "client_existing" });

    expect(
      matchesRemoteVideoTask(task, remoteJob({ jobId: "vjob_remote", requestId: null, clientRequestId: null }))
    ).toBe(false);
  });

  it("已有远端 job 的瞬时同步错误会保留恢复同步入口", () => {
    const task = queuedTask({ status: "running", remoteJobId: "vjob_1", outputPath: null });

    expect(shouldStopLocalVideoSyncAfterError(task, new RelayError("network", "timeout"))).toBe(true);
    expect(shouldStopLocalVideoSyncAfterError(task, new RelayError("server", "503"))).toBe(true);
    expect(shouldStopLocalVideoSyncAfterError(task, new RelayError("bad-response", "bad payload"))).toBe(false);
    expect(
      shouldStopLocalVideoSyncAfterError({ ...task, remoteJobId: null }, new RelayError("network", "timeout"))
    ).toBe(false);
    expect(
      shouldStopLocalVideoSyncAfterError({ ...task, outputPath: "D:\\out.mp4" }, new RelayError("network", "timeout"))
    ).toBe(false);
  });

  it("视频任务错误会脱敏 prompt、Key 和本地路径", () => {
    const prompt = "a cinematic long prompt";
    const message =
      "bad prompt a cinematic long prompt with key sk-test_1234567890abcdef at C:\\Users\\Alice\\Pictures\\ref.png";

    expect(sanitizeVideoTaskError(message, prompt)).toBe("bad prompt [prompt] with key sk-*** at [本地路径]\\ref.png");
  });
});
