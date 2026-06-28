export type ImageFormat = "png" | "jpg" | "webp";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** 资源状态卡片用的质量档位标识（当前固定 standard = 网站同款 AI）。 */
export type QualityMode = "standard";

/**
 * 用户可调的超分设置——只保留真正可变的三项。
 * 链路（ComfyUI）、模型（4x-UltraSharp）、倍数（4x）均为产品固定常量，
 * 见 settings.ts 的 DEFAULT_MODEL / DEFAULT_SCALE，不再作为可配置字段。
 */
export type UpscaleSettings = {
  outputFormat: ImageFormat;
  outputDirectory: string | null;
  /** 输出长边上限；0 = 不限制（真实放大倍数）。 */
  maxSide: number;
};

export type ImageDimensions = {
  width: number;
  height: number;
};

export type UpscaleJob = {
  id: string;
  inputPath: string;
  outputPath: string | null;
  fileName: string;
  status: JobStatus;
  settings: UpscaleSettings;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  progress: number;
  message: string;
  error: string | null;
  dimensions: ImageDimensions | null;
  targetDimensions: ImageDimensions | null;
  tileSize: number | null;
};

export type AssetStatus = {
  ok: boolean;
  comfyuiRuntimePath: string | null;
  comfyuiPythonPath: string | null;
  comfyuiModelPath: string | null;
  modelsPath: string;
  missing: string[];
  comfyuiModels: string[];
  qualityModes: Record<QualityMode, { ok: boolean; label: string; missing: string[] }>;
  resourcesRoot: string;
};

export type AppInfo = {
  name: string;
  version: string;
  electron: string;
  comfyuiRuntimePath: string | null;
  comfyuiModels: string[];
  qualityModes: AssetStatus["qualityModes"];
  resourcesRoot: string;
};

export type GpuInfo = {
  name: string;
  driverVersion: string | null;
};

export type HardwareReport = {
  /** 整条链路是否可用：引擎存在且兼容性自检通过。 */
  ok: boolean;
  comfyuiRuntimeFound: boolean;
  comfyuiCudaAvailable: boolean;
  cudaDevices: string[];
  /** 系统枚举到的全部显卡（含远程桌面虚拟显示器），仅供展示。 */
  gpus: GpuInfo[];
  durationMs: number | null;
  /** 中文问题描述，按发现顺序。 */
  issues: string[];
  /** 中文修复建议。 */
  hints: string[];
};

export type StartJobsPayload = {
  paths: string[];
  settings: UpscaleSettings;
};

/**
 * preload 经 contextBridge 暴露到 window.upscaler 的 API 契约。
 * preload（实现）与 renderer 的 global.d.ts（声明）共用此接口，避免两处定义漂移。
 */
export interface UpscalerApi {
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
}
