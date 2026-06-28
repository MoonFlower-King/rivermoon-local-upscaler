import { contextBridge, ipcRenderer, webUtils } from "electron";

const api = {
  // Electron 32+ 移除了 File.path，拖拽文件改用 webUtils.getPathForFile 取真实路径。
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  getAssetStatus: () => ipcRenderer.invoke("assets:status"),
  probeHardware: (force?: boolean) => ipcRenderer.invoke("hardware:probe", force),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: unknown) => ipcRenderer.invoke("settings:save", settings),
  getAppInfo: () => ipcRenderer.invoke("app:get-info"),
  exportLogs: () => ipcRenderer.invoke("logs:export"),
  revealLogs: () => ipcRenderer.invoke("logs:reveal"),
  selectFiles: () => ipcRenderer.invoke("dialog:select-files"),
  selectFolder: () => ipcRenderer.invoke("dialog:select-folder"),
  selectOutputDirectory: () => ipcRenderer.invoke("dialog:select-output-directory"),
  discoverFiles: (paths: string[]) => ipcRenderer.invoke("files:discover", paths),
  startJobs: (payload: unknown) => ipcRenderer.invoke("jobs:start", payload),
  listJobs: () => ipcRenderer.invoke("jobs:list"),
  cancelJob: (id: string) => ipcRenderer.invoke("jobs:cancel", id),
  clearFinished: () => ipcRenderer.invoke("jobs:clear-finished"),
  reveal: (filePath: string) => ipcRenderer.invoke("shell:reveal", filePath),
  getPreview: (filePath: string, maxSide?: number) => ipcRenderer.invoke("image:preview", filePath, maxSide),
  onJobsUpdated: (callback: (jobs: unknown[]) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, jobs: unknown[]) => callback(jobs);
    ipcRenderer.on("jobs:updated", listener);
    return () => ipcRenderer.removeListener("jobs:updated", listener);
  }
};

contextBridge.exposeInMainWorld("upscaler", api);

