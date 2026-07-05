import { BrowserWindow, app } from "electron";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_SAVED_IMAGE_TASKS, normalizeImageTask } from "./image-protocol.js";
import { runImageGeneration } from "./image-gen.js";
import { RelayError } from "./relay-protocol.js";
import { loadKey } from "./key-store.js";
import { log } from "../logger.js";
import type { ImageGenParams, ImageGenTask } from "../types.js";

/** 云端并行度：生图是网络 IO，2 路并行在体验与限流之间取平衡。 */
const CONCURRENCY = 2;

function tasksPath(): string {
  return path.join(app.getPath("userData"), "image-tasks.json");
}

export async function loadSavedImageTasks(): Promise<ImageGenTask[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(tasksPath(), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => normalizeImageTask(value))
      .filter((task): task is ImageGenTask => Boolean(task))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_SAVED_IMAGE_TASKS);
  } catch {
    return [];
  }
}

/**
 * 云端生图任务队列：与本地 JobQueue 同一套模式（原子写持久化、节流广播、
 * 崩溃恢复标记），但网络任务并行执行。
 */
export class ImageTaskQueue {
  private tasks = new Map<string, ImageGenTask>();
  private queue: string[] = [];
  private active = 0;
  private aborts = new Map<string, AbortController>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private uiTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly getWindow: () => BrowserWindow | null,
    initialTasks: ImageGenTask[] = [],
    /** 任务到达终态时回调（main.ts 用于路径白名单 + 余额缓存失效）。 */
    private readonly onFinished?: (task: ImageGenTask) => void
  ) {
    for (const task of initialTasks) this.tasks.set(task.id, task);
  }

  getTasks(): ImageGenTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  start(params: ImageGenParams): ImageGenTask {
    const task: ImageGenTask = {
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
      outputPaths: [],
      outputSizes: []
    };
    this.tasks.set(task.id, task);
    this.queue.push(task.id);
    this.emitNow();
    this.drain();
    return task;
  }

  cancel(id: string): void {
    const task = this.tasks.get(id);
    if (!task) return;
    if (task.status === "queued") {
      task.status = "cancelled";
      task.finishedAt = Date.now();
      task.message = "已取消";
      this.queue = this.queue.filter((queuedId) => queuedId !== id);
      this.emitNow();
      this.onFinished?.(task);
      return;
    }
    if (task.status === "running") this.aborts.get(id)?.abort();
  }

  clearFinished(): void {
    for (const [id, task] of this.tasks.entries()) {
      if (task.status === "succeeded" || task.status === "failed" || task.status === "cancelled") {
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

  private async run(task: ImageGenTask): Promise<void> {
    const controller = new AbortController();
    this.aborts.set(task.id, controller);
    try {
      task.status = "running";
      task.startedAt = Date.now();
      task.message = "正在生成";
      this.emitNow();
      log(`生图开始 model=${task.params.model} n=${task.params.count} size=${task.params.size}`);

      const key = loadKey();
      if (!key) throw new RelayError("auth", "未连接中转站账户，请先在设置里填写 API Key。");

      task.outputPaths = await runImageGeneration(task.params, key, controller.signal);
      task.outputSizes = await Promise.all(
        task.outputPaths.map((outputPath) =>
          fs
            .stat(outputPath)
            .then((stat) => stat.size)
            .catch(() => 0)
        )
      );
      task.status = "succeeded";
      task.message = "已完成";
      task.error = null;
      log(`生图完成 输出 ${task.outputPaths.length} 张`);
    } catch (error) {
      const aborted = controller.signal.aborted;
      task.status = aborted ? "cancelled" : "failed";
      task.message = aborted ? "已取消" : "生成失败";
      task.error = aborted ? null : error instanceof Error ? error.message : String(error);
      task.needsTopup = !aborted && error instanceof RelayError && error.kind === "quota";
      log(`生图${aborted ? "取消" : "失败"} ${task.error ?? ""}`);
    } finally {
      task.finishedAt = Date.now();
      task.durationMs = task.startedAt ? Math.max(0, task.finishedAt - task.startedAt) : null;
      this.aborts.delete(task.id);
      this.emitNow();
      this.flushSync();
      this.onFinished?.(task);
    }
  }

  private emitNow(): void {
    if (this.uiTimer) {
      clearTimeout(this.uiTimer);
      this.uiTimer = null;
    }
    this.getWindow()?.webContents.send("image-tasks:updated", this.getTasks());
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist().catch((error) => {
        log(`生图任务保存失败 ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 500);
  }

  private stableForDisk(): ImageGenTask[] {
    return this.getTasks()
      .map((task) =>
        task.status === "running" || task.status === "queued"
          ? { ...task, status: "cancelled" as const, message: "上次关闭软件时已停止", finishedAt: task.finishedAt ?? Date.now() }
          : task
      )
      .slice(0, MAX_SAVED_IMAGE_TASKS);
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
      log(`生图任务同步保存失败 ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
