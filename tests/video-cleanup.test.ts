import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupStaleVideoDownloads, videoAssetsRootForUserData } from "../src/main/cloud/video-cleanup";

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

describe("video download cleanup", () => {
  it("启动清理只移除视频资产目录里的 .download 半成品", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rivermoon-video-cleanup-"));
    const videosRoot = videoAssetsRootForUserData(root);
    const monthDir = path.join(videosRoot, "2026-07");
    const staleRoot = path.join(videosRoot, "root.mp4.download");
    const staleNested = path.join(monthDir, "job.mp4.download");
    const completed = path.join(monthDir, "job.mp4");
    const similarName = path.join(monthDir, "job.mp4.download.bak");
    const outside = path.join(root, "assets", "images", "image.png.download");

    await fs.mkdir(monthDir, { recursive: true });
    await fs.mkdir(path.dirname(outside), { recursive: true });
    await Promise.all([
      fs.writeFile(staleRoot, "partial"),
      fs.writeFile(staleNested, "partial"),
      fs.writeFile(completed, "video"),
      fs.writeFile(similarName, "backup"),
      fs.writeFile(outside, "image")
    ]);

    try {
      await expect(cleanupStaleVideoDownloads(path.join(root, "missing"))).resolves.toEqual({ removed: 0, failed: 0 });
      await expect(cleanupStaleVideoDownloads(videosRoot)).resolves.toEqual({ removed: 2, failed: 0 });
      await expect(exists(staleRoot)).resolves.toBe(false);
      await expect(exists(staleNested)).resolves.toBe(false);
      await expect(exists(completed)).resolves.toBe(true);
      await expect(exists(similarName)).resolves.toBe(true);
      await expect(exists(outside)).resolves.toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
