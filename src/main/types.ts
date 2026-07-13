export type ImageFormat = "auto" | "png" | "jpg" | "webp";
export type ConcreteImageFormat = Exclude<ImageFormat, "auto">;

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export type ProcessingMode = "webClear" | "aiUpscale" | "aiUpscaleWebClear";

/** 资源状态卡片用的质量档位标识（当前固定 standard = 网站同款 AI）。 */
export type QualityMode = "standard";

/**
 * 用户可调的超分设置——只保留真正可变的三项。
 * 链路（ComfyUI）、模型（4x-UltraSharp）、倍数（4x）均为产品固定常量，
 * 见 settings.ts 的 DEFAULT_MODEL / DEFAULT_SCALE，不再作为可配置字段。
 */
export type UpscaleSettings = {
  processingMode: ProcessingMode;
  outputFormat: ImageFormat;
  outputDirectory: string | null;
  /** 输出长边上限；0 = 不限制（真实放大倍数）。 */
  maxSide: number;
  /** 超分模型文件名（必须在 model-registry 注册表内）；默认网站同款 4x-UltraSharp。 */
  upscaleModel: string;
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
  /** 输出文件大小（字节）；任务成功后 stat 得到，供 UI 展示。 */
  outputBytes: number | null;
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

export type ImageGenEndpoint = "generation" | "edit" | "reference_edit";
export type ImageQuality = "low" | "medium" | "high" | "auto";
export type ImageOutputFormat = "png" | "jpeg" | "webp";
export type ImageFitMode = "contain" | "cover";
export type ImageSizeMode = "postprocess" | "native";

export type ImageContractModel = {
  publicName: string;
  internalName: string;
  label: string;
  visible: boolean;
  primary: boolean;
  endpoints: ImageGenEndpoint[];
  sizes: string[];
  qualities: ImageQuality[];
  outputFormats: ImageOutputFormat[];
  maxReferences: number;
  maxReferenceBytes: number;
  maxBodyBytes: number;
  supportsMask: boolean;
  supportsMultipleReferences: boolean;
  customSize: {
    enabled: boolean;
    minDimension: number;
    maxDimension: number;
    maxPixels: number;
    allowedRatios: string[];
    nativeRatiosOnly: boolean;
    mode: string | null;
    warning: string | null;
  };
  sizeModes: ImageSizeMode[];
  nativeRecommendedSizes: string[];
  notice: string | null;
};

export type ImageContract = {
  ok: boolean;
  models: ImageContractModel[];
  defaultModelId: string | null;
  contractVersion: string | null;
  fetchedAt: number;
  error: string | null;
};

/** 云端生图任务参数（经 sanitizeImageParams 规整后）。 */
export type ImageGenParams = {
  model: string;
  prompt: string;
  /** 形如 "1024x1024"。 */
  size: string;
  /** 单次生成张数 1-4。 */
  count: number;
  quality: ImageQuality;
  outputFormat: ImageOutputFormat;
  fitMode: ImageFitMode;
  sizeMode: ImageSizeMode;
  /** 参考图路径；非空时走网站同款 /v1/images/edits。 */
  referencePaths: string[];
};

export type ImageGenTask = {
  id: string;
  params: ImageGenParams;
  status: JobStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  message: string;
  error: string | null;
  /** 余额不足导致的失败：UI 显示充值引导。 */
  needsTopup: boolean;
  /** 落盘到资产库的图片绝对路径。 */
  outputPaths: string[];
  /** 与 outputPaths 逐项对齐的文件大小（字节）；stat 失败为 0。 */
  outputSizes: number[];
};

export type VideoTaskStatus = JobStatus | "expired";

export type VideoEndpoint = "text_to_video" | "image_to_video" | "reference_to_video" | "first_last_frame";

export type VideoReferenceType = "ordinary" | "reference" | "first_frame" | "last_frame" | "character" | "style";

export type VideoContractModel = {
  id: string;
  label: string;
  family: string;
  enabled: boolean;
  endpoints: VideoEndpoint[];
  aspectRatios: string[];
  durations: number[];
  resolutions: string[];
  maxReferences: number;
  referenceTypes: VideoReferenceType[];
  /** UI 使用规范化 endpoint；提交远端时按合同保留每个 endpoint 对应的原始值。 */
  requestEndpoints: Partial<Record<VideoEndpoint, string>>;
  primary: boolean;
  defaultAspectRatio: string | null;
  defaultDuration: number | null;
  defaultResolution: string | null;
  estimatedPriceUsd: number | null;
  notice: string | null;
};

export type VideoContract = {
  ok: boolean;
  models: VideoContractModel[];
  defaultModelId: string | null;
  fetchedAt: number;
  error: string | null;
  fromCache: boolean;
  source: "https" | "http" | "cache" | "unknown";
};

export type VideoGatewayDiagnostics = {
  checkedAt: number;
  host: string;
  dnsAddresses: string[];
  https: {
    ok: boolean;
    status: number | null;
    durationMs: number;
    modelCount: number | null;
    contractVersion: string | null;
    error: string | null;
  };
  httpFallback: {
    ok: boolean;
    status: number | null;
    durationMs: number;
    error: string | null;
  };
};

export type VideoGenParams = {
  model: string;
  prompt: string;
  endpoint: VideoEndpoint;
  /** 主进程按视频合同写入；用于保留 multi_reference 等服务端原始 endpoint 名。 */
  requestEndpoint?: string;
  aspectRatio: string;
  duration: number;
  resolution: string;
  referencePaths: string[];
  /** 兼容旧任务；新提交以 referenceTypes 逐图标记为准。 */
  referenceType: VideoReferenceType;
  referenceTypes: VideoReferenceType[];
};

export type VideoSourceSelection = {
  paths: string[];
  rejected: string[];
};

export type ImageSourceSelection = {
  paths: string[];
  rejected: string[];
};

export type VideoGenTask = {
  id: string;
  params: VideoGenParams;
  status: VideoTaskStatus;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  message: string;
  error: string | null;
  needsTopup: boolean;
  progress: number | null;
  remoteJobId: string | null;
  requestId: string | null;
  clientRequestId: string | null;
  dryRun: boolean;
  outputPath: string | null;
  outputBytes: number | null;
  contentUrl: string | null;
  downloadUrl: string | null;
  costUsd: number | null;
  estimatedCostUsd: number | null;
  charged: boolean;
  refunded: boolean;
};

export type AgentRole = "user" | "assistant";
export type AgentReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";

export type AgentAttachment = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  width?: number;
  height?: number;
  size?: number;
};

export type AgentMessage = {
  id: string;
  role: AgentRole;
  content: string;
  createdAt: number;
  attachments?: AgentAttachment[];
};

export type AgentConversation = {
  id: string;
  title: string;
  messages: AgentMessage[];
  model: string;
  reasoningEffort: AgentReasoningEffort;
  preview: string;
  renamed: boolean;
  createdAt: number;
  updatedAt: number;
};

export type AgentChatRequest = {
  requestId: string;
  model: string;
  reasoningEffort: AgentReasoningEffort;
  messages: AgentMessage[];
};

export type AgentChatResult = {
  ok: boolean;
  content: string;
  error: string | null;
  needsTopup: boolean;
};

export type AgentChatEvent = {
  requestId: string;
  delta?: string;
  done?: boolean;
  content?: string;
  error?: string;
  needsTopup?: boolean;
};

/** 超分模型下载状态（安装包不含权重，用户界面内自主下载）。 */
export type ModelDownloadState = {
  phase: "idle" | "downloading" | "verifying" | "failed" | "done";
  /** 正在（或最近一次）下载的模型文件名；空闲且从未下载时为 null。 */
  fileName: string | null;
  receivedBytes: number;
  totalBytes: number;
  message: string | null;
};

export type UpscaleModelInfo = {
  fileName: string;
  displayName: string;
  sizeBytes: number;
  license: string;
  commercial: boolean;
  tagline: string;
  installed: boolean;
  path: string | null;
};

export type UpscaleModelStatus = {
  /** 注册表全量模型及各自安装状态。 */
  models: UpscaleModelInfo[];
  /** 当前设置选用的模型（settings.upscaleModel 规整后）。 */
  selectedFileName: string;
  selectedInstalled: boolean;
  download: ModelDownloadState;
};

/** 中转站账户状态。渲染层只能拿到掩码 Key，永不接触明文。 */
export type AccountStatus = {
  connected: boolean;
  maskedKey: string | null;
  /** 该 Key 分组可用的模型 id 列表（驱动生图模型选择器）。 */
  models: string[];
  totalUsd: number | null;
  usedUsd: number | null;
  /** 校验/网络失败时的中文说明；正常为 null。 */
  error: string | null;
};

export type UpdateCheckSource = "github-release" | "github-tag" | "none";

export type UpdateInfo = {
  ok: boolean;
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  releaseUrl: string | null;
  source: UpdateCheckSource;
  checkedAt: number;
  error: string | null;
};

export type RendererReadyPayload = {
  activeModule: string;
  modules: string[];
  videoNav: boolean;
};

/**
 * preload 经 contextBridge 暴露到 window.upscaler 的 API 契约。
 * preload（实现）与 renderer 的 global.d.ts（声明）共用此接口，避免两处定义漂移。
 */
export interface UpscalerApi {
  reportRendererReady(payload: RendererReadyPayload): void;
  getPathForFile(file: File): string;
  getAssetStatus(): Promise<AssetStatus>;
  probeHardware(force?: boolean): Promise<HardwareReport>;
  getSettings(): Promise<UpscaleSettings>;
  saveSettings(settings: UpscaleSettings): Promise<UpscaleSettings>;
  getAppInfo(): Promise<AppInfo>;
  checkForUpdates(): Promise<UpdateInfo>;
  openUpdatePage(url: string): Promise<void>;
  exportLogs(): Promise<string | null>;
  revealLogs(): Promise<void>;
  copyText(text: string): Promise<void>;
  selectFiles(): Promise<string[]>;
  selectImageReferences(): Promise<ImageSourceSelection>;
  selectVideoSources(): Promise<VideoSourceSelection>;
  selectFolder(): Promise<string[]>;
  selectOutputDirectory(): Promise<string | null>;
  discoverFiles(paths: string[]): Promise<string[]>;
  startJobs(payload: StartJobsPayload): Promise<UpscaleJob[]>;
  listJobs(): Promise<UpscaleJob[]>;
  cancelJob(id: string): Promise<UpscaleJob | null>;
  clearFinished(): Promise<void>;
  reveal(filePath: string): Promise<void>;
  getPreview(filePath: string, maxSide?: number, quality?: number): Promise<string | null>;
  onJobsUpdated(callback: (jobs: UpscaleJob[]) => void): () => void;
  /** 账户（中转站 Key）。setRelayKey 校验通过才保存，失败 reject 中文错误。 */
  getAccountStatus(force?: boolean): Promise<AccountStatus>;
  setRelayKey(key: string): Promise<AccountStatus>;
  clearRelayKey(): Promise<AccountStatus>;
  /** 打开充值页（主进程白名单校验，仅允许 rivermoon7.com）。 */
  openTopup(): Promise<void>;
  /** 云端生图任务。start 返回 null 表示参数非法（如空 prompt）。 */
  getImageContract(): Promise<ImageContract>;
  startImageTask(params: ImageGenParams): Promise<ImageGenTask | null>;
  listImageTasks(): Promise<ImageGenTask[]>;
  cancelImageTask(id: string): Promise<void>;
  clearFinishedImageTasks(): Promise<void>;
  onImageTasksUpdated(callback: (tasks: ImageGenTask[]) => void): () => void;
  /** 云端视频生成任务。 */
  getVideoContract(): Promise<VideoContract>;
  getVideoGatewayDiagnostics(): Promise<VideoGatewayDiagnostics>;
  startVideoTask(params: VideoGenParams): Promise<VideoGenTask | null>;
  listVideoTasks(): Promise<VideoGenTask[]>;
  syncRecentVideoTasks(): Promise<VideoGenTask[]>;
  cancelVideoTask(id: string): Promise<void>;
  resumeVideoTask(id: string): Promise<VideoGenTask | null>;
  retryVideoTask(id: string): Promise<VideoGenTask | null>;
  clearFinishedVideoTasks(): Promise<void>;
  onVideoTasksUpdated(callback: (tasks: VideoGenTask[]) => void): () => void;
  /** GPT 对话模块。Key 只在主进程读取，渲染层只接收流式文本事件。 */
  startAgentResponse(request: AgentChatRequest): Promise<AgentChatResult>;
  cancelAgentResponse(requestId: string): Promise<void>;
  onAgentResponseEvent(callback: (event: AgentChatEvent) => void): () => void;
  /** 受主进程路径白名单保护的本地媒体 file:// URL，用于 video 预览。 */
  getMediaUrl(filePath: string): Promise<string | null>;
  /** 超分模型按需下载。 */
  getModelStatus(): Promise<UpscaleModelStatus>;
  downloadModel(fileName: string): Promise<void>;
  cancelModelDownload(): Promise<void>;
  onModelDownload(callback: (state: ModelDownloadState) => void): () => void;
}
