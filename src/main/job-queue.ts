import { BrowserWindow } from "electron";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  computeSupirDimensions,
  computeTargetDimensions,
  computeWorkerOutputDimensions,
  computeWebClearDimensions,
  ensureDirectory,
  outputExtension,
  readImageDimensions,
  readImageHasAlpha,
  readWorkerImageDimensions,
  resolveConcreteFormat
} from "./image.js";
import { buildOutputPath } from "./output-path.js";
import { interruptComfy, runComfyEngine } from "./comfy-engine.js";
import { SUPIR_TIERS } from "./comfy-protocol.js";
import { SMART_ROUTE_MODELS, analyzeImageForRoute } from "./smart-route.js";
import { supirResources } from "./paths.js";
import { runWebClearEngine } from "./web-clear-engine.js";
import { DEFAULT_SCALE, sanitizeSettings } from "./settings.js";
import { log } from "./logger.js";
import { saveJobs, saveJobsSync } from "./jobs-store.js";
import type { ConcreteImageFormat, StartJobsPayload, UpscaleJob, UpscaleSettings } from "./types.js";

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

  /** 删除单条任务记录（不动输出文件）。运行中的任务先取消再删，避免残留孤儿 AbortController。 */
  removeJob(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    if (job.status === "running") {
      this.cancelJob(id);
      return;
    }
    this.queue = this.queue.filter((queuedId) => queuedId !== id);
    this.jobs.delete(id);
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
      log(
        `任务开始 ${job.fileName} mode=${job.settings.processingMode} format=${job.settings.outputFormat} maxSide=${job.settings.maxSide}`
      );

      const dimensions =
        job.settings.processingMode === "aiUpscale"
          ? ((await readWorkerImageDimensions(job.inputPath)) ?? (await readImageDimensions(job.inputPath)))
          : await readImageDimensions(job.inputPath);
      const hasAlpha = await readImageHasAlpha(job.inputPath);
      const outputFormat = resolveJobOutputFormat(job.settings, hasAlpha);
      job.dimensions = dimensions;
      job.targetDimensions = await computeJobTargetDimensions(job.inputPath, dimensions, job.settings);
      job.progress = 15;
      this.emit();

      const outputDirectory = job.settings.outputDirectory || path.join(path.dirname(job.inputPath), "upscaled");
      await ensureDirectory(outputDirectory);
      const outputPath = buildOutputPath(job.inputPath, outputDirectory, outputFormat);
      job.outputPath = outputPath;

      job.message = processingMessage(job.settings.processingMode);
      job.progress = 18;
      this.emit();
      if (job.settings.processingMode === "webClear") {
        await runWebClearEngine({
          inputPath: job.inputPath,
          outputPath,
          targetDimensions: job.targetDimensions,
          format: outputFormat,
          signal: controller.signal
        });
      } else if (job.settings.processingMode === "aiAuto") {
        // 智能模式：复刻 CodexSmartEnhance——GPT 看图分流，SUPIR 缺环境时按节点原逻辑回退 ESRGAN。
        this.updateJobProgress(job, 20);
        const decision = await analyzeImageForRoute(job.inputPath, controller.signal);
        if (controller.signal.aborted) throw new Error("任务已取消。");
        log(
          `智能模式判定 ${job.fileName} -> ${decision.recommendedPipeline}` +
            `${decision.fallback ? "（未走GPT，回退）" : ""}｜${decision.reasoning.slice(0, 160)}`
        );
        if (decision.recommendedPipeline === "supir" && supirResources().available) {
          job.message = "AI 判定：照片 → SUPIR 扩散修复";
          job.targetDimensions = computeSupirDimensions(
            dimensions,
            job.settings.maxSide,
            SUPIR_TIERS[job.settings.supirTier].maxScale
          );
          this.emit();
          await runComfyEngine({
            inputPath: job.inputPath,
            outputPath,
            settings: { ...job.settings, processingMode: "aiRepair" },
            inputDimensions: dimensions,
            targetDimensions: job.targetDimensions,
            format: outputFormat,
            signal: controller.signal,
            supirOverrides: {
              positivePrompt: decision.positivePrompt,
              negativePrompt: decision.negativePrompt,
              controlScale: decision.controlScale,
              restorationScale: decision.restorationScale
            },
            onProgress: (percent) => this.updateJobProgress(job, 22 + percent * 0.76)
          });
        } else {
          const routedModel =
            decision.recommendedPipeline === "realesrgan_anime"
              ? SMART_ROUTE_MODELS.realesrgan_anime
              : SMART_ROUTE_MODELS.realesrgan_general;
          job.message =
            decision.recommendedPipeline === "realesrgan_anime"
              ? "AI 判定：插画 → Anime6B"
              : "AI 判定：通用 → RealESRGAN";
          job.targetDimensions = computeTargetDimensions(dimensions, job.settings.maxSide, DEFAULT_SCALE);
          this.emit();
          await runComfyEngine({
            inputPath: job.inputPath,
            outputPath,
            settings: { ...job.settings, processingMode: "aiUpscale", upscaleModel: routedModel },
            inputDimensions: dimensions,
            targetDimensions: job.targetDimensions,
            format: outputFormat,
            signal: controller.signal,
            onProgress: (percent) => this.updateJobProgress(job, 22 + percent * 0.76)
          });
        }
      } else if (job.settings.processingMode === "aiUpscaleWebClear") {
        const intermediatePath = `${outputPath}.ai-tmp.${outputExtension(outputFormat)}`;
        try {
          await runComfyEngine({
            inputPath: job.inputPath,
            outputPath: intermediatePath,
            settings: job.settings,
            inputDimensions: dimensions,
            targetDimensions: job.targetDimensions,
            format: outputFormat,
            signal: controller.signal,
            onProgress: (percent) => this.updateJobProgress(job, 18 + percent * 0.64)
          });
          job.message = "正在套用网页增强";
          this.updateJobProgress(job, 86);
          await runWebClearEngine({
            inputPath: intermediatePath,
            outputPath,
            targetDimensions: job.targetDimensions,
            format: outputFormat,
            signal: controller.signal
          });
        } finally {
          await fsp.rm(intermediatePath, { force: true }).catch(() => {
            // 清理失败不影响任务终态。
          });
        }
      } else {
        await runComfyEngine({
          inputPath: job.inputPath,
          outputPath,
          settings: job.settings,
          inputDimensions: dimensions,
          targetDimensions: job.targetDimensions,
          format: outputFormat,
          signal: controller.signal,
          onProgress: (percent) => this.updateJobProgress(job, percent)
        });
      }

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

  private updateJobProgress(job: UpscaleJob, percent: number): void {
    const nextProgress = Math.max(job.progress, Math.min(99, Math.round(percent)));
    if (nextProgress !== job.progress) {
      job.progress = nextProgress;
      this.emit();
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

function processingMessage(mode: UpscaleSettings["processingMode"]): string {
  if (mode === "webClear") return "正在套用网页同款增强";
  if (mode === "aiUpscaleWebClear") return "正在用 AI 引擎放大";
  if (mode === "aiRepair") return "正在用 SUPIR 智能修复（单张数分钟）";
  if (mode === "aiAuto") return "正在让 GPT 分析画面";
  return "正在用 AI 引擎处理";
}

function resolveJobOutputFormat(settings: UpscaleSettings, hasAlpha: boolean): ConcreteImageFormat {
  const mode = settings.processingMode;
  if (mode === "aiUpscale" || mode === "aiRepair" || mode === "aiAuto") return "png";
  return resolveConcreteFormat(settings.outputFormat, hasAlpha);
}

async function computeJobTargetDimensions(
  inputPath: string,
  dimensions: NonNullable<UpscaleJob["dimensions"]>,
  settings: UpscaleSettings
): Promise<NonNullable<UpscaleJob["targetDimensions"]>> {
  if (settings.processingMode === "aiUpscale")
    return computeWorkerOutputDimensions(inputPath, settings.maxSide || 4096);
  if (settings.processingMode === "webClear") return computeWebClearDimensions(dimensions, settings.maxSide);
  if (settings.processingMode === "aiRepair")
    return computeSupirDimensions(dimensions, settings.maxSide, SUPIR_TIERS[settings.supirTier].maxScale);
  return computeTargetDimensions(dimensions, settings.maxSide, DEFAULT_SCALE);
}

function formatJobError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
