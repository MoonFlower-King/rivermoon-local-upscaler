import fs from "node:fs/promises";
import path from "node:path";

export type VideoDownloadCleanupResult = {
  removed: number;
  failed: number;
};

export function videoAssetsRootForUserData(userDataRoot: string): string {
  return path.join(userDataRoot, "assets", "videos");
}

export async function cleanupStaleVideoDownloads(videosRoot: string): Promise<VideoDownloadCleanupResult> {
  return cleanupDirectory(videosRoot);
}

async function cleanupDirectory(dir: string): Promise<VideoDownloadCleanupResult> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { removed: 0, failed: 0 };
  }

  let removed = 0;
  let failed = 0;
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const result = await cleanupDirectory(entryPath);
      removed += result.removed;
      failed += result.failed;
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".download")) continue;
    try {
      await fs.rm(entryPath, { force: true });
      removed += 1;
    } catch {
      failed += 1;
    }
  }

  return { removed, failed };
}
