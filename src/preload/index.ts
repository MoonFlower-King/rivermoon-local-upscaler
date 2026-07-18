import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AgentChatEvent,
  AgentChatRequest,
  ImageGenParams,
  ImageGenTask,
  ModelDownloadState,
  RendererReadyPayload,
  UpscaleJob,
  UpscalerApi,
  VideoGenParams,
  VideoGenTask
} from "../main/types.js";

const api = {
  reportRendererReady: (payload: RendererReadyPayload) => ipcRenderer.send("app:renderer-ready", payload),
  // Electron 32+ 移除了 File.path，拖拽文件改用 webUtils.getPathForFile 取真实路径。
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  getAssetStatus: () => ipcRenderer.invoke("assets:status"),
  probeHardware: (force?: boolean) => ipcRenderer.invoke("hardware:probe", force),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: unknown) => ipcRenderer.invoke("settings:save", settings),
  getAppInfo: () => ipcRenderer.invoke("app:get-info"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  openUpdatePage: (url: string) => ipcRenderer.invoke("updates:open-release", url),
  exportLogs: () => ipcRenderer.invoke("logs:export"),
  revealLogs: () => ipcRenderer.invoke("logs:reveal"),
  copyText: (text: string) => ipcRenderer.invoke("clipboard:write-text", text),
  selectFiles: () => ipcRenderer.invoke("dialog:select-files"),
  selectImageReferences: () => ipcRenderer.invoke("dialog:select-image-references"),
  selectVideoSources: () => ipcRenderer.invoke("dialog:select-video-sources"),
  selectFolder: () => ipcRenderer.invoke("dialog:select-folder"),
  selectOutputDirectory: () => ipcRenderer.invoke("dialog:select-output-directory"),
  discoverFiles: (paths: string[]) => ipcRenderer.invoke("files:discover", paths),
  startJobs: (payload: unknown) => ipcRenderer.invoke("jobs:start", payload),
  listJobs: () => ipcRenderer.invoke("jobs:list"),
  cancelJob: (id: string) => ipcRenderer.invoke("jobs:cancel", id),
  removeJob: (id: string) => ipcRenderer.invoke("jobs:remove", id),
  clearFinished: () => ipcRenderer.invoke("jobs:clear-finished"),
  reveal: (filePath: string) => ipcRenderer.invoke("shell:reveal", filePath),
  getPreview: (filePath: string, maxSide?: number, quality?: number) =>
    ipcRenderer.invoke("image:preview", filePath, maxSide, quality),
  getAccountStatus: (force?: boolean) => ipcRenderer.invoke("account:get-status", force),
  setRelayKey: (key: string) => ipcRenderer.invoke("account:set-key", key),
  clearRelayKey: () => ipcRenderer.invoke("account:clear-key"),
  openTopup: () => ipcRenderer.invoke("account:open-topup"),
  onJobsUpdated: (callback: (jobs: UpscaleJob[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, jobs: unknown[]) => callback(jobs as UpscaleJob[]);
    ipcRenderer.on("jobs:updated", listener);
    return () => ipcRenderer.removeListener("jobs:updated", listener);
  },
  getImageContract: () => ipcRenderer.invoke("image:contract"),
  startImageTask: (params: ImageGenParams) => ipcRenderer.invoke("image-gen:start", params),
  listImageTasks: () => ipcRenderer.invoke("image-gen:list"),
  cancelImageTask: (id: string) => ipcRenderer.invoke("image-gen:cancel", id),
  clearFinishedImageTasks: () => ipcRenderer.invoke("image-gen:clear-finished"),
  onImageTasksUpdated: (callback: (tasks: ImageGenTask[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tasks: unknown[]) => callback(tasks as ImageGenTask[]);
    ipcRenderer.on("image-tasks:updated", listener);
    return () => ipcRenderer.removeListener("image-tasks:updated", listener);
  },
  getVideoContract: () => ipcRenderer.invoke("video:contract"),
  getVideoGatewayDiagnostics: () => ipcRenderer.invoke("video:diagnostics"),
  startVideoTask: (params: VideoGenParams) => ipcRenderer.invoke("video-gen:start", params),
  listVideoTasks: () => ipcRenderer.invoke("video-gen:list"),
  syncRecentVideoTasks: () => ipcRenderer.invoke("video-gen:sync-recent"),
  cancelVideoTask: (id: string) => ipcRenderer.invoke("video-gen:cancel", id),
  resumeVideoTask: (id: string) => ipcRenderer.invoke("video-gen:resume", id),
  retryVideoTask: (id: string) => ipcRenderer.invoke("video-gen:retry", id),
  clearFinishedVideoTasks: () => ipcRenderer.invoke("video-gen:clear-finished"),
  onVideoTasksUpdated: (callback: (tasks: VideoGenTask[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, tasks: unknown[]) => callback(tasks as VideoGenTask[]);
    ipcRenderer.on("video-tasks:updated", listener);
    return () => ipcRenderer.removeListener("video-tasks:updated", listener);
  },
  startAgentResponse: (request: AgentChatRequest) => ipcRenderer.invoke("agent-chat:start", request),
  cancelAgentResponse: (requestId: string) => ipcRenderer.invoke("agent-chat:cancel", requestId),
  onAgentResponseEvent: (callback: (event: AgentChatEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, event: unknown) => callback(event as AgentChatEvent);
    ipcRenderer.on("agent-chat:event", listener);
    return () => ipcRenderer.removeListener("agent-chat:event", listener);
  },
  getMediaUrl: (filePath: string) => ipcRenderer.invoke("media:local-url", filePath),
  getModelStatus: () => ipcRenderer.invoke("model:get-status"),
  downloadModel: (fileName: string) => ipcRenderer.invoke("model:download", fileName),
  cancelModelDownload: () => ipcRenderer.invoke("model:cancel-download"),
  onModelDownload: (callback: (state: ModelDownloadState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: unknown) => callback(state as ModelDownloadState);
    ipcRenderer.on("model:download-update", listener);
    return () => ipcRenderer.removeListener("model:download-update", listener);
  }
} satisfies UpscalerApi;

contextBridge.exposeInMainWorld("upscaler", api);
