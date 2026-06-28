import type { AppInfo, AssetStatus, HardwareReport, StartJobsPayload, UpscaleJob, UpscaleSettings } from "../main/types";

declare global {
  interface Window {
    upscaler: {
      getPathForFile(file: File): string;
      getAssetStatus(): Promise<AssetStatus>;
      probeHardware(force?: boolean): Promise<HardwareReport>;
      getSettings(): Promise<UpscaleSettings>;
      saveSettings(settings: UpscaleSettings): Promise<UpscaleSettings>;
      getAppInfo(): Promise<AppInfo>;
      exportLogs(): Promise<string | null>;
      revealLogs(): Promise<void>;
      selectFiles(): Promise<string[]>;
      selectFolder(): Promise<string[]>;
      selectOutputDirectory(): Promise<string | null>;
      discoverFiles(paths: string[]): Promise<string[]>;
      startJobs(payload: StartJobsPayload): Promise<UpscaleJob[]>;
      listJobs(): Promise<UpscaleJob[]>;
      cancelJob(id: string): Promise<UpscaleJob | null>;
      clearFinished(): Promise<void>;
      reveal(filePath: string): Promise<void>;
      getPreview(filePath: string, maxSide?: number): Promise<string | null>;
      onJobsUpdated(callback: (jobs: UpscaleJob[]) => void): () => void;
    };
  }
}

export {};

