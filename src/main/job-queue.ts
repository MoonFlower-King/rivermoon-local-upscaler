import { BrowserWindow } from "electron";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  computeTargetDimensions,
  ensureDirectory,
  outputExtension,
  readImageDimensions
} from "./image.js";
import { interruptComfy, runComfyEngine } from "./comfy-engine.js";
import { DEFAULT_SCALE, sanitizeSettings } from "./settings.js";
import { log } from "./logger.js";
import { saveJobs, saveJobsSync } from "./jobs-store.js";
import type { StartJobsPayload, UpscaleJob, UpscaleSettings } from "./types.js";

export class JobQueue {
  private jobs = new Map<string, UpscaleJob>();
  private queue: string[] = [];
  private running = false;
  private abortControllers = new Map<string, AbortController>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private uiTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    initialJobs: UpscaleJob[] = []
  ) {
    for (const job of initialJobs) {
      this.jobs.set(job.id, job);
    }
  }

  getJobs(): UpscaleJob[] {
    return Array.from(this.jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  startJobs(payload: StartJobsPayload): UpscaleJob[] {
    const settings = sanitizeSettings(payload.settings);
    const created: UpscaleJob[] = [];

    for (const inputPath of payload.paths) {
      const job = createJob(inputPath, settings);
      this.jobs.set(job.id, job);
      this.queue.push(job.id);
      created.push(job);
    }

    this.emitNow();
    void this.drain();
    return created;
  }

  cancelJob(id: string): UpscaleJob | null {
    const job = this.jobs.get(id);
    if (!job) return null;

    if (job.status === "queued") {
      job.status = "cancelled";
      job.finishedAt = Date.now();
      job.durationMs = 0;
      job.message = "已取消";
      this.queue = this.queue.filter((queuedId) => queuedId !== id);
      this.emitNow();
      return job;
    }

    if (job.status === "running") {
      this.abortControllers.get(id)?.abort();
      // 让 ComfyUI 立即中断 GPU 计算并清掉队列里的该任务，而不是任由它在后台算完。
      void interruptComfy();
      return job;
    }

    return job;
  }

  clearFinished(): void {
    for (const [id, job] of this.jobs.entries()) {
      if (job.status === "succeeded" || job.status === "failed" || job.status === "cancelled") {
        this.jobs.delete(id);
      }
    }
    this.emitNow();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift();
        if (!id) continue;
        const job = this.jobs.get(id);
        if (!job || job.status !== "queued") continue;
        await this.runJob(job);
      }
    } finally {
      this.running = false;
      this.emitNow();
    }
  }

  private async runJob(job: UpscaleJob): Promise<void> {
    const controller = new AbortController();
    this.abortControllers.set(job.id, controller);

    try {
      job.status = "running";
      job.startedAt = Date.now();
      job.finishedAt = null;
      job.durationMs = null;
      job.progress = 5;
      job.message = "正在读取图片";
      this.emitNow();
      log(`任务开始 ${job.fileName} format=${job.settings.outputFormat} maxSide=${job.settings.maxSide}`);

      const dimensions = await readImageDimensions(job.inputPath);
      job.dimensions = dimensions;
      job.targetDimensions = computeTargetDimensions(dimensions, job.settings.maxSide, DEFAULT_SCALE);
      job.progress = 15;
      this.emit();

      const outputDirectory = job.settings.outputDirectory || path.join(path.dirname(job.inputPath), "upscaled");
      await ensureDirectory(outputDirectory);
      const outputPath = buildOutputPath(job.inputPath, outputDirectory, job.settings.outputFormat);
      job.outputPath = outputPath;

      job.message = "正在用 AI 引擎处理";
      job.progress = 18;
      this.emit();
      await runComfyEngine({
        inputPath: job.inputPath,
        outputPath,
        settings: job.settings,
        inputDimensions: dimensions,
        targetDimensions: job.targetDimensions,
        format: job.settings.outputFormat,
        signal: controller.signal,
        onProgress: (percent) => {
          const nextProgress = Math.max(job.progress, Math.min(99, Math.round(percent)));
          if (nextProgress !== job.progress) {
            job.progress = nextProgress;
            this.emit();
          }
        }
      });

      job.message = "正在保存输出";
      job.progress = Math.max(job.progress, 92);
      this.emit();

      job.outputBytes = await fsp
        .stat(outputPath)
        .then((stat) => stat.size)
        .catch(() => null);

      job.status = "succeeded";
      job.finishedAt = Date.now();
      job.durationMs = elapsedDuration(job);
      job.progress = 100;
      job.message = "已完成";
      job.error = null;
      this.emitNow();
      log(`任务完成 ${job.fileName} 用时 ${job.finishedAt - (job.startedAt ?? job.finishedAt)}ms -> ${outputPath}`);
    } catch (error) {
      job.status = controller.signal.aborted ? "cancelled" : "failed";
      job.finishedAt = Date.now();
      job.durationMs = elapsedDuration(job);
      job.progress = 100;
      job.message = job.status === "cancelled" ? "已取消" : "处理失败";
      job.error = formatJobError(error);
      this.emitNow();
      log(`任务${job.status === "cancelled" ? "取消" : "失败"} ${job.fileName} ${job.error ?? ""}`);
    } finally {
      this.abortControllers.delete(job.id);
      this.flushSync();
    }
  }

  /** 高频进度更新合并到 ~100ms 一次广播，避免每 +1% 就全量序列化 300 条任务过 IPC。 */
  private emitToUi(): void {
    if (this.uiTimer) return;
    this.uiTimer = setTimeout(() => {
      this.uiTimer = null;
      this.sendJobsToUi();
    }, 100);
  }

  /** 立即广播（状态跃迁走这里，保证 UI 秒级反馈），并吞掉未触发的节流定时器。 */
  private emitToUiNow(): void {
    if (this.uiTimer) {
      clearTimeout(this.uiTimer);
      this.uiTimer = null;
    }
    this.sendJobsToUi();
  }

  private sendJobsToUi(): void {
    this.getWindow()?.webContents.send("jobs:updated", this.getJobs());
  }

  /** 节流落盘（最多 ~1 次/500ms，异步非阻塞）：把高频进度写盘合并，避免主线程卡顿与写放大。 */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void saveJobs(this.getJobs()).catch((error) => {
        log(`任务记录保存失败 ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 500);
  }

  /** 节流 UI 广播 + 节流落盘。高频进度更新走这里。 */
  private emit(): void {
    this.emitToUi();
    this.schedulePersist();
  }

  /** 即时 UI 广播 + 节流落盘。任务创建/状态跃迁走这里。 */
  private emitNow(): void {
    this.emitToUiNow();
    this.schedulePersist();
  }

  /** 立即同步落盘（原子写）。用于任务终态与应用退出前，保证不丢数据。 */
  flushSync(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    try {
      saveJobsSync(this.getJobs());
    } catch (error) {
      log(`任务记录同步保存失败 ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function createJob(inputPath: string, settings: UpscaleSettings): UpscaleJob {
  return {
    id: crypto.randomUUID(),
    inputPath,
    outputPath: null,
    fileName: path.basename(inputPath),
    status: "queued",
    settings: { ...settings },
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    progress: 0,
    message: "等待处理",
    error: null,
    dimensions: null,
    targetDimensions: null,
    outputBytes: null
  };
}

function elapsedDuration(job: UpscaleJob): number {
  if (!job.startedAt || !job.finishedAt) return 0;
  return Math.max(0, job.finishedAt - job.startedAt);
}

function buildOutputPath(inputPath: string, outputDirectory: string, format: UpscaleSettings["outputFormat"]): string {
  const parsed = path.parse(inputPath);
  const ext = outputExtension(format);
  return resolveCollisionFreePath(path.join(outputDirectory, `${parsed.name}_upscaled`), ext);
}

/** 同名不同扩展名的输入、或重复处理同一文件时不静默覆盖旧输出，追加 _2/_3… 序号。 */
export function resolveCollisionFreePath(
  basePath: string,
  ext: string,
  exists: (candidate: string) => boolean = fsSync.existsSync
): string {
  let candidate = `${basePath}.${ext}`;
  for (let index = 2; exists(candidate); index += 1) {
    candidate = `${basePath}_${index}.${ext}`;
  }
  return candidate;
}

function formatJobError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
