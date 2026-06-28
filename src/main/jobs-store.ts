import { app } from "electron";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { MAX_SAVED_JOBS, normalizeJob, stableJobsForDisk } from "./jobs-normalize.js";
import type { UpscaleJob } from "./types.js";

function jobsPath(): string {
  return path.join(app.getPath("userData"), "jobs.json");
}

export async function loadSavedJobs(): Promise<UpscaleJob[]> {
  try {
    const text = await fs.readFile(jobsPath(), "utf8");
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((value) => normalizeJob(value))
      .filter((job): job is UpscaleJob => Boolean(job))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_SAVED_JOBS);
  } catch {
    return [];
  }
}

export async function saveJobs(jobs: UpscaleJob[]): Promise<void> {
  const stableJobs = stableJobsForDisk(jobs);
  const target = jobsPath();
  const tmp = `${target}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  // 原子写：先写临时文件再 rename 覆盖，避免写入途中崩溃导致 jobs.json 截断损坏。
  await fs.writeFile(tmp, JSON.stringify(stableJobs, null, 2), "utf8");
  await fs.rename(tmp, target);
}

export function saveJobsSync(jobs: UpscaleJob[]): void {
  const stableJobs = stableJobsForDisk(jobs);
  const target = jobsPath();
  const tmp = `${target}.tmp`;
  fsSync.mkdirSync(path.dirname(target), { recursive: true });
  fsSync.writeFileSync(tmp, JSON.stringify(stableJobs, null, 2), "utf8");
  fsSync.renameSync(tmp, target);
}
