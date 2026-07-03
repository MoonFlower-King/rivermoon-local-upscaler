import { sanitizeSettings } from "./settings.js";
import type { UpscaleJob } from "./types.js";

/** 磁盘最多保留的历史任务条数。 */
export const MAX_SAVED_JOBS = 300;

/**
 * 把内存里的任务整理成适合落盘的稳定形态：
 * - 终态任务补算 durationMs；
 * - 仍在 running/queued 的任务标记为「上次关闭软件时已停止」（取消态）；
 * - 按创建时间倒序，最多保留 MAX_SAVED_JOBS 条。
 *
 * 纯函数（不触碰 electron / 磁盘），便于单元测试。
 */
export function stableJobsForDisk(jobs: UpscaleJob[], now: number = Date.now()): UpscaleJob[] {
  return jobs
    .map((job) => {
      if (job.status !== "running" && job.status !== "queued") {
        return { ...job, durationMs: normalizeDuration(job.durationMs, job.startedAt, job.finishedAt) };
      }
      const finishedAt = job.finishedAt ?? now;
      return {
        ...job,
        status: "cancelled" as const,
        progress: 100,
        finishedAt,
        durationMs: normalizeDuration(job.durationMs, job.startedAt, finishedAt),
        message: "上次关闭软件时已停止"
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_SAVED_JOBS);
}

/** 把磁盘上的任意 JSON 值规整成合法 UpscaleJob；缺少必要字段时返回 null。 */
export function normalizeJob(value: unknown, now: number = Date.now()): UpscaleJob | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<UpscaleJob>;
  if (typeof raw.id !== "string" || typeof raw.inputPath !== "string" || typeof raw.fileName !== "string") return null;
  const status = isStatus(raw.status) ? raw.status : "failed";
  const interrupted = status === "running" || status === "queued";
  return {
    id: raw.id,
    inputPath: raw.inputPath,
    outputPath: typeof raw.outputPath === "string" ? raw.outputPath : null,
    fileName: raw.fileName,
    status: interrupted ? "cancelled" : status,
    settings: sanitizeSettings(raw.settings),
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now,
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : null,
    finishedAt: typeof raw.finishedAt === "number" ? raw.finishedAt : interrupted ? now : null,
    durationMs:
      typeof raw.durationMs === "number"
        ? Math.max(0, raw.durationMs)
        : normalizeDuration(
            null,
            typeof raw.startedAt === "number" ? raw.startedAt : null,
            typeof raw.finishedAt === "number" ? raw.finishedAt : interrupted ? now : null
          ),
    progress: interrupted ? 100 : typeof raw.progress === "number" ? raw.progress : 100,
    message: interrupted ? "上次关闭软件时已停止" : typeof raw.message === "string" ? raw.message : "",
    error: typeof raw.error === "string" ? raw.error : null,
    dimensions: isDimensions(raw.dimensions) ? raw.dimensions : null,
    targetDimensions: isDimensions(raw.targetDimensions) ? raw.targetDimensions : null,
    // 旧版 jobs.json 里的 tileSize 等历史字段在此静默丢弃。
    outputBytes: typeof raw.outputBytes === "number" && Number.isFinite(raw.outputBytes) ? Math.max(0, raw.outputBytes) : null
  };
}

/** durationMs 归一化：有合法数值则取整，否则用 started/finished 差值，再否则 null。 */
export function normalizeDuration(
  value: unknown,
  startedAt: number | null | undefined,
  finishedAt: number | null | undefined
): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value));
  if (typeof startedAt === "number" && typeof finishedAt === "number") return Math.max(0, finishedAt - startedAt);
  return null;
}

function isStatus(value: unknown): value is UpscaleJob["status"] {
  return value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function isDimensions(value: unknown): value is UpscaleJob["dimensions"] {
  if (!value || typeof value !== "object") return false;
  const dimensions = value as { width?: unknown; height?: unknown };
  return typeof dimensions.width === "number" && typeof dimensions.height === "number";
}
