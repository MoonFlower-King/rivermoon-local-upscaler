import { BrowserWindow, app } from "electron";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { loadKey } from "./key-store.js";
import { RelayError, isTransientRelayError } from "./relay-protocol.js";
import { fetchRecentVideoJobs, resumeVideoGeneration, runVideoGeneration } from "./video-gen.js";
import { MAX_SAVED_VIDEO_TASKS, normalizeVideoTask, type RemoteVideoJob } from "./video-protocol.js";
import { safePersistentVideoUrl, videoJobDownloadFallbackUrls } from "./video-url.js";
import { log } from "../logger.js";
import { redactDiagnosticsText } from "../diagnostics-redaction.js";
import type { VideoGenParams, VideoGenTask } from "../types.js";

const CONCURRENCY = 1;
const REDACTED_VIDEO_REFERENCE_PATH = "[已上传参考图]";

function tasksPath(): string {
  return path.join(app.getPath("userData"), "video-tasks.json");
}

export async function loadSavedVideoTasks(): Promise<VideoGenTask[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(tasksPath(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => normalizeVideoTask(value))
      .filter((task): task is VideoGenTask => Boolean(task))
      .map((task) => minimizeLoadedVideoTaskForMemory(task))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_SAVED_VIDEO_TASKS);
  } catch {
    return [];
  }
}

export class VideoTaskQueue {
  private tasks = new Map<string, VideoGenTask>();
  private queue: string[] = [];
  private active = 0;
  private aborts = new Map<string, AbortController>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private uiTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    initialTasks: VideoGenTask[] = [],
    private readonly onFinished?: (task: VideoGenTask) => void
  ) {
    for (const task of initialTasks) {
      this.tasks.set(task.id, task);
      if (task.status === "queued") this.queue.push(task.id);
    }
    if (this.queue.length > 0) {
      setTimeout(() => this.drain(), 0);
    }
  }

  getTasks(): VideoGenTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  start(params: VideoGenParams, options: { estimatedCostUsd?: number | null } = {}): VideoGenTask {
    const task: VideoGenTask = {
      id: crypto.randomUUID(),
      params,
      status: "queued",
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      message: "排队中",
      error: null,
      needsTopup: false,
      progress: null,
      remoteJobId: null,
      requestId: null,
      clientRequestId: crypto.randomUUID(),
      dryRun: false,
      outputPath: null,
      outputBytes: null,
      contentUrl: null,
      downloadUrl: null,
      costUsd: null,
      estimatedCostUsd: options.estimatedCostUsd ?? null,
      charged: false,
      refunded: false
    };
    this.tasks.set(task.id, task);
    this.queue.push(task.id);
    this.emitNow();
    this.drain();
    return task;
  }

  async syncRecent(): Promise<VideoGenTask[]> {
    const key = loadKey();
    if (!key) throw new RelayError("auth", "未连接中转站账户，请先在设置里填写 API Key。");
    const remoteJobs = await fetchRecentVideoJobs(key, AbortSignal.timeout(45_000));
    let changed = false;
    for (const remote of remoteJobs) {
      changed = this.mergeRemoteJob(remote) || changed;
    }
    if (changed) {
      this.emitNow();
      this.drain();
    }
    log(`视频远端任务同步完成 ${remoteJobs.length} 条`);
    return this.getTasks();
  }

  cancel(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.status === "queued") {
      markQueuedVideoTaskCancelled(task);
      this.queue = this.queue.filter((queuedId) => queuedId !== id);
      this.emitNow();
      this.onFinished?.(task);
      return;
    }
    if (task.status === "running") this.aborts.get(id)?.abort();
  }

  resume(id: string): VideoGenTask | null {
    const task = this.tasks.get(id);
    if (!task?.remoteJobId || task.outputPath) return null;
    if (task.status === "running" || task.status === "queued") return task;
    prepareVideoTaskRetry(task);
    this.enqueueRecovery(task);
    this.emitNow();
    this.drain();
    return task;
  }

  retry(id: string): VideoGenTask | null {
    const task = this.tasks.get(id);
    if (!task || task.outputPath || task.status === "succeeded") return null;
    if (task.status === "running" || task.status === "queued") return task;
    if (!task.clientRequestId) task.clientRequestId = crypto.randomUUID();
    if (!prepareVideoTaskRetry(task)) return null;
    this.enqueueRecovery(task);
    this.emitNow();
    this.drain();
    return task;
  }

  clearFinished(): void {
    for (const [id, task] of this.tasks.entries()) {
      if (isClearableFinishedVideoTask(task)) {
        this.tasks.delete(id);
      }
    }
    this.emitNow();
  }

  private drain(): void {
    while (this.active < CONCURRENCY && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) continue;
      const task = this.tasks.get(id);
      if (!task || task.status !== "queued") continue;
      this.active += 1;
      void this.run(task).finally(() => {
        this.active -= 1;
        this.drain();
      });
    }
  }

  private async run(task: VideoGenTask): Promise<void> {
    const controller = new AbortController();
    this.aborts.set(task.id, controller);
    try {
      task.status = "running";
      task.startedAt = Date.now();
      task.message = "正在提交";
      this.emitNow();
      log(
        `视频开始 model=${task.params.model} duration=${task.params.duration}s ratio=${task.params.aspectRatio} resolution=${task.params.resolution}`
      );

      const key = loadKey();
      if (!key) throw new RelayError("auth", "未连接中转站账户，请先在设置里填写 API Key。");
      if (!task.clientRequestId) task.clientRequestId = crypto.randomUUID();

      const result = task.remoteJobId
        ? await resumeVideoGeneration(task.remoteJobId, key, controller.signal, (remote) => {
            this.applyRemoteUpdate(task, remote);
          })
        : await runVideoGeneration(task.params, task.clientRequestId, key, controller.signal, (remote) => {
            this.applyRemoteUpdate(task, remote);
          });

      task.outputPath = result.outputPath;
      task.outputBytes = result.outputBytes;
      task.remoteJobId = result.job.jobId || task.remoteJobId;
      task.requestId = result.job.requestId ?? task.requestId;
      task.clientRequestId = result.job.clientRequestId ?? task.clientRequestId;
      task.contentUrl = remoteVideoContentUrl(result.job) ?? task.contentUrl;
      task.downloadUrl = remoteVideoDownloadUrl(result.job) ?? task.downloadUrl;
      this.applyRemoteBilling(task, result.job);
      task.status = "succeeded";
      task.progress = 100;
      task.message = "已完成";
      task.error = null;
      log(`视频完成 job=${task.remoteJobId ?? "-"} -> ${task.outputPath}`);
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof DOMException && error.name === "AbortError");
      const syncInterrupted = !aborted && shouldStopLocalVideoSyncAfterError(task, error);
      task.status = aborted || syncInterrupted ? "cancelled" : "failed";
      task.message =
        aborted && task.remoteJobId
          ? "已停止本地同步，远端任务可能仍在处理或计费"
          : syncInterrupted
            ? "本地同步中断，远端任务可能仍在处理或计费"
            : aborted
              ? "已取消"
              : "生成失败";
      task.error = aborted
        ? null
        : sanitizeVideoTaskError(error instanceof Error ? error.message : String(error), task.params.prompt);
      task.needsTopup = !aborted && error instanceof RelayError && error.kind === "quota";
      log(`视频${aborted ? "取消" : "失败"} ${task.error ?? ""}`);
    } finally {
      task.finishedAt = Date.now();
      task.durationMs = task.startedAt ? Math.max(0, task.finishedAt - task.startedAt) : null;
      this.aborts.delete(task.id);
      this.emitNow();
      this.flushSync();
      this.onFinished?.(task);
    }
  }

  private applyRemoteUpdate(task: VideoGenTask, remote: RemoteVideoJob): void {
    task.remoteJobId = remote.jobId || task.remoteJobId;
    task.requestId = remote.requestId ?? task.requestId;
    task.clientRequestId = remote.clientRequestId ?? task.clientRequestId;
    task.dryRun = remote.dryRun;
    task.contentUrl = remoteVideoContentUrl(remote) ?? task.contentUrl;
    task.downloadUrl = remoteVideoDownloadUrl(remote) ?? task.downloadUrl;
    task.progress = remote.progress ?? task.progress;
    this.applyRemoteBilling(task, remote);
    task.message =
      remote.status === "queued"
        ? "排队中"
        : remote.status === "running"
          ? "正在生成"
          : remote.status === "succeeded"
            ? "正在下载"
            : sanitizeVideoTaskError(remote.errorMessage || remote.message || "视频任务更新", task.params.prompt);
    this.emitNow();
  }

  private mergeRemoteJob(remote: RemoteVideoJob): boolean {
    const existing = this.findByRemote(remote);
    if (existing) {
      return this.updateExistingFromRemote(existing, remote);
    }
    const task = this.taskFromRemote(remote);
    this.tasks.set(task.id, task);
    if (this.shouldRecoverRemote(remote)) this.enqueueRecovery(task);
    return true;
  }

  private findByRemote(remote: RemoteVideoJob): VideoGenTask | null {
    return this.getTasks().find((task) => matchesRemoteVideoTask(task, remote)) ?? null;
  }

  private updateExistingFromRemote(task: VideoGenTask, remote: RemoteVideoJob): boolean {
    const before = JSON.stringify(task);
    task.remoteJobId = remote.jobId || task.remoteJobId;
    task.requestId = remote.requestId ?? task.requestId;
    task.clientRequestId = remote.clientRequestId ?? task.clientRequestId;
    task.dryRun = remote.dryRun;
    task.progress = remote.progress ?? task.progress;
    task.contentUrl = remoteVideoContentUrl(remote) ?? task.contentUrl;
    task.downloadUrl = remoteVideoDownloadUrl(remote) ?? task.downloadUrl;
    this.applyRemoteBilling(task, remote);
    if (this.shouldRecoverRemote(remote) && !task.outputPath && task.status !== "running") {
      task.status = "queued";
      task.finishedAt = null;
      task.durationMs = null;
      task.error = null;
      task.needsTopup = false;
      task.message = remote.status === "succeeded" ? "等待下载远端视频结果" : "等待同步远端视频任务";
      this.enqueueRecovery(task);
    } else if (!this.shouldRecoverRemote(remote)) {
      task.status = remote.status;
      task.finishedAt = task.finishedAt ?? Date.now();
      task.durationMs = task.startedAt ? Math.max(0, task.finishedAt - task.startedAt) : task.durationMs;
      task.message = sanitizeVideoTaskError(
        remote.errorMessage || remote.message || statusMessage(remote.status),
        task.params.prompt
      );
      task.error =
        remote.status === "failed"
          ? sanitizeVideoTaskError(remote.errorMessage || remote.message || "远端视频任务失败", task.params.prompt)
          : null;
      if (remote.status !== "failed") task.needsTopup = false;
    }
    return before !== JSON.stringify(task);
  }

  private taskFromRemote(remote: RemoteVideoJob): VideoGenTask {
    const recover = this.shouldRecoverRemote(remote);
    const now = Date.now();
    return {
      id: crypto.randomUUID(),
      params: {
        model: remote.model || "remote-video",
        prompt: remoteVideoTaskTitle(remote),
        endpoint: remote.endpoint,
        aspectRatio: remote.aspectRatio || "16:9",
        duration: remote.duration ?? 5,
        resolution: remote.resolution || "720p",
        referencePaths: [],
        referenceType: "ordinary",
        referenceTypes: []
      },
      status: recover ? "queued" : remote.status,
      createdAt: now,
      startedAt: null,
      finishedAt: recover ? null : now,
      durationMs: null,
      message: recover
        ? remote.status === "succeeded"
          ? "等待下载远端视频结果"
          : "等待同步远端视频任务"
        : sanitizeVideoTaskError(remote.errorMessage || remote.message || statusMessage(remote.status), remote.prompt),
      error:
        remote.status === "failed"
          ? sanitizeVideoTaskError(remote.errorMessage || remote.message || "远端视频任务失败", remote.prompt)
          : null,
      needsTopup: false,
      progress: remote.progress,
      remoteJobId: remote.jobId,
      requestId: remote.requestId,
      clientRequestId: remote.clientRequestId,
      dryRun: remote.dryRun,
      outputPath: null,
      outputBytes: null,
      contentUrl: remoteVideoContentUrl(remote),
      downloadUrl: remoteVideoDownloadUrl(remote),
      costUsd: remote.costUsd,
      estimatedCostUsd: remote.estimatedCostUsd,
      charged: remote.charged === true,
      refunded: remote.refunded === true
    };
  }

  private applyRemoteBilling(task: VideoGenTask, remote: RemoteVideoJob): void {
    task.costUsd = remote.costUsd ?? task.costUsd;
    task.estimatedCostUsd = remote.estimatedCostUsd ?? task.estimatedCostUsd;
    task.charged = remote.charged ?? task.charged;
    task.refunded = remote.refunded ?? task.refunded;
  }

  private shouldRecoverRemote(remote: RemoteVideoJob): boolean {
    return remote.status === "queued" || remote.status === "running" || remote.status === "succeeded";
  }

  private enqueueRecovery(task: VideoGenTask): void {
    if (!this.queue.includes(task.id) && task.status === "queued") this.queue.push(task.id);
  }

  private emitNow(): void {
    if (this.uiTimer) {
      clearTimeout(this.uiTimer);
      this.uiTimer = null;
    }
    this.getWindow()?.webContents.send("video-tasks:updated", this.getTasks());
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist().catch((error) => {
        log(`视频任务保存失败 ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 500);
  }

  private stableForDisk(): VideoGenTask[] {
    return this.getTasks()
      .map((task) => stableVideoTaskForDisk(task))
      .slice(0, MAX_SAVED_VIDEO_TASKS);
  }

  private async persist(): Promise<void> {
    const target = tasksPath();
    const tmp = `${target}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(this.stableForDisk(), null, 2), "utf8");
    await fs.rename(tmp, target);
  }

  flushSync(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      const target = tasksPath();
      const tmp = `${target}.tmp`;
      fsSync.mkdirSync(path.dirname(target), { recursive: true });
      fsSync.writeFileSync(tmp, JSON.stringify(this.stableForDisk(), null, 2), "utf8");
      fsSync.renameSync(tmp, target);
    } catch (error) {
      log(`视频任务同步保存失败 ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function markQueuedVideoTaskCancelled(task: VideoGenTask, now = Date.now()): void {
  task.status = "cancelled";
  task.finishedAt = now;
  task.durationMs = task.startedAt ? Math.max(0, task.finishedAt - task.startedAt) : null;
  task.message = task.remoteJobId ? "已停止本地同步，远端任务可能仍在处理或计费" : "已取消";
}

export function isStoppedRemoteSyncTask(task: VideoGenTask): boolean {
  return task.status === "cancelled" && Boolean(task.remoteJobId) && !task.outputPath;
}

export function isRecoverableRemoteVideoTask(task: VideoGenTask): boolean {
  if (!task.remoteJobId || task.outputPath) return false;
  if (task.status === "cancelled") return true;
  return task.status === "failed" && Boolean(task.downloadUrl || task.contentUrl);
}

export function isClearableFinishedVideoTask(task: VideoGenTask): boolean {
  if (isRecoverableRemoteVideoTask(task)) return false;
  return (
    task.status === "succeeded" || task.status === "failed" || task.status === "cancelled" || task.status === "expired"
  );
}

export function shouldStopLocalVideoSyncAfterError(task: VideoGenTask, error: unknown): boolean {
  return Boolean(task.remoteJobId && !task.outputPath && isTransientRelayError(error));
}

export function stableVideoTaskForDisk(task: VideoGenTask, now = Date.now()): VideoGenTask {
  const stableTask = {
    ...minimizeLoadedVideoTaskForMemory(task),
    contentUrl:
      safePersistentVideoUrl(task.contentUrl, task.remoteJobId, "content") ??
      (task.status === "succeeded" && task.remoteJobId
        ? (videoJobDownloadFallbackUrls(task.remoteJobId)[1] ?? null)
        : null),
    downloadUrl:
      safePersistentVideoUrl(task.downloadUrl, task.remoteJobId, "download") ??
      (task.status === "succeeded" && task.remoteJobId
        ? (videoJobDownloadFallbackUrls(task.remoteJobId)[0] ?? null)
        : null)
  };
  if ((task.status === "running" || task.status === "queued") && task.remoteJobId && !task.outputPath) {
    return {
      ...stableTask,
      status: "queued",
      message: "软件关闭时远端任务仍在运行，重启后会继续同步",
      finishedAt: null
    };
  }
  if (task.status === "running" || task.status === "queued") {
    return {
      ...stableTask,
      status: "cancelled",
      message: "上次关闭软件时已停止",
      finishedAt: task.finishedAt ?? now
    };
  }
  return stableTask;
}

export function minimizeLoadedVideoTaskForMemory(task: VideoGenTask): VideoGenTask {
  if (!task.remoteJobId) return task;
  const sanitizedTask = {
    ...task,
    contentUrl: safePersistentVideoUrl(task.contentUrl, task.remoteJobId, "content"),
    downloadUrl: safePersistentVideoUrl(task.downloadUrl, task.remoteJobId, "download")
  };
  if (sanitizedTask.params.referencePaths.length === 0) return sanitizedTask;
  return {
    ...sanitizedTask,
    params: {
      ...sanitizedTask.params,
      referencePaths: sanitizedTask.params.referencePaths.map(() => REDACTED_VIDEO_REFERENCE_PATH)
    }
  };
}

export function prepareVideoTaskRetry(task: VideoGenTask): boolean {
  if (task.outputPath || task.status === "running" || task.status === "queued" || task.status === "succeeded")
    return false;
  task.status = "queued";
  task.finishedAt = null;
  task.durationMs = null;
  task.progress = task.remoteJobId ? task.progress : null;
  task.error = null;
  task.needsTopup = false;
  task.message = task.remoteJobId ? "等待恢复远端视频任务" : "等待重试视频任务";
  return true;
}

export function matchesRemoteVideoTask(task: VideoGenTask, remote: RemoteVideoJob): boolean {
  return (
    (remote.jobId.length > 0 && task.remoteJobId === remote.jobId) ||
    (remote.requestId !== null && task.requestId !== null && task.requestId === remote.requestId) ||
    (remote.clientRequestId !== null &&
      task.clientRequestId !== null &&
      task.clientRequestId === remote.clientRequestId)
  );
}

function remoteVideoDownloadUrl(remote: RemoteVideoJob): string | null {
  if (remote.downloadUrl) return safePersistentVideoUrl(remote.downloadUrl, remote.jobId, "download");
  if (remote.status !== "succeeded" || !remote.jobId) return null;
  return videoJobDownloadFallbackUrls(remote.jobId)[0] ?? null;
}

function remoteVideoContentUrl(remote: RemoteVideoJob): string | null {
  const remoteUrl = remote.contentUrl ?? remote.outputUrl;
  if (remoteUrl) return safePersistentVideoUrl(remoteUrl, remote.jobId, "content");
  if (remote.status !== "succeeded" || !remote.jobId) return null;
  return videoJobDownloadFallbackUrls(remote.jobId)[1] ?? null;
}

function remoteVideoTaskTitle(remote: RemoteVideoJob): string {
  const id = remote.jobId || remote.requestId || remote.clientRequestId || "";
  return id ? `远端视频任务 ${id}` : "远端视频任务";
}

export function sanitizeVideoTaskError(message: string, prompt: string | null | undefined): string {
  let result = redactDiagnosticsText(message);
  const trimmedPrompt = typeof prompt === "string" ? prompt.trim() : "";
  if (trimmedPrompt.length >= 8) {
    result = result.split(trimmedPrompt).join("[prompt]");
  }
  return result.slice(0, 500);
}

function statusMessage(status: VideoGenTask["status"]): string {
  switch (status) {
    case "queued":
      return "远端排队中";
    case "running":
      return "远端生成中";
    case "succeeded":
      return "远端已完成";
    case "failed":
      return "远端任务失败";
    case "cancelled":
      return "远端任务已取消";
    case "expired":
      return "远端任务已过期";
  }
}
