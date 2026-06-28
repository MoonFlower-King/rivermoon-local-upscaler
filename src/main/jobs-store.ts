import { app } from "electron";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeSettings } from "./settings.js";
import type { UpscaleJob } from "./types.js";

const MAX_SAVED_JOBS = 300;

function jobsPath(): string {
  return path.join(app.getPath("userData"), "jobs.json");
}

export async function loadSavedJobs(): Promise<UpscaleJob[]> {
  try {
    const text = await fs.readFile(jobsPath(), "utf8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeJob)
      .filter((job): job is UpscaleJob => Boolean(job))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_SAVED_JOBS);
  } catch {
    return [];
  }
}

export async function saveJobs(jobs: UpscaleJob[]): Promise<void> {
  const stableJobs = stableJobsForDisk(jobs);
  await fs.mkdir(path.dirname(jobsPath()), { recursive: true });
  await fs.writeFile(jobsPath(), JSON.stringify(stableJobs, null, 2), "utf8");
}

export function saveJobsSync(jobs: UpscaleJob[]): void {
  const stableJobs = stableJobsForDisk(jobs);
  fsSync.mkdirSync(path.dirname(jobsPath()), { recursive: true });
  fsSync.writeFileSync(jobsPath(), JSON.stringify(stableJobs, null, 2), "utf8");
}

function stableJobsForDisk(jobs: UpscaleJob[]): UpscaleJob[] {
  return jobs
    .map((job) => {
      if (job.status !== "running" && job.status !== "queued") {
        return { ...job, durationMs: normalizeDuration(job.durationMs, job.startedAt, job.finishedAt) };
      }
      const finishedAt = job.finishedAt ?? Date.now();
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

function normalizeJob(value: unknown): UpscaleJob | null {
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
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : null,
    finishedAt: typeof raw.finishedAt === "number" ? raw.finishedAt : interrupted ? Date.now() : null,
    durationMs:
      typeof raw.durationMs === "number"
        ? Math.max(0, raw.durationMs)
        : normalizeDuration(
            null,
            typeof raw.startedAt === "number" ? raw.startedAt : null,
            typeof raw.finishedAt === "number" ? raw.finishedAt : interrupted ? Date.now() : null
          ),
    progress: interrupted ? 100 : typeof raw.progress === "number" ? raw.progress : 100,
    message: interrupted ? "上次关闭软件时已停止" : typeof raw.message === "string" ? raw.message : "",
    error: typeof raw.error === "string" ? raw.error : null,
    dimensions: isDimensions(raw.dimensions) ? raw.dimensions : null,
    targetDimensions: isDimensions(raw.targetDimensions) ? raw.targetDimensions : null,
    tileSize: typeof raw.tileSize === "number" ? raw.tileSize : null
  };
}

function normalizeDuration(value: unknown, startedAt: number | null | undefined, finishedAt: number | null | undefined): number | null {
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
