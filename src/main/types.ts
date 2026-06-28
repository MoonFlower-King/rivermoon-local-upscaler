export type ImageFormat = "png" | "jpg" | "webp";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type EngineMode = "comfyui";

export type QualityMode = "standard";

export type UpscaleSettings = {
  /** 网站同款 PyTorch/CUDA 链路。 */
  engineMode: EngineMode;
  /** standard = 4x-UltraSharp 网站同款 AI。 */
  qualityMode: QualityMode;
  model: string;
  outputFormat: ImageFormat;
  outputDirectory: string | null;
  maxSide: number;
  scale: 2 | 3 | 4;
  tileMode: "auto" | "512" | "256" | "128";
  gpuId: "auto" | string;
  /** 超分后是否套用网页同款增强（饱和/对比/锐化的通透感）。 */
  enhance: boolean;
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
