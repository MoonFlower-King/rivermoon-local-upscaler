import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Clapperboard,
  FolderKanban,
  ImageUp,
  Images,
  MessageSquareText,
  PencilLine,
  Plus,
  Settings as SettingsIcon,
  Trash2,
  WalletCards
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { DEFAULT_SETTINGS } from "../main/settings";
import type {
  AccountStatus,
  AgentAttachment,
  AgentChatEvent,
  AgentConversation,
  AgentMessage,
  AgentReasoningEffort,
  AppInfo,
  AssetStatus,
  HardwareReport,
  ImageContract,
  ImageContractModel,
  ImageFitMode,
  ImageGenParams,
  ImageGenTask,
  ImageOutputFormat,
  ImageQuality,
  ImageSizeMode,
  ProcessingMode,
  UpdateInfo,
  UpscaleJob,
  UpscaleModelStatus,
  UpscaleSettings,
  VideoContract,
  VideoContractModel,
  VideoEndpoint,
  VideoGatewayDiagnostics,
  VideoGenTask,
  VideoReferenceType
} from "../main/types";
import "./styles.css";
import {
  IMAGE_CONV_KEY,
  createImageConversation,
  loadImageConversations,
  migrateLegacyImageTasks,
  normalizeImageConversation,
  saveImageConversations,
  type ImageConversation
} from "./image-conversations";
import {
  MAX_IMAGE_EDIT_REFERENCES,
  REDACTED_IMAGE_REFERENCE_PATH,
  addImageEditReference,
  imageModelSupportsEditing,
  resolveImageRerunReferences
} from "./image-edit-state";
import { appendImageTaskIdInSubmissionOrder, mergeImageTaskTimeline } from "./image-task-timeline";
import { IMAGE_TOPUP_REQUIRED_MESSAGE, imageAccountNeedsTopup } from "./image-submit-state";
import { videoTaskDiagnosticText } from "./video-diagnostics";
import { pruneVideoReferenceTypeMap, resolveRendererVideoReferenceTypes } from "./video-reference-types";
import { videoSubmitBlockReason } from "./video-submit-state";

type ModuleId = "upscale" | "imagegen" | "videogen" | "agent" | "assets" | "settings";

type NavItem = { id: ModuleId; label: string; icon: LucideIcon; badge?: string };

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "创作",
    items: [
      { id: "imagegen", label: "AI 生图", icon: Images },
      { id: "videogen", label: "AI 视频", icon: Clapperboard },
      { id: "agent", label: "GPT 对话", icon: MessageSquareText }
    ]
  },
  {
    label: "工具",
    items: [
      { id: "upscale", label: "图片超分", icon: ImageUp, badge: "本地" },
      { id: "assets", label: "资产库", icon: FolderKanban }
    ]
  }
];
const SETTINGS_NAV_ITEM: NavItem = { id: "settings", label: "设置", icon: SettingsIcon };
const NAV_ITEMS = [...NAV_GROUPS.flatMap((group) => group.items), SETTINGS_NAV_ITEM];
const MODULE_STORAGE_KEY = "rivermoon-active-module-v2";

function loadActiveModule(): ModuleId {
  const saved = window.localStorage.getItem(MODULE_STORAGE_KEY);
  return NAV_ITEMS.some((item) => item.id === saved) ? (saved as ModuleId) : "imagegen";
}

function App() {
  const [assetStatus, setAssetStatus] = useState<AssetStatus | null>(null);
  const [jobs, setJobs] = useState<UpscaleJob[]>([]);
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);
  const [settings, setSettings] = useState<UpscaleSettings>(DEFAULT_SETTINGS);
  const [isDragging, setIsDragging] = useState(false);
  const [hardware, setHardware] = useState<HardwareReport | null>(null);
  const [hardwareLoading, setHardwareLoading] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const [compareJob, setCompareJob] = useState<UpscaleJob | null>(null);
  const [now, setNow] = useState(Date.now());
  const [module, setModule] = useState<ModuleId>(() => loadActiveModule());
  const initialModuleRef = useRef(module);
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [imageContract, setImageContract] = useState<ImageContract | null>(null);
  const [imageTasks, setImageTasks] = useState<ImageGenTask[]>([]);
  const [imageTasksLoaded, setImageTasksLoaded] = useState(false);
  const [videoTasks, setVideoTasks] = useState<VideoGenTask[]>([]);
  const [videoContract, setVideoContract] = useState<VideoContract | null>(null);
  const [modelStatus, setModelStatus] = useState<UpscaleModelStatus | null>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    window.upscaler.reportRendererReady({
      activeModule: initialModuleRef.current,
      modules: NAV_ITEMS.map((item) => item.id),
      videoNav: NAV_ITEMS.some((item) => item.id === "videogen")
    });
    void init();
    const unsubscribeJobs = window.upscaler.onJobsUpdated(setJobs);
    const unsubscribeImages = window.upscaler.onImageTasksUpdated((tasks) => {
      setImageTasks(tasks);
      setImageTasksLoaded(true);
    });
    const unsubscribeVideos = window.upscaler.onVideoTasksUpdated(setVideoTasks);
    const unsubscribeModel = window.upscaler.onModelDownload((state) => {
      setModelStatus((current) => (current ? { ...current, download: state } : current));
      if (state.phase === "done") {
        // 下载完成：重新探测模型与资源状态，超分链路即刻可用。
        void window.upscaler.getModelStatus().then(setModelStatus);
        void refresh();
      }
    });
    return () => {
      unsubscribeJobs();
      unsubscribeImages();
      unsubscribeVideos();
      unsubscribeModel();
    };
    // init 只应在挂载时执行一次，依赖数组刻意留空。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 云端任务到达终态后刷新余额（主进程已把账户缓存失效，这里只需重取）。
  const finishedCloudTaskCount =
    imageTasks.filter((task) => task.status === "succeeded" || task.status === "failed" || task.status === "cancelled")
      .length +
    videoTasks.filter(
      (task) =>
        task.status === "succeeded" ||
        task.status === "failed" ||
        task.status === "cancelled" ||
        task.status === "expired"
    ).length;
  useEffect(() => {
    if (finishedCloudTaskCount === 0) return;
    const timer = setTimeout(() => void window.upscaler.getAccountStatus().then(setAccount), 1200);
    return () => clearTimeout(timer);
  }, [finishedCloudTaskCount]);

  // 窗口重新聚焦时刷新资源、任务与账户状态；充值返回后也能立即解除余额门禁。
  useEffect(() => {
    const onFocus = () => {
      void refresh();
      void window.upscaler.getAccountStatus(true).then(setAccount);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // 设置变更后防抖持久化（跳过首屏加载阶段）。
  useEffect(() => {
    if (!settingsLoaded) return;
    const timer = setTimeout(() => void window.upscaler.saveSettings(settings), 400);
    return () => clearTimeout(timer);
  }, [settings, settingsLoaded]);

  useEffect(() => {
    const hasRunning =
      jobs.some((job) => job.status === "running") ||
      imageTasks.some((task) => task.status === "running") ||
      videoTasks.some((task) => task.status === "running");
    if (!hasRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [jobs, imageTasks, videoTasks]);

  async function init() {
    const [assets, saved, currentJobs, info, currentImageTasks, currentVideoTasks, currentModel, currentImageContract] =
      await Promise.all([
        window.upscaler.getAssetStatus(),
        window.upscaler.getSettings(),
        window.upscaler.listJobs(),
        window.upscaler.getAppInfo(),
        window.upscaler.listImageTasks(),
        window.upscaler.listVideoTasks(),
        window.upscaler.getModelStatus(),
        window.upscaler.getImageContract()
      ]);
    setAssetStatus(assets);
    setJobs(currentJobs);
    setImageTasks(currentImageTasks);
    setVideoTasks(currentVideoTasks);
    setModelStatus(currentModel);
    setImageContract(currentImageContract);
    setAppInfo(info);
    setSettings(saved);
    setSettingsLoaded(true);
    setImageTasksLoaded(true);
    // 启动即自动自检（命中缓存时瞬时返回），用户不再需要自己发现“检测”按钮。
    void probeHardware(false);
    // 账户状态并行加载，不阻塞首屏。
    void window.upscaler.getAccountStatus().then(setAccount);
    // 视频合同不阻塞首屏；用户进入 AI 视频页时若失败可手动同步。
    void window.upscaler.getVideoContract().then(setVideoContract);
  }

  async function connectKey(key: string) {
    setAccountBusy(true);
    try {
      setAccount(await window.upscaler.setRelayKey(key));
    } finally {
      setAccountBusy(false);
    }
  }

  async function disconnectKey() {
    setAccount(await window.upscaler.clearRelayKey());
  }

  async function probeHardware(force: boolean) {
    setHardwareLoading(true);
    try {
      setHardware(await window.upscaler.probeHardware(force));
    } finally {
      setHardwareLoading(false);
    }
  }

  async function refresh() {
    const [assets, currentJobs] = await Promise.all([window.upscaler.getAssetStatus(), window.upscaler.listJobs()]);
    setAssetStatus(assets);
    setJobs(currentJobs);
  }

  async function addFiles() {
    addPending(await window.upscaler.selectFiles());
  }

  async function addFolder() {
    addPending(await window.upscaler.selectFolder());
  }

  async function selectOutputDirectory() {
    const directory = await window.upscaler.selectOutputDirectory();
    if (directory) setSettings((current) => ({ ...current, outputDirectory: directory }));
  }

  function addPending(paths: string[]) {
    setPendingPaths((current) => Array.from(new Set([...current, ...paths])));
  }

  async function start() {
    if (pendingPaths.length === 0 || !chainReady) return;
    await window.upscaler.startJobs({ paths: pendingPaths, settings });
    setPendingPaths([]);
  }

  function retryJob(job: UpscaleJob) {
    void window.upscaler.startJobs({ paths: [job.inputPath], settings: job.settings });
  }

  function selectModule(next: ModuleId) {
    setModule(next);
    window.localStorage.setItem(MODULE_STORAGE_KEY, next);
  }

  /** 「超分到 4K」联动：云端产物直接进本地超分队列并切到超分模块。 */
  function upscaleImage(path: string) {
    void window.upscaler.startJobs({ paths: [path], settings });
    selectModule("upscale");
  }

  function registerImageTask(task: ImageGenTask) {
    setImageTasks((current) =>
      current.some((item) => item.id === task.id)
        ? current
        : [task, ...current].sort((left, right) => right.createdAt - left.createdAt)
    );
  }

  // 生图模块注册的拖图接收器（命令式通道：事件回调里 setState，规避 effect 内 setState）。
  const imageDropHandler = useRef<((paths: string[]) => void) | null>(null);
  const registerImageDropHandler = useCallback((handler: ((paths: string[]) => void) | null) => {
    imageDropHandler.current = handler;
  }, []);

  // 拖拽计数：dragleave 在进入子元素时也会触发，必须配对计数才能避免高亮闪烁。
  function handleDragEnter(event: React.DragEvent) {
    event.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  }

  function handleDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  }

  async function handleDrop(event: React.DragEvent) {
    event.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => window.upscaler.getPathForFile(file))
      .filter((filePath): filePath is string => Boolean(filePath));
    if (paths.length === 0) return;
    const files = await window.upscaler.discoverFiles(paths);
    if (files.length === 0) return;
    // 按当前模块分流：生图模块拖入 = 加为参考图（走编辑链路）；
    // 超分/资产库拖入 = 进超分待处理；其他模块不劫持导航。
    if (module === "imagegen") {
      imageDropHandler.current?.(files);
      return;
    }
    if (module === "upscale" || module === "assets") {
      addPending(files);
      selectModule("upscale");
    }
  }

  const counts = useMemo(() => {
    return jobs.reduce(
      (acc, job) => {
        acc[job.status] += 1;
        return acc;
      },
      { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 }
    );
  }, [jobs]);

  const chainStatus = assetStatus?.qualityModes.standard;
  // 所选模型是否已安装用渲染层实时值判断（settings 防抖落盘前主进程视角会滞后 400ms）。
  const selectedModelInstalled = modelStatus
    ? modelStatus.models.some((model) => model.fileName === settings.upscaleModel && model.installed)
    : true;
  const needsAiResources = settings.processingMode !== "webClear";
  const chainReady = !needsAiResources || Boolean(chainStatus?.ok);
  const hasContent = pendingPaths.length > 0 || jobs.length > 0;
  const nonAgentCloudModels = useMemo(
    () =>
      Array.from(
        new Set([
          ...(imageContract?.models.flatMap((model) => [model.publicName, model.internalName]) ?? []),
          ...(videoContract?.models.map((model) => model.id) ?? [])
        ])
      ),
    [imageContract, videoContract]
  );

  return (
    <main
      className="shell"
      onDragEnter={handleDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={handleDragLeave}
      onDrop={(event) => void handleDrop(event)}
    >
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">
            <BrandMark size={20} framed />
          </span>
          <span className="sidebar-brand-copy">
            <strong>RiverMoon</strong>
            <small>AI 创作台</small>
          </span>
        </div>
        <nav className="sidebar-nav">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{group.label}</span>
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    className={`nav-item ${module === item.id ? "on" : ""}`}
                    onClick={() => selectModule(item.id)}
                  >
                    <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
                    <span>{item.label}</span>
                    {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <span className="spacer" />
        <AccountCard
          account={account}
          onTopup={() => void window.upscaler.openTopup()}
          onGoSettings={() => selectModule("settings")}
        />
        <button
          className={`nav-item nav-settings ${module === SETTINGS_NAV_ITEM.id ? "on" : ""}`}
          onClick={() => selectModule("settings")}
        >
          <SettingsIcon size={16} strokeWidth={1.8} aria-hidden="true" />
          <span>设置</span>
        </button>
      </aside>

      <section className="content">
        {module === "upscale" ? (
          <>
            <div className="module-head">
              <div>
                <h1>图片超分</h1>
                <p>使用本机显卡高清放大，图片不上传</p>
              </div>
              <StatusPill
                assetStatus={assetStatus}
                hardware={hardware}
                loading={hardwareLoading}
                counts={counts}
                needsAiResources={needsAiResources}
                onRetest={() => void probeHardware(true)}
              />
            </div>
            <div className="workspace">
              <section className="left">
                {needsAiResources && modelStatus && !selectedModelInstalled ? (
                  <ModelSetupCard
                    status={modelStatus}
                    selectedFileName={settings.upscaleModel}
                    onDownload={(fileName) => void window.upscaler.downloadModel(fileName)}
                    onUse={(fileName) => setSettings((current) => ({ ...current, upscaleModel: fileName }))}
                    onCancel={() => void window.upscaler.cancelModelDownload()}
                  />
                ) : null}
                {needsAiResources && !selectedModelInstalled ? null : hasContent ? (
                  <div className={`dropstrip ${isDragging ? "dragging" : ""}`}>
                    <span className="dropstrip-hint">
                      <BrandMark size={16} /> 拖入图片或文件夹，或
                    </span>
                    <div className="dropstrip-actions">
                      <button className="secondary sm" onClick={() => void addFiles()}>
                        添加图片
                      </button>
                      <button className="secondary sm" onClick={() => void addFolder()}>
                        添加文件夹
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={`dropzone ${isDragging ? "dragging" : ""}`}>
                    <div className="drop-icon">
                      <BrandMark size={30} />
                    </div>
                    <h2>把图片或文件夹拖到这里</h2>
                    <p>支持 PNG、JPEG、WebP，选择文件夹时会自动递归扫描</p>
                    <div className="actions">
                      <button onClick={() => void addFiles()}>添加图片</button>
                      <button className="secondary" onClick={() => void addFolder()}>
                        添加文件夹
                      </button>
                    </div>
                  </div>
                )}

                {pendingPaths.length > 0 ? (
                  <>
                    <section className="pending-bar">
                      <div className="pending-thumbs">
                        {pendingPaths.slice(0, 5).map((path) => (
                          <Thumb key={path} path={path} className="thumb-sm" />
                        ))}
                      </div>
                      <span className="pending-count">已选 {pendingPaths.length} 张</span>
                      <button className="link-button" onClick={() => setPendingPaths([])}>
                        清空
                      </button>
                      <span className="spacer" />
                      <button className="primary" disabled={!chainReady} onClick={() => void start()}>
                        开始处理 {pendingPaths.length} 张
                      </button>
                    </section>
                    {!chainReady ? (
                      <p className="hint-warn">
                        当前 AI 链路无法开始，缺少：{chainStatus?.missing.join("、") || "必需资源"}
                      </p>
                    ) : null}
                    {pendingPaths.length <= 50 ? (
                      <PendingList
                        paths={pendingPaths}
                        onRemove={(path) => setPendingPaths((items) => items.filter((item) => item !== path))}
                      />
                    ) : null}
                  </>
                ) : null}

                <JobList jobs={jobs} now={now} onCompare={setCompareJob} onRetry={retryJob} />
              </section>

              <aside className="right">
                {settingsLoaded ? (
                  <SettingsPanel
                    settings={settings}
                    status={assetStatus}
                    modelStatus={modelStatus}
                    onChange={setSettings}
                    onSelectOutputDirectory={() => void selectOutputDirectory()}
                  />
                ) : null}
              </aside>
            </div>
          </>
        ) : null}

        <section className="module-pane" hidden={module !== "imagegen"} aria-hidden={module !== "imagegen"}>
          <ImageGenModule
            account={account}
            contract={imageContract}
            tasks={imageTasks}
            tasksLoaded={imageTasksLoaded}
            now={now}
            onGoSettings={() => selectModule("settings")}
            onUpscale={upscaleImage}
            onTaskStarted={registerImageTask}
            onRefreshContract={() => void window.upscaler.getImageContract().then(setImageContract)}
            registerDropHandler={registerImageDropHandler}
          />
        </section>
        {module === "videogen" ? (
          <VideoGenModule
            account={account}
            contract={videoContract}
            tasks={videoTasks}
            now={now}
            onGoSettings={() => selectModule("settings")}
            onRefreshContract={() => void window.upscaler.getVideoContract().then(setVideoContract)}
            onSyncRecent={() => window.upscaler.syncRecentVideoTasks().then(setVideoTasks)}
          />
        ) : null}
        {module === "agent" ? (
          <AgentChatModule
            account={account}
            excludedModels={nonAgentCloudModels}
            onGoSettings={() => selectModule("settings")}
            onTopup={() => void window.upscaler.openTopup()}
            onRefreshAccount={() => void window.upscaler.getAccountStatus(true).then(setAccount)}
          />
        ) : null}
        {module === "assets" ? (
          <AssetsModule
            jobs={jobs}
            imageTasks={imageTasks}
            videoTasks={videoTasks}
            onCompare={setCompareJob}
            onUpscale={upscaleImage}
          />
        ) : null}
        {module === "settings" ? (
          <SettingsModule
            account={account}
            busy={accountBusy}
            appInfo={appInfo}
            onConnect={(key) => void connectKey(key)}
            onClear={() => void disconnectKey()}
            onShowAbout={() => setShowAbout(true)}
          />
        ) : null}
      </section>

      {showAbout ? <AboutModal info={appInfo} hardware={hardware} onClose={() => setShowAbout(false)} /> : null}
      {compareJob ? <CompareModal job={compareJob} onClose={() => setCompareJob(null)} /> : null}
    </main>
  );
}

function StatusPill({
  assetStatus,
  hardware,
  loading,
  counts,
  needsAiResources,
  onRetest
}: {
  assetStatus: AssetStatus | null;
  hardware: HardwareReport | null;
  loading: boolean;
  counts: Record<UpscaleJob["status"], number>;
  needsAiResources: boolean;
  onRetest: () => void;
}) {
  const [open, setOpen] = useState(false);

  const assetsReady = !needsAiResources || Boolean(assetStatus?.qualityModes.standard.ok);
  const hardwareReady = !needsAiResources || hardware?.ok === true;
  const checking = needsAiResources && loading && !hardware;
  const state: "busy" | "ok" | "warn" = checking
    ? "busy"
    : !assetsReady || (needsAiResources && hardware != null && !hardware.ok)
      ? "warn"
      : hardwareReady
        ? "ok"
        : "busy";
  const label = checking
    ? "检测中…"
    : !needsAiResources
      ? "本地增强就绪"
      : !assetsReady
        ? "配置缺失"
        : hardware == null
          ? "检测中…"
          : hardware.ok
            ? "AI 引擎就绪"
            : "CUDA 不可用";

  return (
    <div className="status-wrap">
      <button className={`status-pill ${state}`} onClick={() => setOpen((value) => !value)}>
        <span className="status-dot" aria-hidden="true" />
        {label}
      </button>
      {open ? (
        <>
          <div className="pop-backdrop" onClick={() => setOpen(false)} />
          <div className="status-pop">
            <h3>运行状态</h3>
            <dl className="kv">
              <div>
                <dt>处理资源</dt>
                <dd>
                  {!needsAiResources
                    ? "网页增强无需模型"
                    : assetsReady
                      ? "完整"
                      : `缺少 ${assetStatus?.missing.join("、") || "必需资源"}`}
                </dd>
              </div>
              <div>
                <dt>CUDA</dt>
                <dd>
                  {!needsAiResources
                    ? "当前链路不需要"
                    : hardware == null
                      ? "尚未检测"
                      : hardware.comfyuiCudaAvailable
                        ? hardware.cudaDevices.join("、") || "可用"
                        : "不可用"}
                </dd>
              </div>
              <div>
                <dt>任务</dt>
                <dd>
                  处理中 {counts.running} · 等待 {counts.queued}
                </dd>
              </div>
            </dl>
            {hardware && hardware.issues.length > 0 ? (
              <ul className="status-issues">
                {hardware.issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
                {hardware.hints.map((hint) => (
                  <li key={hint} className="hint">
                    {hint}
                  </li>
                ))}
              </ul>
            ) : null}
            <button className="secondary sm" disabled={loading} onClick={onRetest}>
              {loading ? "检测中…" : "重新检测"}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** 只在设置加载完成后挂载（见 App），初始态可以直接从持久化值派生，无需校准 effect。 */
function SettingsPanel({
  settings,
  status,
  modelStatus,
  onChange,
  onSelectOutputDirectory
}: {
  settings: UpscaleSettings;
  status: AssetStatus | null;
  modelStatus: UpscaleModelStatus | null;
  onChange: (settings: UpscaleSettings) => void;
  onSelectOutputDirectory: () => void;
}) {
  type SizeMode = "web" | "full" | "custom";
  const deriveMode = (maxSide: number): SizeMode => (maxSide === 4096 ? "web" : maxSide === 0 ? "full" : "custom");
  const [sizeMode, setSizeMode] = useState<SizeMode>(() => deriveMode(settings.maxSide));
  const [customText, setCustomText] = useState(() =>
    String(settings.maxSide > 0 && settings.maxSide !== 4096 ? settings.maxSide : 8192)
  );
  const lastCustom = useRef(settings.maxSide > 0 && settings.maxSide !== 4096 ? settings.maxSide : 8192);

  function selectMode(mode: SizeMode) {
    setSizeMode(mode);
    if (mode === "web") onChange({ ...settings, maxSide: 4096 });
    else if (mode === "full") onChange({ ...settings, maxSide: 0 });
    else {
      setCustomText(String(lastCustom.current));
      onChange({ ...settings, maxSide: lastCustom.current });
    }
  }

  function handleCustomChange(value: string) {
    setCustomText(value);
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) {
      lastCustom.current = Math.round(numeric);
      onChange({ ...settings, maxSide: Math.round(numeric) });
    }
  }

  const chainStatus = status?.qualityModes.standard;
  const selectedModel = modelStatus?.models.find((model) => model.fileName === settings.upscaleModel) ?? null;
  const chainCopy = {
    title: selectedModel?.commercial ? "本地 AI 超分" : "网站同款 AI",
    body: `${selectedModel?.displayName ?? "4x-UltraSharp"} · 默认 4096 长边 · PNG 输出`
  };

  return (
    <section className="settings">
      <h2>超分设置</h2>

      <div className="chain-card">
        <strong>{chainCopy.title}</strong>
        <span>{chainCopy.body}</span>
      </div>

      {chainStatus && !chainStatus.ok ? (
        settings.processingMode === "webClear" ? null : (
          <p className="quality-warning">当前 AI 链路缺少：{chainStatus.missing.join("、")}</p>
        )
      ) : null}

      <div className="field">
        <span className="field-label">处理模式</span>
        <div className="radio-group">
          <label className="radio-row">
            <input
              type="radio"
              name="processing-mode"
              checked={settings.processingMode === "aiUpscaleWebClear"}
              onChange={() => onChange({ ...settings, processingMode: "aiUpscaleWebClear" })}
            />
            <span>
              网站同款<small>AI 超分 + 网页增强（锐化提亮），与网页版按钮一致</small>
            </span>
          </label>
          <label className="radio-row">
            <input
              type="radio"
              name="processing-mode"
              checked={settings.processingMode === "aiUpscale"}
              onChange={() => onChange({ ...settings, processingMode: "aiUpscale" })}
            />
            <span>
              纯 AI 超分<small>只重建细节不加锐化，色彩保持原图</small>
            </span>
          </label>
          <label className="radio-row">
            <input
              type="radio"
              name="processing-mode"
              checked={settings.processingMode === "webClear"}
              onChange={() => onChange({ ...settings, processingMode: "webClear" })}
            />
            <span>
              仅网页增强<small>不跑 AI 模型，秒级完成，适合轻度提清晰</small>
            </span>
          </label>
        </div>
      </div>

      {modelStatus && modelStatus.models.length > 1 ? (
        <div className="field">
          <span className="field-label">超分模型</span>
          <div className="radio-group">
            {modelStatus.models.map((model) => (
              <label className="radio-row" key={model.fileName}>
                <input
                  type="radio"
                  name="upscale-model"
                  disabled={!model.installed}
                  checked={settings.upscaleModel === model.fileName}
                  onChange={() => onChange({ ...settings, upscaleModel: model.fileName })}
                />
                <span>
                  {model.displayName}
                  <small>
                    {model.commercial ? "可商用" : "仅限非商业"} ·{" "}
                    {model.installed ? model.tagline : "未下载（在左侧模型卡下载后可选）"}
                  </small>
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      <div className="field">
        <span className="field-label">输出格式</span>
        <div className="fixed-setting">
          <strong>PNG</strong>
          <span>保持模型细节，不做二次有损压缩</span>
        </div>
      </div>

      <div className="field">
        <span className="field-label">输出尺寸</span>
        <div className="radio-group">
          <label className="radio-row">
            <input type="radio" name="size-mode" checked={sizeMode === "web"} onChange={() => selectMode("web")} />
            <span>
              贴近网页版<small>输出长边统一为 4096（大图缩小到 4096，与网页版一致）</small>
            </span>
          </label>
          <label className="radio-row">
            <input type="radio" name="size-mode" checked={sizeMode === "full"} onChange={() => selectMode("full")} />
            <span>
              真实 4x<small>不限制尺寸，按模型全量放大</small>
            </span>
          </label>
          <label className="radio-row">
            <input
              type="radio"
              name="size-mode"
              checked={sizeMode === "custom"}
              onChange={() => selectMode("custom")}
            />
            <span>
              自定义长边
              {sizeMode === "custom" ? (
                <input
                  className="custom-side"
                  type="number"
                  min={256}
                  max={16384}
                  value={customText}
                  onClick={(event) => event.preventDefault()}
                  onChange={(event) => handleCustomChange(event.target.value)}
                  onBlur={() => setCustomText(String(settings.maxSide || lastCustom.current))}
                  aria-label="自定义最大长边像素"
                />
              ) : null}
            </span>
          </label>
        </div>
      </div>

      <div className="output-row">
        <div>
          <span className="field-label">输出目录</span>
          <p>{settings.outputDirectory || "原图同级目录 / upscaled"}</p>
        </div>
        <button className="secondary sm" onClick={onSelectOutputDirectory}>
          更改
        </button>
      </div>
    </section>
  );
}

function AccountCard({
  account,
  onTopup,
  onGoSettings
}: {
  account: AccountStatus | null;
  onTopup: () => void;
  onGoSettings: () => void;
}) {
  if (!account) {
    return (
      <div className="account-card">
        <div className="account-card-head">
          <WalletCards size={15} aria-hidden="true" />
          <span>账户</span>
        </div>
        <p className="account-note">正在读取账户…</p>
      </div>
    );
  }
  if (!account.connected) {
    return (
      <div className="account-card">
        <div className="account-card-head">
          <WalletCards size={15} aria-hidden="true" />
          <span>RiverMoon 账户</span>
        </div>
        <p className="account-note">{account.error ?? "连接后使用生图、视频和 GPT"}</p>
        <button className="secondary sm account-card-action" onClick={onGoSettings}>
          {account.maskedKey ? "检查连接" : "连接账户"}
        </button>
      </div>
    );
  }
  const remaining =
    account.totalUsd != null && account.usedUsd != null ? Math.max(0, account.totalUsd - account.usedUsd) : null;
  const balanceText =
    account.totalUsd != null && account.totalUsd >= 1_000_000
      ? "不限额"
      : remaining != null
        ? `$${remaining.toFixed(2)}`
        : account.usedUsd != null
          ? `已用 $${account.usedUsd.toFixed(2)}`
          : "—";
  // 低余额（<$1，约 10 次生图余量）主动提醒：变橙 + 引导充值，服务复购漏斗。
  const lowBalance = remaining != null && account.totalUsd != null && account.totalUsd < 1_000_000 && remaining < 1;
  return (
    <div className={`account-card ${lowBalance ? "low" : ""}`}>
      <div className="account-card-head">
        <WalletCards size={15} aria-hidden="true" />
        <span>可用余额</span>
      </div>
      <div className="account-balance-row">
        <strong className={`account-balance ${lowBalance ? "warn" : ""}`}>{balanceText}</strong>
        <button className="primary sm" onClick={onTopup}>
          充值
        </button>
      </div>
      <span className="account-note">
        {lowBalance ? "余额即将用完，充值后继续创作" : `${account.maskedKey} · ${account.models.length} 个模型`}
      </span>
    </div>
  );
}

function SettingsModule({
  account,
  busy,
  appInfo,
  onConnect,
  onClear,
  onShowAbout
}: {
  account: AccountStatus | null;
  busy: boolean;
  appInfo: AppInfo | null;
  onConnect: (key: string) => void;
  onClear: () => void;
  onShowAbout: () => void;
}) {
  const [keyInput, setKeyInput] = useState("");
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const connected = Boolean(account?.connected);

  async function checkUpdates() {
    setUpdateBusy(true);
    try {
      setUpdateInfo(await window.upscaler.checkForUpdates());
    } catch (error) {
      setUpdateInfo({
        ok: false,
        currentVersion: appInfo?.version ?? "0.0.0",
        latestVersion: null,
        hasUpdate: false,
        releaseUrl: null,
        source: "none",
        checkedAt: Date.now(),
        error: error instanceof Error ? error.message : "检查更新失败，请稍后重试。"
      });
    } finally {
      setUpdateBusy(false);
    }
  }

  return (
    <>
      <div className="module-head">
        <div>
          <h1>设置</h1>
          <p>账户、版本与应用诊断</p>
        </div>
      </div>
      <section className="panel settings-page">
        <h2>中转站账户</h2>
        <p className="hw-hint">
          在 rivermoon7.com 获取 API Key 后粘贴连接。AI 生图、AI 视频和 GPT
          对话会把对应内容发送到中转站处理；本地超分不上传图片。
        </p>
        {connected && account ? (
          <div className="key-status ok">
            已连接 {account.maskedKey} · 可用模型 {account.models.length} 个
          </div>
        ) : account?.error ? (
          <div className="key-status warn">{account.error}</div>
        ) : null}
        <div className="key-row">
          <input
            type="password"
            placeholder="sk-..."
            value={keyInput}
            aria-label="API Key"
            onChange={(event) => setKeyInput(event.target.value)}
          />
          <button
            className="primary"
            disabled={busy || keyInput.trim().length === 0}
            onClick={() => {
              onConnect(keyInput.trim());
              setKeyInput("");
            }}
          >
            {busy ? "校验中…" : connected ? "更换 Key" : "连接"}
          </button>
          {connected ? (
            <button className="secondary" disabled={busy} onClick={onClear}>
              断开
            </button>
          ) : null}
        </div>
      </section>
      <section className="panel settings-page">
        <h2>版本更新</h2>
        <p className="hw-hint">当前版本 v{appInfo?.version ?? "—"}。后续发布到 GitHub Releases 后可在这里检查。</p>
        {updateInfo ? (
          <div className={`key-status ${updateInfo.ok && !updateInfo.hasUpdate ? "ok" : "warn"}`}>
            {updateStatusText(updateInfo)}
          </div>
        ) : null}
        <div className="update-actions">
          <button className="secondary" disabled={updateBusy} onClick={() => void checkUpdates()}>
            {updateBusy ? "检查中…" : "检查更新"}
          </button>
          {updateInfo?.hasUpdate && updateInfo.releaseUrl ? (
            <button className="primary" onClick={() => void window.upscaler.openUpdatePage(updateInfo.releaseUrl!)}>
              打开下载页
            </button>
          ) : null}
        </div>
        {updateInfo ? <p className="update-meta">上次检查 {formatShortTime(updateInfo.checkedAt)}</p> : null}
      </section>
      <section className="panel settings-page">
        <h2>关于</h2>
        <p className="hw-hint">版本信息、本地超分模型授权与诊断日志导出。</p>
        <div>
          <button className="secondary" onClick={onShowAbout}>
            打开关于面板
          </button>
        </div>
      </section>
    </>
  );
}

function updateStatusText(info: UpdateInfo): string {
  if (!info.ok) return info.error ?? "检查更新失败，请稍后重试。";
  const latest = info.latestVersion ? `v${info.latestVersion}` : "未知版本";
  const current = `v${info.currentVersion}`;
  if (info.hasUpdate) {
    return info.source === "github-tag"
      ? `检测到最新 tag ${latest}，当前 ${current}。建议把该版本发布为 GitHub Release 后下载。`
      : `发现新版本 ${latest}，当前 ${current}。`;
  }
  if (info.source === "github-tag") {
    return `当前 ${current} 不低于 GitHub 最新 tag ${latest}；正式发版建议使用 GitHub Releases。`;
  }
  return `当前已是最新版本 ${current}。`;
}

const AGENT_STORAGE_KEY = "rivermoon-agent-conversations-v1";
const DEFAULT_AGENT_MODEL = "gpt-5.5";
const DEFAULT_AGENT_REASONING: AgentReasoningEffort = "medium";
const DEFAULT_AGENT_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2"];
const AGENT_REASONING_OPTIONS: Array<{ value: AgentReasoningEffort; label: string }> = [
  { value: "auto", label: "自动" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "xhigh", label: "超高" }
];
const AGENT_IMAGE_MAX_SIDE = 1600;
const AGENT_IMAGE_QUALITY = 0.85;

function AgentChatModule({
  account,
  excludedModels,
  onGoSettings,
  onTopup,
  onRefreshAccount
}: {
  account: AccountStatus | null;
  excludedModels: string[];
  onGoSettings: () => void;
  onTopup: () => void;
  onRefreshAccount: () => void;
}) {
  const [conversations, setConversations] = useState<AgentConversation[]>(() => loadAgentConversations());
  const [activeId, setActiveId] = useState(() => conversations[0]?.id ?? createAgentConversation().id);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<AgentAttachment[]>([]);
  const [attachmentNote, setAttachmentNote] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [streamRequestId, setStreamRequestId] = useState<string | null>(null);
  const [errorNote, setErrorNote] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const streamMeta = useRef<{ requestId: string; conversationId: string; assistantId: string } | null>(null);

  const connected = Boolean(account?.connected);
  const modelOptions = useMemo(
    () => resolveAgentModels(account?.models ?? [], excludedModels),
    [account, excludedModels]
  );
  const active =
    conversations.find((conversation) => conversation.id === activeId) ?? conversations[0] ?? createAgentConversation();
  const activeMessages = active.messages;
  const activeModel = modelOptions.includes(active.model) ? active.model : (modelOptions[0] ?? DEFAULT_AGENT_MODEL);
  const canSend = connected && !streaming && (input.trim().length > 0 || attachments.length > 0);

  useEffect(() => {
    persistAgentConversations(conversations);
  }, [conversations]);

  useEffect(() => {
    const unsubscribe = window.upscaler.onAgentResponseEvent((event: AgentChatEvent) => {
      const meta = streamMeta.current;
      if (!meta || event.requestId !== meta.requestId) return;
      if (event.delta) {
        updateAgentMessage(setConversations, meta.conversationId, meta.assistantId, (message) => ({
          ...message,
          content: message.content + event.delta
        }));
      }
      if (event.done) {
        setStreaming(false);
        setStreamRequestId(null);
        streamMeta.current = null;
        if (event.error) {
          updateAgentMessage(setConversations, meta.conversationId, meta.assistantId, (message) => ({
            ...message,
            content: message.content || `请求失败：${event.error}`
          }));
          setErrorNote(event.error);
        } else {
          setErrorNote(null);
          onRefreshAccount();
        }
      }
    });
    return unsubscribe;
  }, [onRefreshAccount]);

  function patchActiveConversation(patch: Partial<AgentConversation>) {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === active.id
          ? normalizeAgentConversation({ ...conversation, ...patch, updatedAt: Date.now() })!
          : conversation
      )
    );
  }

  function createConversation() {
    if (streaming) return;
    const conversation = createAgentConversation({ model: activeModel, reasoningEffort: active.reasoningEffort });
    setConversations((current) => [conversation, ...current].slice(0, 80));
    setActiveId(conversation.id);
    setInput("");
    setAttachments([]);
    setErrorNote(null);
  }

  function deleteConversation(id: string) {
    if (streaming && id === active.id) return;
    const next = conversations.filter((conversation) => conversation.id !== id);
    if (next.length === 0) {
      const conversation = createAgentConversation();
      setConversations([conversation]);
      setActiveId(conversation.id);
      return;
    }
    setConversations(next);
    if (id === active.id) setActiveId(next[0]!.id);
  }

  async function send() {
    const content = input.trim();
    if (!canSend || (!content && attachments.length === 0)) return;
    if (attachments.length > 0 && !agentModelSupportsVision(activeModel)) {
      setErrorNote("当前模型可能不支持图片分析，请切换到 gpt-5.5 后再发送图片。");
      return;
    }
    const requestId = randomId();
    const userMessage = createAgentMessage("user", content, attachments);
    const assistantId = randomId();
    const assistantMessage = createAgentMessage("assistant", "");
    assistantMessage.id = assistantId;
    const nextMessages = [...activeMessages, userMessage, assistantMessage];
    setConversations((current) =>
      current
        .map((conversation) =>
          conversation.id === active.id
            ? normalizeAgentConversation({
                ...conversation,
                model: activeModel,
                messages: nextMessages,
                title: conversation.renamed ? conversation.title : agentTitleFromMessage(userMessage),
                preview: agentPreview(nextMessages),
                updatedAt: Date.now()
              })!
            : conversation
        )
        .sort((left, right) => right.updatedAt - left.updatedAt)
    );
    setInput("");
    setAttachments([]);
    setAttachmentNote(null);
    setErrorNote(null);
    setStreaming(true);
    setStreamRequestId(requestId);
    streamMeta.current = { requestId, conversationId: active.id, assistantId };
    const result = await window.upscaler.startAgentResponse({
      requestId,
      model: activeModel,
      reasoningEffort: active.reasoningEffort,
      messages: [...activeMessages, userMessage]
    });
    if (!result.ok) {
      setStreaming(false);
      setStreamRequestId(null);
      streamMeta.current = null;
      updateAgentMessage(setConversations, active.id, assistantId, (message) => ({
        ...message,
        content: message.content || `请求失败：${result.error ?? "GPT 请求失败。"}`
      }));
      setErrorNote(result.error);
    }
  }

  async function addFiles(files: FileList | File[]) {
    const incoming = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (incoming.length === 0) {
      setAttachmentNote("只支持图片文件。");
      return;
    }
    try {
      const slots = Math.max(0, 4 - attachments.length);
      const prepared: AgentAttachment[] = [];
      for (const file of incoming.slice(0, slots)) prepared.push(await prepareAgentImageAttachment(file));
      setAttachments((current) => [...current, ...prepared].slice(0, 4));
      setAttachmentNote(incoming.length > slots ? "每条消息最多 4 张图，已保留前 4 张。" : null);
    } catch (error) {
      setAttachmentNote(error instanceof Error ? error.message : "图片添加失败。");
    }
  }

  function handlePaste(event: React.ClipboardEvent) {
    const files = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  }

  function handleDrop(event: React.DragEvent) {
    const files = Array.from(event.dataTransfer.files).filter((file) => file.type.startsWith("image/"));
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  }

  function cancel() {
    if (!streamRequestId) return;
    void window.upscaler.cancelAgentResponse(streamRequestId);
  }

  return (
    <>
      <div className="module-head">
        <div>
          <h1>GPT 对话</h1>
          <p>对话、图片分析和创作辅助</p>
        </div>
        <div className="head-actions">
          {connected ? <span className="key-status ok">API 已连接</span> : null}
          <button className="secondary sm" onClick={onRefreshAccount}>
            刷新账户
          </button>
        </div>
      </div>

      {!connected ? (
        <div className="panel empty">
          <p>连接 rivermoon7.com 账户后即可使用 GPT 对话。</p>
          <button className="primary" onClick={onGoSettings}>
            去连接账户
          </button>
        </div>
      ) : (
        <section
          className="agent-shell"
          onPaste={handlePaste}
          onDrop={handleDrop}
          onDragOver={(event) => event.preventDefault()}
        >
          <aside className="agent-history">
            <div className="agent-history-head">
              <div>
                <h2>历史对话</h2>
                <p>本机保存</p>
              </div>
              <button className="icon-button" onClick={createConversation} disabled={streaming} title="新建对话">
                +
              </button>
            </div>
            <div className="agent-history-list">
              {conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  className={`agent-conversation ${conversation.id === active.id ? "on" : ""}`}
                  onClick={() => setActiveId(conversation.id)}
                >
                  <span className="agent-conversation-title">{conversation.title || "新对话"}</span>
                  <span className="agent-conversation-time">{formatShortTime(conversation.updatedAt)}</span>
                  <span className="agent-conversation-preview">{conversation.preview || "暂无消息"}</span>
                  <span className="agent-conversation-meta">
                    {conversation.model} · {reasoningLabel(conversation.reasoningEffort)}
                  </span>
                </button>
              ))}
            </div>
          </aside>

          <div className="agent-main">
            <div className="agent-toolbar">
              <div className="agent-title-group">
                <input
                  value={active.title}
                  onChange={(event) => patchActiveConversation({ title: event.target.value, renamed: true })}
                  aria-label="对话标题"
                />
                <button className="secondary sm" onClick={() => deleteConversation(active.id)} disabled={streaming}>
                  删除
                </button>
              </div>
              <div className="agent-selects">
                <select
                  value={activeModel}
                  onChange={(event) => patchActiveConversation({ model: event.target.value })}
                >
                  {modelOptions.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
                <select
                  value={active.reasoningEffort}
                  onChange={(event) =>
                    patchActiveConversation({ reasoningEffort: event.target.value as AgentReasoningEffort })
                  }
                >
                  {AGENT_REASONING_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="agent-messages">
              {activeMessages.length === 0 ? (
                <div className="agent-empty">
                  <BrandMark size={26} />
                  <h2>开始对话</h2>
                  <p>输入问题，或粘贴/拖入图片让 GPT 分析画面、提取提示词、改写分镜。</p>
                </div>
              ) : (
                activeMessages.map((message) => <AgentMessageBubble key={message.id} message={message} />)
              )}
            </div>

            <div className="agent-composer">
              {attachments.length > 0 ? (
                <div className="agent-attachments">
                  {attachments.map((attachment) => (
                    <div key={attachment.id} className="agent-attachment">
                      <img src={attachment.dataUrl} alt={attachment.name} />
                      <span>{attachment.name}</span>
                      <button
                        className="icon-mini"
                        onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                        aria-label="移除图片"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="agent-input-row">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(event) => {
                    if (event.target.files) void addFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
                <button className="icon-button attach" onClick={() => fileInputRef.current?.click()} title="添加图片">
                  +
                </button>
                <textarea
                  rows={3}
                  value={input}
                  placeholder="输入内容，Enter 发送，Shift+Enter 换行"
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !(event.nativeEvent as KeyboardEvent).isComposing) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                />
                {streaming ? (
                  <button className="secondary" onClick={cancel}>
                    停止
                  </button>
                ) : (
                  <button className="primary" disabled={!canSend} onClick={() => void send()}>
                    发送
                  </button>
                )}
              </div>
              {attachmentNote ? <p className="hint-warn">{attachmentNote}</p> : null}
              {errorNote ? (
                <p className="hint-warn">
                  {errorNote}
                  {errorNote.includes("余额") ? (
                    <button className="link-button" onClick={onTopup}>
                      去充值
                    </button>
                  ) : null}
                </p>
              ) : null}
            </div>
          </div>
        </section>
      )}
    </>
  );
}

function AgentMessageBubble({ message }: { message: AgentMessage }) {
  return (
    <article className={`agent-message ${message.role}`}>
      <div className="agent-message-role">{message.role === "user" ? "你" : "GPT"}</div>
      <div className="agent-message-body">
        {message.attachments?.length ? (
          <div className="agent-message-images">
            {message.attachments.map((attachment) => (
              <img key={attachment.id} src={attachment.dataUrl} alt={attachment.name} />
            ))}
          </div>
        ) : null}
        {message.content ? <AgentText content={message.content} /> : <span className="agent-thinking">正在回复</span>}
      </div>
    </article>
  );
}

function AgentText({ content }: { content: string }) {
  const parts = content.split(/```/g);
  if (parts.length === 1) return <div className="agent-text">{content}</div>;
  return (
    <div className="agent-text">
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <pre key={index}>
            <code>{stripCodeFenceLanguage(part)}</code>
          </pre>
        ) : part ? (
          <span key={index}>{part}</span>
        ) : null
      )}
    </div>
  );
}

function resolveAgentModels(models: string[], excludedModels: string[] = []): string[] {
  const excluded = new Set(excludedModels.map((model) => model.toLowerCase()));
  const filtered = models.filter((model) => model && !excluded.has(model.toLowerCase()) && !isNonAgentModel(model));
  return filtered.length > 0 ? Array.from(new Set(filtered)).sort((a, b) => a.localeCompare(b)) : DEFAULT_AGENT_MODELS;
}

function isNonAgentModel(model: string): boolean {
  const value = model.toLowerCase();
  return (
    value === "image2.0" ||
    value === "image2.0-4k" ||
    value === "gpt-image-2" ||
    value.includes("image") ||
    value.includes("grok-imagine") ||
    value.includes("dall-e") ||
    value.includes("midjourney") ||
    value.includes("sora") ||
    value.includes("kling") ||
    value.includes("runway") ||
    value.includes("seedance") ||
    value.includes("hailuo") ||
    value.includes("minimax-video") ||
    value.includes("vidu") ||
    value.includes("veo") ||
    value.includes("video") ||
    value.includes("embedding") ||
    value.includes("rerank") ||
    value.includes("whisper") ||
    /^image/.test(value)
  );
}

function agentModelSupportsVision(model: string): boolean {
  const value = model.toLowerCase();
  return (
    value.includes("gpt-5") ||
    value.includes("gpt-4o") ||
    value.includes("gpt-4.1") ||
    value.includes("gpt-4.5") ||
    value.includes("gemini") ||
    value.includes("claude") ||
    value.includes("qwen-vl") ||
    value.includes("glm-4v")
  );
}

function loadAgentConversations(): AgentConversation[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(AGENT_STORAGE_KEY) || "[]") as unknown;
    if (!Array.isArray(parsed)) return [createAgentConversation()];
    const conversations = parsed
      .map(normalizeAgentConversation)
      .filter((item): item is AgentConversation => Boolean(item));
    return conversations.length > 0
      ? conversations.sort((left, right) => right.updatedAt - left.updatedAt).slice(0, 80)
      : [createAgentConversation()];
  } catch {
    return [createAgentConversation()];
  }
}

function persistAgentConversations(conversations: AgentConversation[]) {
  const stable = conversations.slice(0, 80).map((conversation) => ({
    ...conversation,
    messages: conversation.messages.map((message) => ({ ...message, attachments: undefined }))
  }));
  localStorage.setItem(AGENT_STORAGE_KEY, JSON.stringify(stable));
}

function createAgentConversation(input: Partial<AgentConversation> = {}): AgentConversation {
  const now = Date.now();
  return normalizeAgentConversation({
    id: randomId(),
    title: "新对话",
    messages: [],
    model: DEFAULT_AGENT_MODEL,
    reasoningEffort: DEFAULT_AGENT_REASONING,
    preview: "",
    renamed: false,
    createdAt: now,
    updatedAt: now,
    ...input
  })!;
}

function normalizeAgentConversation(input: unknown): AgentConversation | null {
  const raw = input && typeof input === "object" ? (input as Partial<AgentConversation>) : {};
  const messages = Array.isArray(raw.messages)
    ? raw.messages
        .map(normalizeAgentMessage)
        .filter((message): message is AgentMessage => Boolean(message))
        .slice(-120)
    : [];
  const now = Date.now();
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : randomId(),
    title:
      typeof raw.title === "string" && raw.title.trim()
        ? raw.title.trim().slice(0, 80)
        : agentTitleFromText(messages[0]?.content),
    messages,
    model: typeof raw.model === "string" && raw.model && !isNonAgentModel(raw.model) ? raw.model : DEFAULT_AGENT_MODEL,
    reasoningEffort: isAgentReasoning(raw.reasoningEffort) ? raw.reasoningEffort : DEFAULT_AGENT_REASONING,
    preview: typeof raw.preview === "string" && raw.preview ? raw.preview.slice(0, 120) : agentPreview(messages),
    renamed: raw.renamed === true,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : now
  };
}

function normalizeAgentMessage(input: unknown): AgentMessage | null {
  const raw = input && typeof input === "object" ? (input as Partial<AgentMessage>) : {};
  if (raw.role !== "user" && raw.role !== "assistant") return null;
  const content = typeof raw.content === "string" ? raw.content : "";
  const attachments = Array.isArray(raw.attachments)
    ? raw.attachments
        .filter((item): item is AgentAttachment => Boolean(item?.dataUrl && item.mimeType?.startsWith("image/")))
        .slice(0, 4)
    : [];
  // 空的 assistant 消息是流式回复的合法占位（delta 逐步写入），不能过滤——
  // 否则占位一进会话就被删，所有 delta 找不到目标消息，气泡永远不出现。
  if (raw.role === "user" && !content && attachments.length === 0) return null;
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : randomId(),
    role: raw.role,
    content,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    attachments
  };
}

function createAgentMessage(
  role: AgentMessage["role"],
  content: string,
  attachments: AgentAttachment[] = []
): AgentMessage {
  return { id: randomId(), role, content, createdAt: Date.now(), attachments };
}

function updateAgentMessage(
  setConversations: React.Dispatch<React.SetStateAction<AgentConversation[]>>,
  conversationId: string,
  messageId: string,
  update: (message: AgentMessage) => AgentMessage
) {
  setConversations((current) =>
    current.map((conversation) => {
      if (conversation.id !== conversationId) return conversation;
      const messages = conversation.messages.map((message) => (message.id === messageId ? update(message) : message));
      return normalizeAgentConversation({
        ...conversation,
        messages,
        preview: agentPreview(messages),
        updatedAt: Date.now()
      })!;
    })
  );
}

async function prepareAgentImageAttachment(file: File): Promise<AgentAttachment> {
  if (!file.type.startsWith("image/")) throw new Error("只支持图片文件。");
  const original = await fileToDataUrl(file);
  const image = await loadHtmlImage(original);
  const scale = Math.min(1, AGENT_IMAGE_MAX_SIDE / Math.max(image.naturalWidth || 1, image.naturalHeight || 1));
  const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
  const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法处理图片。");
  context.drawImage(image, 0, 0, width, height);
  const blob = await canvasToBlob(canvas, "image/jpeg", AGENT_IMAGE_QUALITY);
  const dataUrl = await blobToDataUrl(blob);
  return {
    id: randomId(),
    name: `${file.name.replace(/\.[^.]+$/, "")}.jpg`,
    mimeType: "image/jpeg",
    dataUrl,
    width,
    height,
    size: blob.size
  };
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("图片读取失败。"));
    reader.readAsDataURL(file);
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("图片读取失败。"));
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片压缩失败。"))), type, quality);
  });
}

async function loadHtmlImage(dataUrl: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.decoding = "async";
  image.src = dataUrl;
  await image.decode();
  return image;
}

function agentTitleFromMessage(message: AgentMessage): string {
  return (
    agentTitleFromText(message.content) ||
    (message.attachments?.length ? `${message.attachments.length} 张图片` : "新对话")
  );
}

function agentTitleFromText(text: string | undefined): string {
  const value = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  return value ? (value.length > 24 ? `${value.slice(0, 24)}...` : value) : "新对话";
}

function agentPreview(messages: AgentMessage[]): string {
  const message = [...messages].reverse().find((item) => item.content.trim() || item.attachments?.length);
  if (!message) return "";
  const value = message.content.replace(/\s+/g, " ").trim();
  if (value) return value.length > 42 ? `${value.slice(0, 42)}...` : value;
  return message.attachments?.length ? `${message.attachments.length} 张图片` : "";
}

function reasoningLabel(value: AgentReasoningEffort): string {
  return AGENT_REASONING_OPTIONS.find((option) => option.value === value)?.label ?? "中";
}

function isAgentReasoning(value: unknown): value is AgentReasoningEffort {
  return value === "auto" || value === "low" || value === "medium" || value === "high" || value === "xhigh";
}

function stripCodeFenceLanguage(text: string): string {
  return text.replace(/^[a-z0-9_+-]+\r?\n/i, "");
}

function randomId(): string {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function formatShortTime(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

const IMAGE_RATIO_LABELS: Record<string, string> = {
  "1:1": "1:1",
  "4:5": "4:5",
  "3:4": "3:4",
  "2:3": "2:3",
  "9:16": "9:16",
  "3:2": "3:2",
  "4:3": "4:3",
  "16:9": "16:9",
  "1.91:1": "1.91:1",
  "21:9": "21:9"
};

const IMAGE_QUALITY_LABELS: Record<ImageQuality, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  auto: "Auto"
};

const IMAGE_FORMAT_LABELS: Record<ImageOutputFormat, string> = {
  png: "PNG",
  jpeg: "JPEG",
  webp: "WebP"
};

const STORYBOARD_TEMPLATES = [
  {
    id: "six-grid",
    label: "六宫格",
    mode: "单张宫格",
    build(theme: string) {
      return [
        `请生成一张 2x3 六宫格分镜图，主题：${theme}。`,
        "整体是一张完整图片，不要拆成多张图。六个格子按从左到右、从上到下阅读，形成连续镜头。",
        "每格都要有明确构图、主体动作、镜头景别和情绪推进；主体身份、服装、道具、光影和美术风格保持一致。",
        "六格顺序：1 建立场景，2 主体登场，3 行动开始，4 冲突或变化，5 高潮瞬间，6 收束定格。",
        "专业电影分镜板，高级概念设计稿，格线干净，画面信息丰富但不拥挤。不要乱码文字，不要水印，不要多余 UI。"
      ].join("\n");
    }
  },
  {
    id: "nine-grid",
    label: "九宫格",
    mode: "单张宫格",
    build(theme: string) {
      return [
        `请生成一张 3x3 九宫格连续分镜图，主题：${theme}。`,
        "整体是一张完整图片，九个格子按从左到右、从上到下阅读，形成完整小故事。",
        "九格结构：1 世界/场景，2 主角出现，3 目标建立，4 尝试行动，5 遇到阻碍，6 反转，7 高潮，8 结果，9 余韵定格。",
        "主体造型、光影、色彩和美术风格必须统一；每格独立好看，合起来是连续叙事。",
        "清晰网格边界，专业故事板构图，不要乱码文字，不要水印，不要廉价贴纸感。"
      ].join("\n");
    }
  },
  {
    id: "storyboard",
    label: "故事板",
    mode: "多镜头提示词",
    build(theme: string) {
      return [
        `请把下面主题拆成 6 个连续分镜，并为每个分镜生成独立可生图的画面描述。`,
        `主题：${theme}`,
        "",
        "统一风格：电影感故事板，高级概念设计稿，角色和场景设定保持一致，光影统一，画面干净。",
        "分镜 1：建立场景。交代时间、地点、环境氛围和主体出现前的空间关系。",
        "分镜 2：主体登场。突出主体身份、服装/道具/外形特征和第一眼记忆点。",
        "分镜 3：目标或行动开始。主体开始做关键动作，镜头从中景或跟拍角度推进。",
        "分镜 4：冲突或变化。加入阻碍、情绪变化、环境变化或戏剧性转折。",
        "分镜 5：高潮瞬间。动作最强、画面张力最大，使用更有冲击力的构图和光影。",
        "分镜 6：结尾定格。保留故事余韵，画面有总结感和可传播性。",
        "每个分镜都必须能独立作为 GPT Image 2 生图提示词使用。"
      ].join("\n");
    }
  }
];

/** 从账户可用模型里挑出生图模型；没有匹配时全量展示（不同分组命名各异）。 */
function pickImageModels(models: string[]): string[] {
  const matched = models.filter((id) => /image|dall|flux|seedream|stable|sd3|cogview|wanx/i.test(id));
  return matched.length > 0 ? matched : models;
}

function resolveImageModels(contract: ImageContract | null, accountModels: string[]): ImageContractModel[] {
  const visible = (contract?.models ?? []).filter((model) => model.visible);
  if (visible.length > 0) {
    const allowed = new Set(accountModels);
    const matched = visible.filter(
      (model) => allowed.size === 0 || allowed.has(model.publicName) || allowed.has(model.internalName)
    );
    return matched.length > 0 ? matched : visible;
  }
  return pickImageModels(accountModels).map(fallbackImageContractModel);
}

function fallbackImageContractModel(id: string): ImageContractModel {
  return {
    publicName: id,
    internalName: id,
    label: id,
    visible: true,
    primary: id === "gpt-image-2",
    endpoints: ["generation"],
    sizes: ["1024x1024", "1536x1024", "1024x1536"],
    qualities: ["auto"],
    outputFormats: ["png", "jpeg", "webp"],
    maxReferences: 0,
    maxReferenceBytes: 0,
    maxBodyBytes: 0,
    supportsMask: false,
    supportsMultipleReferences: false,
    customSize: {
      enabled: false,
      minDimension: 0,
      maxDimension: 0,
      maxPixels: 0,
      allowedRatios: [],
      nativeRatiosOnly: false,
      mode: null,
      warning: null
    },
    sizeModes: ["postprocess"],
    nativeRecommendedSizes: [],
    notice: null
  };
}

function selectImageModel(
  models: ImageContractModel[],
  selectedModel: string,
  defaultModelId: string | null | undefined
): ImageContractModel | undefined {
  if (selectedModel) {
    const selected = models.find((model) => model.publicName === selectedModel || model.internalName === selectedModel);
    if (selected) return selected;
  }
  return (
    models.find(
      (model) => defaultModelId && (model.publicName === defaultModelId || model.internalName === defaultModelId)
    ) ??
    models.find((model) => model.primary) ??
    models[0]
  );
}

function imageRatiosForModel(model: ImageContractModel | undefined): string[] {
  const ratios = new Set<string>();
  for (const size of model?.sizes ?? []) {
    const ratio = imageRatioFromSize(size);
    if (ratio) ratios.add(ratio);
  }
  for (const ratio of model?.customSize.allowedRatios ?? []) ratios.add(ratio);
  return ratios.size > 0 ? Array.from(ratios) : ["1:1", "16:9", "9:16"];
}

function imageSizesForRatio(model: ImageContractModel | undefined, ratio: string): string[] {
  const sizes = (model?.sizes ?? []).filter((size) => size !== "auto" && imageRatioFromSize(size) === ratio);
  if (sizes.length > 0) return sizes.sort(compareImageSizeAreaDesc);
  return (model?.sizes ?? []).filter((size) => size !== "auto").sort(compareImageSizeAreaDesc);
}

function preferredImageSize(model: ImageContractModel | undefined, ratio: string): string {
  const sizes = imageSizesForRatio(model, ratio);
  if (ratio === "16:9" && sizes.includes("3840x2160")) return "3840x2160";
  if (ratio === "9:16" && sizes.includes("2160x3840")) return "2160x3840";
  if (ratio === "1:1" && sizes.includes("2048x2048")) return "2048x2048";
  return sizes[0] ?? model?.sizes.find((size) => size !== "auto") ?? "1024x1024";
}

function imageRatioFromSize(size: string): string | null {
  const parsed = parseImageSize(size);
  if (!parsed) return null;
  const ratio = parsed.width / parsed.height;
  const candidates: Array<[string, number]> = [
    ["1:1", 1],
    ["4:5", 4 / 5],
    ["3:4", 3 / 4],
    ["2:3", 2 / 3],
    ["9:16", 9 / 16],
    ["3:2", 3 / 2],
    ["4:3", 4 / 3],
    ["16:9", 16 / 9],
    ["1.91:1", 1.91],
    ["21:9", 21 / 9],
    ["21:9", 2560 / 1080],
    ["21:9", 3440 / 1440]
  ];
  return candidates.find(([, value]) => Math.abs(ratio - value) < 0.003)?.[0] ?? `${parsed.width}:${parsed.height}`;
}

function parseImageSize(size: string): { width: number; height: number } | null {
  const match = size.match(/^(\d{3,5})x(\d{3,5})$/);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function compareImageSizeAreaDesc(left: string, right: string): number {
  const a = parseImageSize(left);
  const b = parseImageSize(right);
  return (b ? b.width * b.height : 0) - (a ? a.width * a.height : 0);
}

function imageSizeLabel(size: string): string {
  const ratio = imageRatioFromSize(size);
  return ratio ? `${size.replace("x", " × ")} · ${ratio}` : size;
}

function validateRendererCustomSize(model: ImageContractModel, widthValue: string, heightValue: string): string | null {
  const width = Number(widthValue);
  const height = Number(heightValue);
  const custom = model.customSize;
  if (!custom.enabled) return "当前模型不支持自定义尺寸。";
  if (!Number.isInteger(width) || !Number.isInteger(height)) return "请输入整数宽高。";
  if (custom.minDimension && (width < custom.minDimension || height < custom.minDimension)) {
    return `宽高不能小于 ${custom.minDimension}px。`;
  }
  if (custom.maxDimension && (width > custom.maxDimension || height > custom.maxDimension)) {
    return `宽高不能大于 ${custom.maxDimension}px。`;
  }
  if (custom.maxPixels && width * height > custom.maxPixels) {
    return `总像素不能超过 ${Math.floor(custom.maxPixels / 10000)} 万。`;
  }
  if (
    custom.allowedRatios.length > 0 &&
    !custom.allowedRatios.includes(imageRatioFromSize(`${width}x${height}`) ?? "")
  ) {
    return `当前只支持 ${custom.allowedRatios.join("、")} 输出比例。`;
  }
  return null;
}

type PendingImageSubmission = {
  id: string;
  conversationId: string;
  params: ImageGenParams;
  order: number;
};

function ImageGenModule({
  account,
  contract,
  tasks,
  tasksLoaded,
  now,
  onGoSettings,
  onUpscale,
  onTaskStarted,
  onRefreshContract,
  registerDropHandler
}: {
  account: AccountStatus | null;
  contract: ImageContract | null;
  tasks: ImageGenTask[];
  tasksLoaded: boolean;
  now: number;
  onGoSettings: () => void;
  onUpscale: (path: string) => void;
  onTaskStarted: (task: ImageGenTask) => void;
  onRefreshContract: () => void;
  registerDropHandler: (handler: ((paths: string[]) => void) | null) => void;
}) {
  const models = useMemo(() => resolveImageModels(contract, account?.models ?? []), [account, contract]);
  const storageExistsRef = useRef(window.localStorage.getItem(IMAGE_CONV_KEY) !== null);
  const [conversations, setConversations] = useState<ImageConversation[]>(() =>
    loadImageConversations(window.localStorage)
  );
  const conversationsRef = useRef(conversations);
  const [activeId, setActiveId] = useState(() => conversations[0]?.id ?? "");
  const [conversationsReady, setConversationsReady] = useState(false);
  const [selectedModel, setSelectedModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState("16:9");
  const [size, setSize] = useState("3840x2160");
  const [count, setCount] = useState(1);
  const [quality, setQuality] = useState<ImageQuality>("high");
  const [outputFormat, setOutputFormat] = useState<ImageOutputFormat>("png");
  const [fitMode, setFitMode] = useState<ImageFitMode>("contain");
  const [sizeMode, setSizeMode] = useState<ImageSizeMode>("postprocess");
  const [customEnabled, setCustomEnabled] = useState(false);
  const [customWidth, setCustomWidth] = useState("3840");
  const [customHeight, setCustomHeight] = useState("2160");
  const [referencePaths, setReferencePaths] = useState<string[]>([]);
  const [referenceNote, setReferenceNote] = useState<string | null>(null);
  const [templateTheme, setTemplateTheme] = useState("");
  const [showStoryboard, setShowStoryboard] = useState(false);

  // 接收 App 层分流来的拖入图片：直接加为参考图（referencePaths 非空即走编辑链路）。
  useEffect(() => {
    registerDropHandler((paths) => {
      setReferencePaths((current) => [...new Set([...current, ...paths])].slice(0, 20));
      setReferenceNote("已把拖入图片加为参考图。");
    });
    return () => registerDropHandler(null);
  }, [registerDropHandler]);
  const [submitNote, setSubmitNote] = useState<string | null>(null);
  const [imageNotice, setImageNotice] = useState<string | null>(null);
  const [pendingSubmissions, setPendingSubmissions] = useState<PendingImageSubmission[]>([]);
  const [taskSubmissionOrders, setTaskSubmissionOrders] = useState<Record<string, number>>({});
  const [appliedParamsKey, setAppliedParamsKey] = useState("");
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const submissionOrderRef = useRef<Record<string, number>>({});
  const submissionCounterRef = useRef(0);

  const active = conversations.find((conversation) => conversation.id === activeId) ?? conversations[0] ?? null;
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const activeTasks = useMemo(() => {
    if (!active) return [];
    return active.taskIds
      .map((id) => tasksById.get(id))
      .filter((task): task is ImageGenTask => Boolean(task))
      .reverse();
  }, [active, tasksById]);
  const activePendingSubmissions = useMemo(
    () =>
      pendingSubmissions
        .filter((submission) => submission.conversationId === active?.id)
        .sort((left, right) => right.order - left.order),
    [active?.id, pendingSubmissions]
  );
  const pendingCountByConversation = useMemo(() => {
    const counts = new Map<string, number>();
    for (const submission of pendingSubmissions) {
      counts.set(submission.conversationId, (counts.get(submission.conversationId) ?? 0) + 1);
    }
    return counts;
  }, [pendingSubmissions]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current != null) window.clearTimeout(noticeTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!tasksLoaded || conversationsReady) return;
    let next = conversations;
    if (next.length === 0) {
      next = migrateLegacyImageTasks({
        conversations: next,
        legacyTasks: tasks,
        storageExists: storageExistsRef.current
      });
    }
    if (next.length === 0) next = [createImageConversation()];
    setConversations(next);
    setActiveId((current) => (next.some((conversation) => conversation.id === current) ? current : next[0]!.id));
    setConversationsReady(true);
  }, [conversations, conversationsReady, tasks, tasksLoaded]);

  useEffect(() => {
    if (!conversationsReady) return;
    const timer = window.setTimeout(() => {
      try {
        saveImageConversations(window.localStorage, conversations);
      } catch {
        setSubmitNote("会话保存失败，请检查本机存储空间。");
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [conversations, conversationsReady]);

  useEffect(() => {
    if (!conversationsReady) return;
    return () => {
      try {
        saveImageConversations(window.localStorage, conversationsRef.current);
      } catch {
        // 组件卸载时无法再安全显示错误，下一次会话变更会重试保存。
      }
    };
  }, [conversationsReady]);

  const model = selectImageModel(models, selectedModel, contract?.defaultModelId);
  const ratios = imageRatiosForModel(model);
  const activeRatio = ratios.includes(ratio) ? ratio : (ratios[0] ?? "16:9");
  const sizeOptions = imageSizesForRatio(model, activeRatio);
  const activeSize =
    customEnabled && customWidth && customHeight
      ? `${Number(customWidth) || 0}x${Number(customHeight) || 0}`
      : sizeOptions.includes(size)
        ? size
        : preferredImageSize(model, activeRatio);
  const qualityOptions = model?.qualities.length ? model.qualities : (["auto"] as ImageQuality[]);
  const activeQuality = qualityOptions.includes(quality)
    ? quality
    : qualityOptions.includes("high")
      ? "high"
      : qualityOptions[0]!;
  const formatOptions = model?.outputFormats.length ? model.outputFormats : (["png"] as ImageOutputFormat[]);
  const activeFormat = formatOptions.includes(outputFormat) ? outputFormat : formatOptions[0]!;
  const sizeModeOptions = model?.sizeModes.length ? model.sizeModes : (["postprocess"] as ImageSizeMode[]);
  const activeSizeMode = sizeModeOptions.includes(sizeMode) ? sizeMode : sizeModeOptions[0]!;
  const referenceLimit = imageModelSupportsEditing(model)
    ? Math.min(MAX_IMAGE_EDIT_REFERENCES, model!.maxReferences)
    : 0;
  const effectiveReferences = referencePaths.slice(0, referenceLimit);
  const editingImage = effectiveReferences.length > 0;
  const customError = customEnabled && model ? validateRendererCustomSize(model, customWidth, customHeight) : null;
  const modelSignature = `${contract?.contractVersion ?? ""}:${models.map((item) => item.publicName).join("|")}`;
  const paramsApplyKey = active ? `${active.id}:${modelSignature}` : "";

  useEffect(() => {
    if (!active || !conversationsReady) return;
    if (appliedParamsKey === paramsApplyKey) return;

    const timer = window.setTimeout(() => {
      const params = active.lastParams;
      if (params) {
        const targetModel = selectImageModel(models, params.model, contract?.defaultModelId);
        const parsedSize = parseImageSize(params.size);
        setSelectedModel(params.model);
        setPrompt(params.prompt);
        setRatio(imageRatioFromSize(params.size) ?? imageRatiosForModel(targetModel)[0] ?? "16:9");
        setSize(params.size);
        setCount(params.count);
        setQuality(params.quality);
        setOutputFormat(params.outputFormat);
        setFitMode(params.fitMode);
        setSizeMode(params.sizeMode);
        setCustomEnabled(Boolean(targetModel?.customSize.enabled && !targetModel.sizes.includes(params.size)));
        setCustomWidth(String(parsedSize?.width ?? 1024));
        setCustomHeight(String(parsedSize?.height ?? 1024));
        setReferencePaths(params.referencePaths.filter((path) => path !== REDACTED_IMAGE_REFERENCE_PATH));
      } else {
        const targetModel = selectImageModel(models, "", contract?.defaultModelId);
        const defaultRatios = imageRatiosForModel(targetModel);
        const defaultRatio = defaultRatios.includes("16:9") ? "16:9" : (defaultRatios[0] ?? "16:9");
        const defaultSize = preferredImageSize(targetModel, defaultRatio);
        const parsedSize = parseImageSize(defaultSize);
        const defaultQualities = targetModel?.qualities.length ? targetModel.qualities : (["auto"] as ImageQuality[]);
        const defaultFormats = targetModel?.outputFormats.length
          ? targetModel.outputFormats
          : (["png"] as ImageOutputFormat[]);
        const defaultSizeModes = targetModel?.sizeModes.length
          ? targetModel.sizeModes
          : (["postprocess"] as ImageSizeMode[]);
        setSelectedModel(targetModel?.publicName ?? "");
        setPrompt("");
        setRatio(defaultRatio);
        setSize(defaultSize);
        setCount(1);
        setQuality(defaultQualities.includes("high") ? "high" : defaultQualities[0]!);
        setOutputFormat(defaultFormats.includes("png") ? "png" : defaultFormats[0]!);
        setFitMode("contain");
        setSizeMode(defaultSizeModes.includes("postprocess") ? "postprocess" : defaultSizeModes[0]!);
        setCustomEnabled(false);
        setCustomWidth(String(parsedSize?.width ?? 1024));
        setCustomHeight(String(parsedSize?.height ?? 1024));
        setReferencePaths([]);
      }
      setReferenceNote(null);
      setTemplateTheme("");
      setSubmitNote(null);
      setAppliedParamsKey(paramsApplyKey);
    });
    return () => window.clearTimeout(timer);
  }, [active, appliedParamsKey, contract?.defaultModelId, conversationsReady, models, paramsApplyKey]);

  const connected = Boolean(account?.connected);
  const needsTopupBeforeImage = imageAccountNeedsTopup(account);
  const contractReady = Boolean(contract?.ok && models.length > 0);
  const referenceOk = referencePaths.length === 0 || (referenceLimit > 0 && referencePaths.length <= referenceLimit);
  const submitBlockReason =
    !conversationsReady || !active || appliedParamsKey !== paramsApplyKey
      ? "正在载入创作会话。"
      : !connected
        ? "请先连接 RiverMoon 账户。"
        : needsTopupBeforeImage
          ? IMAGE_TOPUP_REQUIRED_MESSAGE
          : !contractReady
            ? contract?.error || "图片能力合同不可用。"
            : !model
              ? "当前 Key 没有可用图片模型。"
              : !prompt.trim()
                ? "请输入提示词。"
                : customError
                  ? customError
                  : !referenceOk
                    ? referenceLimit <= 0
                      ? "当前模型不支持参考图/编辑。"
                      : `参考图数量超过当前模型上限（${referenceLimit} 张）。`
                    : null;
  const canGenerate = submitBlockReason === null;

  async function submitImageTask(params: ImageGenParams, conversationId: string, updateTitle: boolean) {
    if (needsTopupBeforeImage) {
      setSubmitNote(null);
      showImageNotice(IMAGE_TOPUP_REQUIRED_MESSAGE);
      return;
    }
    const order = ++submissionCounterRef.current;
    const pending: PendingImageSubmission = {
      id: randomId(),
      conversationId,
      params: { ...params, referencePaths: [...params.referencePaths] },
      order
    };
    setSubmitNote(null);
    setPendingSubmissions((current) => [...current, pending]);
    setConversations((current) =>
      current
        .map((conversation) => {
          if (conversation.id !== conversationId) return conversation;
          const firstSubmission = conversation.taskIds.length === 0 && conversation.lastParams === null;
          return normalizeImageConversation({
            ...conversation,
            title:
              updateTitle && firstSubmission && !conversation.renamed
                ? params.prompt.replace(/\s+/g, " ").trim().slice(0, 80)
                : conversation.title,
            lastParams: pending.params,
            updatedAt: Math.max(conversation.updatedAt + 1, now)
          })!;
        })
        .sort((left, right) => right.updatedAt - left.updatedAt)
    );
    try {
      const task = await window.upscaler.startImageTask(params);
      if (!task) {
        setSubmitNote("生图参数无效，请检查提示词和模型。");
        return;
      }
      submissionOrderRef.current[task.id] = order;
      setTaskSubmissionOrders((current) => ({ ...current, [task.id]: order }));
      onTaskStarted(task);
      setConversations((current) =>
        current
          .map((conversation) => {
            if (conversation.id !== conversationId) return conversation;
            return normalizeImageConversation({
              ...conversation,
              taskIds: appendImageTaskIdInSubmissionOrder(conversation.taskIds, task.id, submissionOrderRef.current),
              lastParams: { ...params, referencePaths: [...params.referencePaths] },
              updatedAt: Math.max(conversation.updatedAt + 1, task.createdAt)
            })!;
          })
          .sort((left, right) => right.updatedAt - left.updatedAt)
      );
    } catch (error) {
      setSubmitNote(error instanceof Error ? error.message : "生图任务提交失败");
    } finally {
      setPendingSubmissions((current) => current.filter((submission) => submission.id !== pending.id));
    }
  }

  async function generate() {
    if (!canGenerate || !active) return;
    await submitImageTask(
      {
        model: model!.publicName,
        prompt: prompt.trim(),
        size: activeSize,
        count,
        quality: activeQuality,
        outputFormat: activeFormat,
        fitMode,
        sizeMode: activeSizeMode,
        referencePaths: effectiveReferences
      },
      active.id,
      true
    );
  }

  async function rerunTask(params: ImageGenParams) {
    if (!active) return;
    let rerunParams = params;
    if (params.referencePaths.includes(REDACTED_IMAGE_REFERENCE_PATH)) {
      const rerunModel = models.find((item) => item.publicName === params.model || item.internalName === params.model);
      const rerunLimit = imageModelSupportsEditing(rerunModel)
        ? Math.min(MAX_IMAGE_EDIT_REFERENCES, rerunModel!.maxReferences)
        : 0;
      const restoredReferences = resolveImageRerunReferences(params.referencePaths, referencePaths, rerunLimit);
      if (!restoredReferences) {
        setSubmitNote("原参考图未保存在任务记录中，请先重新添加参考图后再试。");
        promptRef.current?.focus();
        return;
      }
      if (rerunModel && rerunModel.publicName !== model?.publicName) setSelectedModel(rerunModel.publicName);
      rerunParams = { ...params, referencePaths: restoredReferences };
    }
    await submitImageTask(rerunParams, active.id, false);
  }

  async function addReferences() {
    if (!model || referenceLimit <= 0) {
      setReferenceNote("当前模型不支持参考图。");
      return;
    }
    const selection = await window.upscaler.selectImageReferences();
    if (selection.rejected.length > 0) {
      const extra = selection.rejected.length > 1 ? ` 等 ${selection.rejected.length} 个文件` : "";
      setReferenceNote(`已跳过：${selection.rejected[0]}${extra}`);
    } else {
      setReferenceNote(null);
    }
    if (selection.paths.length === 0) return;
    const nextPaths = Array.from(new Set([...referencePaths, ...selection.paths])).slice(0, referenceLimit);
    setReferencePaths(nextPaths);
    if (referencePaths.length + selection.paths.length > referenceLimit) {
      setReferenceNote(`已保留前 ${referenceLimit} 张参考图，超过当前模型上限的素材未加入。`);
    }
  }

  function showImageNotice(message: string) {
    if (noticeTimerRef.current != null) window.clearTimeout(noticeTimerRef.current);
    setImageNotice(message);
    noticeTimerRef.current = window.setTimeout(() => {
      setImageNotice(null);
      noticeTimerRef.current = null;
    }, 2600);
  }

  function editOutputImage(outputPath: string) {
    const editModel = imageModelSupportsEditing(model) ? model : models.find(imageModelSupportsEditing);
    if (!editModel) {
      showImageNotice("当前 Key 没有支持参考图编辑的模型。");
      return;
    }
    if (editModel.publicName !== model?.publicName) setSelectedModel(editModel.publicName);
    const editLimit = Math.min(MAX_IMAGE_EDIT_REFERENCES, editModel.maxReferences);
    const update = addImageEditReference(referencePaths, outputPath, editLimit);
    setReferencePaths(update.referencePaths);
    setReferenceNote(null);
    if (update.replacedFirst) {
      showImageNotice(
        editLimit === MAX_IMAGE_EDIT_REFERENCES
          ? "参考图已满 20 张，已替换第 1 张。"
          : `当前模型最多支持 ${editLimit} 张参考图，已替换第 1 张。`
      );
    }
    window.setTimeout(() => {
      const input = promptRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  function changeRatio(nextRatio: string) {
    setRatio(nextRatio);
    const nextSize = preferredImageSize(model, nextRatio);
    if (nextSize) {
      setSize(nextSize);
      const parsed = parseImageSize(nextSize);
      if (parsed) {
        setCustomWidth(String(parsed.width));
        setCustomHeight(String(parsed.height));
      }
    }
  }

  function applyTemplate(template: (typeof STORYBOARD_TEMPLATES)[number]) {
    const theme = templateTheme.trim() || prompt.trim() || "一个有连续剧情的主题";
    setPrompt(template.build(theme));
    setTemplateTheme(theme);
  }

  function patchActiveConversation(patch: Partial<ImageConversation>) {
    if (!active) return;
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === active.id
          ? normalizeImageConversation({ ...conversation, ...patch, updatedAt: Date.now() })!
          : conversation
      )
    );
  }

  function renameActiveConversation(title: string) {
    if (!active) return;
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === active.id
          ? { ...conversation, title: title.slice(0, 80), renamed: true, updatedAt: Date.now() }
          : conversation
      )
    );
  }

  function createConversation() {
    const conversation = createImageConversation();
    setConversations((current) => [conversation, ...current].slice(0, 80));
    setActiveId(conversation.id);
    setSubmitNote(null);
  }

  function selectConversation(id: string) {
    setActiveId(id);
    setSubmitNote(null);
    setReferenceNote(null);
  }

  function deleteConversation(id: string) {
    const next = conversations.filter((conversation) => conversation.id !== id);
    if (next.length === 0) {
      const conversation = createImageConversation();
      setConversations([conversation]);
      setActiveId(conversation.id);
      return;
    }
    setConversations(next);
    if (id === active?.id) setActiveId(next[0]!.id);
  }

  function clearFinishedInConversation() {
    if (!active) return;
    const nextTaskIds = active.taskIds.filter((id) => {
      const task = tasksById.get(id);
      return task?.status === "queued" || task?.status === "running";
    });
    if (nextTaskIds.length === active.taskIds.length) return;
    patchActiveConversation({ taskIds: nextTaskIds });
  }

  return (
    <>
      <div className="module-head">
        <div>
          <h1>AI 生图</h1>
          <p>生成、参考图编辑与分镜创作</p>
        </div>
        <div className="head-actions">
          {connected ? (
            <span className={`key-status ${contractReady ? "ok" : "warn"}`}>
              {contractReady ? `图片合同 ${models.length} 个可用` : contract?.error || "图片合同不可用"}
            </span>
          ) : null}
          <button className="secondary sm" onClick={onRefreshContract}>
            同步合同
          </button>
        </div>
      </div>

      {!connected ? (
        <div className="panel empty">
          <p>连接 rivermoon7.com 账户后即可生成图片。</p>
          <button className="primary" onClick={onGoSettings}>
            去连接账户
          </button>
        </div>
      ) : (
        <section className="imagegen-shell">
          {imageNotice ? (
            <div className="imagegen-toast" role="status">
              {imageNotice}
            </div>
          ) : null}
          <aside className="agent-history">
            <div className="agent-history-head">
              <div>
                <h2>创作会话</h2>
                <p>本机保存</p>
              </div>
              <button
                className="icon-button"
                onClick={createConversation}
                disabled={!conversationsReady}
                title="新建会话"
                aria-label="新建会话"
              >
                <Plus size={16} strokeWidth={1.8} aria-hidden="true" />
              </button>
            </div>
            <div className="agent-history-list">
              {conversationsReady ? (
                conversations.map((conversation) => {
                  const firstTask = tasksById.get(conversation.taskIds[0] ?? "");
                  const previewPath = firstTask?.outputPaths[0];
                  return (
                    <button
                      key={conversation.id}
                      className={`agent-conversation image-conversation ${conversation.id === active?.id ? "on" : ""}`}
                      onClick={() => selectConversation(conversation.id)}
                    >
                      {previewPath ? (
                        <Thumb path={previewPath} max={96} className="image-conversation-thumb" />
                      ) : (
                        <span className="thumb image-conversation-thumb image-conversation-placeholder">
                          <Images size={16} strokeWidth={1.7} aria-hidden="true" />
                        </span>
                      )}
                      <span className="image-conversation-copy">
                        <span className="agent-conversation-title" title={conversation.title}>
                          {conversation.title || "新会话"}
                        </span>
                        <span className="agent-conversation-time">{formatShortTime(conversation.updatedAt)}</span>
                      </span>
                      <span className="count-badge">
                        {conversation.taskIds.length + (pendingCountByConversation.get(conversation.id) ?? 0)}
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="empty">正在载入会话...</div>
              )}
            </div>
          </aside>

          <div className="agent-main imagegen-main">
            <div className="agent-toolbar imagegen-toolbar">
              <div className="agent-title-group">
                <input
                  value={active?.title ?? ""}
                  onChange={(event) => renameActiveConversation(event.target.value)}
                  aria-label="会话标题"
                  disabled={!active}
                />
                <button
                  className="icon-button"
                  onClick={() => active && deleteConversation(active.id)}
                  disabled={!active}
                  title="删除会话"
                  aria-label="删除会话"
                >
                  <Trash2 size={15} strokeWidth={1.8} aria-hidden="true" />
                </button>
              </div>
              <div className="imagegen-toolbar-meta">
                <span className="count-badge">{(active?.taskIds.length ?? 0) + activePendingSubmissions.length}</span>
                {active &&
                (active.taskIds.length !== activeTasks.length ||
                  activeTasks.some((task) => task.status !== "queued" && task.status !== "running")) ? (
                  <button className="link-button" onClick={clearFinishedInConversation}>
                    清空已结束
                  </button>
                ) : null}
              </div>
            </div>

            <div className="imagegen-feed">
              <ImageTaskList
                tasks={activeTasks}
                pendingSubmissions={activePendingSubmissions}
                submissionOrders={taskSubmissionOrders}
                now={now}
                onUpscale={onUpscale}
                onRerun={rerunTask}
                onEditImage={editOutputImage}
              />
            </div>

            <div className="imagegen-composer">
              <div className="imagegen-parameters image-settings-rail">
                <div className="image-rail-head">
                  <div className="segmented">
                    <button
                      className={editingImage ? "" : "on"}
                      type="button"
                      onClick={() => {
                        setReferencePaths([]);
                        setReferenceNote(null);
                      }}
                    >
                      生成
                    </button>
                    <button
                      className={editingImage ? "on" : ""}
                      type="button"
                      disabled={referenceLimit <= 0}
                      onClick={() => void addReferences()}
                    >
                      编辑
                    </button>
                  </div>
                  <span className="image-chip">RiverMoon 账户</span>
                </div>

                <div className="image-control-grid">
                  <label className="image-model-field">
                    模型
                    <select value={model?.publicName ?? ""} onChange={(event) => setSelectedModel(event.target.value)}>
                      {models.map((id) => (
                        <option key={id.publicName} value={id.publicName}>
                          {id.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    比例
                    <select value={activeRatio} onChange={(event) => changeRatio(event.target.value)}>
                      {ratios.map((item) => (
                        <option key={item} value={item}>
                          {IMAGE_RATIO_LABELS[item] ?? item}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    尺寸
                    <select
                      value={customEnabled ? "__custom" : activeSize}
                      onChange={(event) => {
                        if (event.target.value === "__custom") {
                          setCustomEnabled(true);
                          return;
                        }
                        setCustomEnabled(false);
                        setSize(event.target.value);
                      }}
                    >
                      {sizeOptions.map((item) => (
                        <option key={item} value={item}>
                          {imageSizeLabel(item)}
                        </option>
                      ))}
                      {model?.customSize.enabled ? <option value="__custom">自定义尺寸</option> : null}
                    </select>
                  </label>
                  <label>
                    质量
                    <select value={activeQuality} onChange={(event) => setQuality(event.target.value as ImageQuality)}>
                      {qualityOptions.map((item) => (
                        <option key={item} value={item}>
                          {IMAGE_QUALITY_LABELS[item]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    格式
                    <select
                      value={activeFormat}
                      onChange={(event) => setOutputFormat(event.target.value as ImageOutputFormat)}
                    >
                      {formatOptions.map((item) => (
                        <option key={item} value={item}>
                          {IMAGE_FORMAT_LABELS[item]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    数量
                    <select value={count} onChange={(event) => setCount(Number(event.target.value))}>
                      {[1, 2, 3, 4].map((value) => (
                        <option key={value} value={value}>
                          {value} 张
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    适配
                    <select value={fitMode} onChange={(event) => setFitMode(event.target.value as ImageFitMode)}>
                      <option value="contain">完整留白</option>
                      <option value="cover">居中裁切</option>
                    </select>
                  </label>
                </div>

                {customEnabled ? (
                  <div className="custom-size-row">
                    <label>
                      宽度 px
                      <input
                        value={customWidth}
                        onChange={(event) => setCustomWidth(event.target.value.replace(/[^\d]/g, "").slice(0, 5))}
                      />
                    </label>
                    <label>
                      高度 px
                      <input
                        value={customHeight}
                        onChange={(event) => setCustomHeight(event.target.value.replace(/[^\d]/g, "").slice(0, 5))}
                      />
                    </label>
                    <button
                      className="secondary sm"
                      onClick={() => {
                        const width = customWidth;
                        setCustomWidth(customHeight);
                        setCustomHeight(width);
                      }}
                    >
                      交换
                    </button>
                    {customError ? <span className="hint-warn">{customError}</span> : null}
                  </div>
                ) : null}

                <div className="image-option-row">
                  <button
                    className={`toggle-pill ${activeSizeMode === "native" ? "on" : ""}`}
                    disabled={!sizeModeOptions.includes("native")}
                    onClick={() => setSizeMode(activeSizeMode === "native" ? "postprocess" : "native")}
                    type="button"
                  >
                    原生直出 <span>{activeSizeMode === "native" ? "开" : "关"}</span>
                  </button>
                  <button
                    className={`toggle-pill ${showStoryboard ? "on" : ""}`}
                    onClick={() => setShowStoryboard((current) => !current)}
                    type="button"
                  >
                    分镜模板
                  </button>
                  <button className="secondary sm" disabled={referenceLimit <= 0} onClick={() => void addReferences()}>
                    添加参考图
                  </button>
                  {referencePaths.length > 0 ? (
                    <button className="link-button" onClick={() => setReferencePaths([])}>
                      清空
                    </button>
                  ) : null}
                  <span className="field-note">
                    {referenceLimit > 0 ? `${referencePaths.length}/${referenceLimit} 张` : "当前模型不支持参考图"}
                  </span>
                </div>

                {referencePaths.length > 0 ? (
                  <div className="image-reference-list">
                    {referencePaths.map((item, index) => (
                      <div className="video-reference-item" key={item}>
                        <span>@图{index + 1}</span>
                        <span className="reference-name">{basename(item)}</span>
                        <button
                          className="icon-mini"
                          aria-label="移除参考图"
                          onClick={() => setReferencePaths((current) => current.filter((path) => path !== item))}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ) : null}
                {referenceNote ? <p className="hint-warn">{referenceNote}</p> : null}

                {showStoryboard ? (
                  <div className="storyboard-section">
                    <span className="field-label">分镜模板</span>
                    <input
                      value={templateTheme}
                      placeholder="输入主题"
                      onChange={(event) => setTemplateTheme(event.target.value)}
                    />
                    <div className="story-template-actions">
                      {STORYBOARD_TEMPLATES.map((template) => (
                        <button
                          className="secondary sm"
                          key={template.id}
                          type="button"
                          title={template.mode}
                          onClick={() => applyTemplate(template)}
                        >
                          {template.label}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {model?.notice ? <p className="field-note">{model.notice}</p> : null}
              </div>

              <div className="imagegen-prompt-area">
                <textarea
                  ref={promptRef}
                  className="image-stage-prompt"
                  rows={4}
                  placeholder="描述画面、主体、构图、光线与风格。使用多张参考图时，可以在提示词中写 @图1、@图2。"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    void generate();
                  }}
                />
                <div className="image-submit-bar">
                  <div className="image-submit-status">
                    {submitBlockReason ? (
                      <span className="submit-block-reason">{submitBlockReason}</span>
                    ) : (
                      <span>准备生成 {count} 张图片</span>
                    )}
                    {submitNote ? <span className="submit-block-reason">{submitNote}</span> : null}
                    {needsTopupBeforeImage ? (
                      <button
                        className="link-button imagegen-topup-link"
                        onClick={() => void window.upscaler.openTopup()}
                      >
                        去充值
                      </button>
                    ) : null}
                  </div>
                  <button className="primary gen-btn" disabled={!canGenerate} onClick={() => void generate()}>
                    生成 {count > 1 ? `${count} 张` : "图片"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}
    </>
  );
}

function ImageTaskList({
  tasks,
  pendingSubmissions,
  submissionOrders,
  now,
  onUpscale,
  onRerun,
  onEditImage
}: {
  tasks: ImageGenTask[];
  pendingSubmissions: PendingImageSubmission[];
  submissionOrders: Readonly<Record<string, number>>;
  now: number;
  onUpscale: (path: string) => void;
  onRerun: (params: ImageGenParams) => void;
  onEditImage: (path: string) => void;
}) {
  if (tasks.length === 0 && pendingSubmissions.length === 0) {
    return <div className="empty imagegen-empty">描述画面开始创作</div>;
  }
  const timeline = mergeImageTaskTimeline(tasks, pendingSubmissions, submissionOrders);
  return (
    <div className="job-list imagegen-task-list">
      {timeline.map((item) =>
        item.kind === "pending" ? (
          <PendingImageTaskCard key={item.id} submission={item.submission} />
        ) : (
          <ImageTaskCard
            key={item.id}
            task={item.task}
            now={now}
            onUpscale={onUpscale}
            onRerun={onRerun}
            onEditImage={onEditImage}
          />
        )
      )}
    </div>
  );
}

function PendingImageTaskCard({ submission }: { submission: PendingImageSubmission }) {
  const { params } = submission;
  const promptPreview = params.prompt.length > 64 ? `${params.prompt.slice(0, 64)}…` : params.prompt;
  return (
    <article className="job queued">
      <div className="job-head">
        <div className="job-title">
          <h3>{promptPreview}</h3>
          <p>
            {params.model} · {params.size.replace("x", "×")} · {params.quality.toUpperCase()} ·{" "}
            {IMAGE_FORMAT_LABELS[params.outputFormat]} · {params.count} 张
            {params.referencePaths.length > 0 ? ` · 参考图 ${params.referencePaths.length}` : ""} · 正在提交
          </p>
        </div>
        <span className="pill queued">提交中</span>
      </div>
      <div className="progress indeterminate" role="progressbar" aria-label="正在提交生图任务">
        <div />
      </div>
    </article>
  );
}

function ImageTaskCard({
  task,
  now,
  onUpscale,
  onRerun,
  onEditImage
}: {
  task: ImageGenTask;
  now: number;
  onUpscale: (path: string) => void;
  onRerun: (params: ImageGenParams) => void;
  onEditImage: (path: string) => void;
}) {
  const active = task.status === "running" || task.status === "queued";
  const promptPreview = task.params.prompt.length > 64 ? `${task.params.prompt.slice(0, 64)}…` : task.params.prompt;

  return (
    <article className={`job ${task.status}`}>
      <div className="job-head">
        <div className="job-title">
          <h3>{promptPreview}</h3>
          <p>
            {task.params.model} · {task.params.size.replace("x", "×")} · {task.params.quality.toUpperCase()} ·{" "}
            {IMAGE_FORMAT_LABELS[task.params.outputFormat]} · {task.params.count} 张
            {task.params.referencePaths.length > 0 ? ` · 参考图 ${task.params.referencePaths.length}` : ""}
            {active ? ` · ${task.message}` : ""}
          </p>
        </div>
        <span className={`pill ${task.status}`}>{statusText(task.status)}</span>
      </div>

      {active ? (
        <div className="progress indeterminate" role="progressbar" aria-label="生成中">
          <div />
        </div>
      ) : null}

      {task.outputPaths.length > 0 ? (
        <div className="gen-outputs">
          {task.outputPaths.map((outputPath) => (
            <div key={outputPath} className="gen-output">
              <Thumb path={outputPath} max={320} className="thumb-gen" />
              <div className="gen-output-actions">
                <button className="secondary sm" onClick={() => onEditImage(outputPath)}>
                  <PencilLine size={13} strokeWidth={1.8} aria-hidden="true" />
                  编辑此图
                </button>
                <button className="secondary sm" onClick={() => onUpscale(outputPath)}>
                  超分到 4K
                </button>
                <button className="secondary sm" onClick={() => void window.upscaler.reveal(outputPath)}>
                  打开位置
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {task.status === "failed" && task.error ? (
        <div className="job-error">
          <span>{task.error}</span>
          <div className="job-error-actions">
            {task.needsTopup ? (
              <button className="primary sm" onClick={() => void window.upscaler.openTopup()}>
                去充值
              </button>
            ) : null}
            <button className="secondary sm" onClick={() => onRerun(task.params)}>
              重试
            </button>
          </div>
        </div>
      ) : null}

      <div className="job-meta">
        {task.status === "running" && task.startedAt ? (
          <span>已用 {formatDuration(now - task.startedAt)}</span>
        ) : task.durationMs != null ? (
          <span>耗时 {formatDuration(task.durationMs)}</span>
        ) : null}
        {active ? (
          <button className="secondary sm" onClick={() => void window.upscaler.cancelImageTask(task.id)}>
            取消
          </button>
        ) : null}
        {task.status === "succeeded" ? (
          <button className="secondary sm" onClick={() => onRerun(task.params)}>
            再来一张
          </button>
        ) : null}
      </div>
    </article>
  );
}

const VIDEO_ENDPOINT_LABELS: Record<string, string> = {
  text_to_video: "文生视频",
  image_to_video: "图生视频",
  reference_to_video: "多参考图",
  first_last_frame: "首尾帧"
};

const VIDEO_REFERENCE_TYPE_LABELS: Record<VideoReferenceType, string> = {
  ordinary: "普通参考",
  reference: "主体参考",
  first_frame: "首帧",
  last_frame: "尾帧",
  character: "角色",
  style: "风格"
};

const VIDEO_REFERENCE_TYPE_ORDER: VideoReferenceType[] = [
  "ordinary",
  "reference",
  "first_frame",
  "character",
  "style",
  "last_frame"
];

function groupVideoModelsByFamily(
  models: VideoContractModel[]
): Array<{ family: string; models: VideoContractModel[] }> {
  const groups = new Map<string, VideoContractModel[]>();
  for (const item of models) {
    const family = item.family.trim() || "video";
    groups.set(family, [...(groups.get(family) ?? []), item]);
  }
  return Array.from(groups, ([family, groupedModels]) => ({ family, models: groupedModels }));
}

function videoContractStatus(
  contract: VideoContract | null,
  fresh: boolean
): { label: string; syncedLabel: string; warning: string | null } {
  if (!contract?.ok) return { label: "视频合同", syncedLabel: "同步于", warning: null };
  if (fresh) return { label: "HTTPS 合同", syncedLabel: "HTTPS 同步于", warning: null };
  if (contract.fromCache) {
    return {
      label: "缓存合同",
      syncedLabel: "缓存于",
      warning: "当前使用缓存合同，仅供查看；生成视频前必须同步 HTTPS 实时合同。"
    };
  }
  if (contract.source === "http") {
    return {
      label: "HTTP 合同",
      syncedLabel: "HTTP 同步于",
      warning: "当前合同来自公开 HTTP fallback，仅供查看；生成视频前必须同步 HTTPS 实时合同。"
    };
  }
  return {
    label: "合同待确认",
    syncedLabel: "同步于",
    warning: "当前视频合同来源未确认，仅供查看；生成视频前必须同步 HTTPS 实时合同。"
  };
}

function selectVideoModel(
  models: VideoContractModel[],
  selectedModel: string,
  defaultModelId: string | null | undefined
): VideoContractModel | undefined {
  if (selectedModel && models.some((item) => item.id === selectedModel)) {
    return models.find((item) => item.id === selectedModel);
  }
  return (
    models.find((item) => defaultModelId && item.id === defaultModelId) ??
    models.find((item) => item.primary) ??
    models[0]
  );
}

function selectVideoOption<T extends string | number>(options: T[] | undefined, selected: T, fallback: T | null): T {
  if (options?.includes(selected)) return selected;
  if (fallback != null && options?.includes(fallback)) return fallback;
  return options?.[0] ?? selected;
}

function selectableVideoReferenceTypes(
  model: VideoContractModel | undefined,
  endpoint: VideoEndpoint
): VideoReferenceType[] {
  if (!model || endpoint === "text_to_video" || endpoint === "first_last_frame") return [];
  const supported = model.referenceTypes.length > 0 ? model.referenceTypes : VIDEO_REFERENCE_TYPE_ORDER;
  return VIDEO_REFERENCE_TYPE_ORDER.filter((item) => item !== "last_frame" && supported.includes(item));
}

function VideoGenModule({
  account,
  contract,
  tasks,
  now,
  onGoSettings,
  onRefreshContract,
  onSyncRecent
}: {
  account: AccountStatus | null;
  contract: VideoContract | null;
  tasks: VideoGenTask[];
  now: number;
  onGoSettings: () => void;
  onRefreshContract: () => void;
  onSyncRecent: () => Promise<void>;
}) {
  const models = useMemo(
    () => (contract?.models ?? []).filter((model) => model.enabled && model.endpoints.length > 0),
    [contract]
  );
  const modelGroups = useMemo(() => groupVideoModelsByFamily(models), [models]);
  const [selectedModel, setSelectedModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [endpoint, setEndpoint] = useState<VideoEndpoint | "">("");
  const [aspectRatio, setAspectRatio] = useState("");
  const [duration, setDuration] = useState(0);
  const [resolution, setResolution] = useState("");
  const [referencePaths, setReferencePaths] = useState<string[]>([]);
  const [referenceType, setReferenceType] = useState<VideoReferenceType>("ordinary");
  const [referenceTypeByPath, setReferenceTypeByPath] = useState<Record<string, VideoReferenceType>>({});
  const [referenceNote, setReferenceNote] = useState<string | null>(null);
  const [syncingRecent, setSyncingRecent] = useState(false);
  const [syncRecentNote, setSyncRecentNote] = useState<string | null>(null);

  const model = selectVideoModel(models, selectedModel, contract?.defaultModelId);
  const activeEndpoint = model?.endpoints.includes(endpoint as VideoEndpoint)
    ? (endpoint as VideoEndpoint)
    : model?.endpoints.includes("text_to_video")
      ? "text_to_video"
      : (model?.endpoints[0] ?? "text_to_video");
  const activeRatio = selectVideoOption(model?.aspectRatios, aspectRatio, model?.defaultAspectRatio ?? "16:9");
  const activeDuration = selectVideoOption(model?.durations, duration, model?.defaultDuration ?? 5);
  const activeResolution = selectVideoOption(model?.resolutions, resolution, model?.defaultResolution ?? "720p");
  const connected = Boolean(account?.connected);
  const contractReady = Boolean(contract?.ok && models.length > 0);
  const contractFresh = contractReady && contract?.fromCache !== true && contract?.source === "https";
  const requiredReferenceCount = activeEndpoint === "text_to_video" ? 0 : activeEndpoint === "first_last_frame" ? 2 : 1;
  const referenceLimit =
    activeEndpoint === "text_to_video"
      ? 0
      : model?.maxReferences && model.maxReferences > 0
        ? model.maxReferences
        : requiredReferenceCount;
  const referenceCapacityOk = activeEndpoint === "text_to_video" || referenceLimit >= requiredReferenceCount;
  const selectableReferenceTypes = selectableVideoReferenceTypes(model, activeEndpoint);
  const activeReferenceType = selectableReferenceTypes.includes(referenceType)
    ? referenceType
    : (selectableReferenceTypes[0] ?? "ordinary");
  const effectiveReferences = activeEndpoint === "text_to_video" ? [] : referencePaths.slice(0, referenceLimit);
  const referenceTypes = resolveRendererVideoReferenceTypes(
    activeEndpoint,
    effectiveReferences,
    activeReferenceType,
    referenceTypeByPath,
    selectableReferenceTypes
  );
  const referenceReady =
    activeEndpoint === "text_to_video" || (referenceCapacityOk && effectiveReferences.length >= requiredReferenceCount);
  const referenceCountOk = activeEndpoint === "text_to_video" || referencePaths.length <= referenceLimit;
  const submitBlockReason = videoSubmitBlockReason({
    connected,
    contractReady,
    contractFresh,
    hasModel: Boolean(model),
    prompt,
    endpoint: activeEndpoint,
    referenceCapacityOk,
    referenceReady,
    referenceCountOk,
    requiredReferenceCount,
    referenceCount: referencePaths.length,
    referenceLimit
  });
  const canGenerate = submitBlockReason === null;
  const endpointLabels = model?.endpoints.map((endpoint) => VIDEO_ENDPOINT_LABELS[endpoint] ?? endpoint) ?? [];
  const priceText = model?.estimatedPriceUsd != null ? formatUsd(model.estimatedPriceUsd) : "按服务端实际扣费";
  const contractStatus = videoContractStatus(contract, contractFresh);

  async function generate() {
    if (!canGenerate || !model) return;
    setSyncRecentNote(null);
    try {
      const task = await window.upscaler.startVideoTask({
        model: model.id,
        prompt: prompt.trim(),
        endpoint: activeEndpoint,
        aspectRatio: activeRatio,
        duration: activeDuration,
        resolution: activeResolution,
        referencePaths: effectiveReferences,
        referenceType: activeReferenceType,
        referenceTypes
      });
      if (!task) setSyncRecentNote("视频参数无效，请检查模型和提示词。");
    } catch (error) {
      setSyncRecentNote(error instanceof Error ? error.message : "视频任务提交失败");
    }
  }

  function applyReferenceTypeToAll(nextType: VideoReferenceType) {
    setReferenceType(nextType);
    setReferenceTypeByPath((current) => ({
      ...current,
      ...Object.fromEntries(effectiveReferences.map((referencePath) => [referencePath, nextType]))
    }));
  }

  function setSingleReferenceType(referencePath: string, nextType: VideoReferenceType) {
    setReferenceTypeByPath((current) => ({ ...current, [referencePath]: nextType }));
  }

  function removeReferenceImage(referencePath: string) {
    setReferencePaths((current) => current.filter((item) => item !== referencePath));
    setReferenceTypeByPath((current) => {
      const next = { ...current };
      delete next[referencePath];
      return next;
    });
  }

  function clearReferenceImages() {
    setReferencePaths([]);
    setReferenceTypeByPath({});
  }

  async function addReferenceImages() {
    const selection = await window.upscaler.selectVideoSources();
    const files = selection.paths;
    if (selection.rejected.length > 0) {
      const extra = selection.rejected.length > 1 ? ` 等 ${selection.rejected.length} 个文件` : "";
      setReferenceNote(`已跳过：${selection.rejected[0]}${extra}`);
    } else {
      setReferenceNote(null);
    }
    if (files.length === 0) return;
    const nextPaths = Array.from(new Set([...referencePaths, ...files])).slice(0, referenceLimit);
    setReferencePaths(nextPaths);
    setReferenceTypeByPath((currentTypes) => {
      const pruned = pruneVideoReferenceTypeMap(currentTypes, nextPaths);
      for (const referencePath of nextPaths) {
        if (!pruned[referencePath]) pruned[referencePath] = activeReferenceType;
      }
      return pruned;
    });
    if (referenceLimit > 0 && referencePaths.length + files.length > referenceLimit) {
      setReferenceNote(`已保留前 ${referenceLimit} 张参考图，超过当前模型上限的素材未加入。`);
    }
  }

  async function syncRecent() {
    if (!connected || syncingRecent) return;
    setSyncingRecent(true);
    setSyncRecentNote(null);
    try {
      await onSyncRecent();
      setSyncRecentNote("远端任务已同步");
    } catch (error) {
      setSyncRecentNote(error instanceof Error ? error.message : "同步远端任务失败");
    } finally {
      setSyncingRecent(false);
    }
  }

  return (
    <>
      <div className="module-head">
        <div>
          <h1>AI 视频</h1>
          <p>从文字或参考图生成视频</p>
        </div>
        <div className="head-actions">
          <span className={`key-status ${contractFresh ? "ok" : "warn"}`}>
            {contractReady ? `${contractStatus.label} ${models.length} 个可用` : contract?.error || "正在同步视频合同"}
          </span>
          {contract?.ok ? (
            <span className="sync-note">
              {contractStatus.syncedLabel} {formatDateTime(contract.fetchedAt)}
            </span>
          ) : null}
          <button className="secondary sm" onClick={onRefreshContract}>
            同步合同
          </button>
          <button className="secondary sm" disabled={!connected || syncingRecent} onClick={() => void syncRecent()}>
            {syncingRecent ? "同步中…" : "同步远端任务"}
          </button>
        </div>
      </div>

      {!connected ? (
        <div className="panel empty">
          <p>连接 rivermoon7.com 账户后即可生成视频。</p>
          <button className="primary" onClick={onGoSettings}>
            去连接账户
          </button>
        </div>
      ) : !contractReady ? (
        <div className="panel empty">
          <p>{contract?.error || "视频合同暂不可用，请稍后重试。"}</p>
          <button className="secondary" onClick={onRefreshContract}>
            重新同步
          </button>
        </div>
      ) : (
        <>
          <section className="panel video-studio">
            <div className="video-form-grid">
              <label>
                模型
                <select value={model?.id ?? ""} onChange={(event) => setSelectedModel(event.target.value)}>
                  {modelGroups.map((group) => (
                    <optgroup key={group.family} label={group.family}>
                      {group.models.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                          {item.estimatedPriceUsd != null ? ` · ${formatUsd(item.estimatedPriceUsd)}` : ""}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <label>
                模式
                <select value={activeEndpoint} onChange={(event) => setEndpoint(event.target.value as VideoEndpoint)}>
                  {(model?.endpoints ?? []).map((item) => (
                    <option key={item} value={item}>
                      {VIDEO_ENDPOINT_LABELS[item] ?? item}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                比例
                <select value={activeRatio} onChange={(event) => setAspectRatio(event.target.value)}>
                  {(model?.aspectRatios ?? []).map((ratio) => (
                    <option key={ratio} value={ratio}>
                      {ratio}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                时长
                <select value={activeDuration} onChange={(event) => setDuration(Number(event.target.value))}>
                  {(model?.durations ?? []).map((item) => (
                    <option key={item} value={item}>
                      {item} 秒
                    </option>
                  ))}
                </select>
              </label>
              <label>
                清晰度
                <select value={activeResolution} onChange={(event) => setResolution(event.target.value)}>
                  {(model?.resolutions ?? []).map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {model ? (
              <div className="video-model-strip">
                <span>{model.family}</span>
                <span>{endpointLabels.join(" / ")}</span>
                <span>预估 {priceText}</span>
                {model.maxReferences > 0 ? <span>最多 {model.maxReferences} 张参考图</span> : null}
                {model.notice ? <span>{model.notice}</span> : null}
              </div>
            ) : null}

            <div className="video-prompt-shell">
              <textarea
                rows={6}
                placeholder="描述镜头、主体、动作、光线和风格。例如：夜晚雨后的赛博朋克街头，镜头缓慢推进，一位穿银色风衣的女性回头看向霓虹灯，电影感，浅景深"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <div className="video-submit-card">
                <strong>{VIDEO_ENDPOINT_LABELS[activeEndpoint] ?? activeEndpoint}</strong>
                <span>
                  {VIDEO_ENDPOINT_LABELS[activeEndpoint] ?? activeEndpoint} · {model?.label ?? "视频模型"} ·{" "}
                  {activeRatio} · {activeDuration} 秒 · {activeResolution} · 预估 {priceText}
                </span>
                {submitBlockReason ? <span className="submit-block-reason">{submitBlockReason}</span> : null}
                <button className="primary gen-btn" disabled={!canGenerate} onClick={() => void generate()}>
                  生成视频
                </button>
              </div>
            </div>
            {activeEndpoint !== "text_to_video" ? (
              <div className="video-reference-box">
                <div className="video-reference-head">
                  <strong>参考图</strong>
                  <span>
                    {referencePaths.length}/{referenceLimit}
                  </span>
                  {activeEndpoint === "first_last_frame" ? (
                    <span>第 1 张首帧，第 2 张尾帧</span>
                  ) : (
                    <select
                      value={activeReferenceType}
                      onChange={(event) => applyReferenceTypeToAll(event.target.value as VideoReferenceType)}
                      aria-label="批量设置参考图类型"
                    >
                      {selectableReferenceTypes.map((item) => (
                        <option key={item} value={item}>
                          {VIDEO_REFERENCE_TYPE_LABELS[item]}
                        </option>
                      ))}
                    </select>
                  )}
                  <button className="secondary sm" onClick={() => void addReferenceImages()}>
                    添加图片
                  </button>
                  {referencePaths.length > 0 ? (
                    <button className="link-button" onClick={clearReferenceImages}>
                      清空
                    </button>
                  ) : null}
                </div>
                {referencePaths.length === 0 ? (
                  <p className="field-note">
                    {activeEndpoint === "first_last_frame"
                      ? "首尾帧模式需要 2 张参考图，添加顺序为首帧、尾帧。支持 JPG、PNG、WebP、GIF，单张不超过 20MB。"
                      : "当前模式需要至少 1 张参考图；支持 JPG、PNG、WebP、GIF，单张不超过 20MB。"}
                  </p>
                ) : (
                  <div className="video-reference-list">
                    {referencePaths.map((item, index) => {
                      const itemReferenceType = referenceTypes[index] ?? activeReferenceType;
                      return (
                        <div className="video-reference-item" key={item}>
                          {activeEndpoint === "first_last_frame" ? (
                            `${index === 0 ? "首帧" : index === 1 ? "尾帧" : "参考"} · `
                          ) : (
                            <select
                              className="reference-type-select"
                              value={itemReferenceType}
                              aria-label={`${basename(item)} 参考图类型`}
                              onChange={(event) =>
                                setSingleReferenceType(item, event.target.value as VideoReferenceType)
                              }
                            >
                              {selectableReferenceTypes.map((type) => (
                                <option key={type} value={type}>
                                  {VIDEO_REFERENCE_TYPE_LABELS[type]}
                                </option>
                              ))}
                            </select>
                          )}
                          <span className="reference-name">{basename(item)}</span>
                          <button
                            className="icon-mini"
                            aria-label="移除参考图"
                            onClick={() => removeReferenceImage(item)}
                          >
                            ×
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {referenceNote ? <p className="hint-warn">{referenceNote}</p> : null}
                {!referenceCapacityOk ? (
                  <p className="hint-warn">当前模型的参考图上限不足以使用该模式，请同步合同或切换模型。</p>
                ) : null}
                {!referenceCountOk ? (
                  <p className="hint-warn">参考图数量超过当前模型上限，请删除多余素材或切换多参考模型。</p>
                ) : null}
              </div>
            ) : null}
            {contractStatus.warning ? <p className="hint-warn">{contractStatus.warning}</p> : null}
            {contract?.fromCache && contract.error ? <p className="hint-warn">{contract.error}</p> : null}
            {syncRecentNote ? <p className="field-note">{syncRecentNote}</p> : null}
          </section>

          <VideoTaskList tasks={tasks} now={now} />
        </>
      )}
    </>
  );
}

function VideoTaskList({ tasks, now }: { tasks: VideoGenTask[]; now: number }) {
  const hasClearableFinished = tasks.some((task) => isClearableFinishedVideoTask(task));
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>
          视频记录 <span className="count-badge">{tasks.length}</span>
        </h2>
        {hasClearableFinished ? (
          <button className="link-button" onClick={() => void window.upscaler.clearFinishedVideoTasks()}>
            清空已结束
          </button>
        ) : null}
      </div>
      {tasks.length === 0 ? (
        <div className="empty">还没有视频任务，写一段镜头描述开始生成。</div>
      ) : (
        <div className="job-list">
          {tasks.map((task) => (
            <VideoTaskCard key={task.id} task={task} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}

function VideoTaskCard({ task, now }: { task: VideoGenTask; now: number }) {
  const active = task.status === "running" || task.status === "queued";
  const promptPreview = task.params.prompt.length > 90 ? `${task.params.prompt.slice(0, 90)}…` : task.params.prompt;
  const billingText = videoBillingText(task);
  const stoppedRemoteSync = isStoppedRemoteSyncTask(task);
  const [copyNote, setCopyNote] = useState<string | null>(null);

  async function copyDiagnostics() {
    await window.upscaler.copyText(videoTaskDiagnosticText(task));
    setCopyNote("诊断已复制");
    window.setTimeout(() => setCopyNote(null), 1800);
  }

  return (
    <article className={`job video-job ${task.status}`}>
      <div className="job-head">
        <div className="job-title">
          <h3>{promptPreview}</h3>
          <p>
            {VIDEO_ENDPOINT_LABELS[task.params.endpoint] ?? task.params.endpoint} · {task.params.model} ·{" "}
            {task.params.aspectRatio} · {task.params.duration} 秒 · {task.params.resolution}
            {active ? ` · ${task.message}` : ""}
          </p>
        </div>
        <span className={`pill ${task.status}`}>{statusText(task.status === "expired" ? "failed" : task.status)}</span>
      </div>

      {active ? (
        <div
          className={`progress ${task.progress == null ? "indeterminate" : ""}`}
          role="progressbar"
          aria-label="视频生成中"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={task.progress ?? undefined}
        >
          <div style={task.progress == null ? undefined : { width: `${task.progress}%` }} />
        </div>
      ) : null}

      {task.outputPath ? (
        <div className="video-output">
          <VideoPreview path={task.outputPath} />
          <div className="gen-output-actions">
            <button className="secondary sm" onClick={() => void window.upscaler.reveal(task.outputPath!)}>
              打开位置
            </button>
          </div>
        </div>
      ) : null}

      {task.status === "failed" && task.error ? (
        <div className="job-error">
          <span>{task.error}</span>
          <div className="job-error-actions">
            {task.needsTopup ? (
              <button className="primary sm" onClick={() => void window.upscaler.openTopup()}>
                去充值
              </button>
            ) : null}
            <button className="secondary sm" onClick={() => void window.upscaler.retryVideoTask(task.id)}>
              {task.remoteJobId && !task.outputPath ? "恢复同步" : "重试"}
            </button>
          </div>
        </div>
      ) : null}

      {stoppedRemoteSync ? (
        <div className="job-error warn">
          <span>
            {task.message || "已停止本地同步，远端任务可能仍在处理或计费。可点击上方“同步远端任务”恢复状态。"}
          </span>
          <button className="secondary sm" onClick={() => void window.upscaler.resumeVideoTask(task.id)}>
            恢复同步
          </button>
        </div>
      ) : null}

      <div className="job-meta">
        {task.status === "running" && task.startedAt ? (
          <span>已用 {formatDuration(now - task.startedAt)}</span>
        ) : task.durationMs != null ? (
          <span>耗时 {formatDuration(task.durationMs)}</span>
        ) : null}
        {billingText ? <span>{billingText}</span> : null}
        {task.outputBytes != null ? <span>{formatBytes(task.outputBytes)}</span> : null}
        {task.remoteJobId ? <span>任务 {task.remoteJobId}</span> : null}
        {copyNote ? <span>{copyNote}</span> : null}
        <button className="secondary sm" onClick={() => void copyDiagnostics()}>
          复制诊断
        </button>
        {active ? (
          <button className="secondary sm" onClick={() => void window.upscaler.cancelVideoTask(task.id)}>
            {task.remoteJobId ? "停止同步" : "取消"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function videoBillingText(task: VideoGenTask): string | null {
  if (task.refunded) {
    return task.costUsd != null ? `已退款 ${formatUsd(task.costUsd)}` : "已退款";
  }
  if (task.costUsd != null) return `实际 ${formatUsd(task.costUsd)}`;
  if (task.charged) return "已扣费";
  if (task.estimatedCostUsd != null) return `预估 ${formatUsd(task.estimatedCostUsd)}`;
  return null;
}

function VideoPreview({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.upscaler.getMediaUrl(path).then((value) => {
      if (alive) setUrl(value);
    });
    return () => {
      alive = false;
    };
  }, [path]);
  return (
    <div className="video-preview">
      {url ? <video src={url} controls preload="metadata" /> : <span>正在加载视频预览</span>}
    </div>
  );
}

type AssetItem =
  | { kind: "upscale"; path: string; createdAt: number; job: UpscaleJob }
  | { kind: "image"; path: string; createdAt: number; bytes: number }
  | { kind: "video"; path: string; createdAt: number; bytes: number };

function AssetsModule({
  jobs,
  imageTasks,
  videoTasks,
  onCompare,
  onUpscale
}: {
  jobs: UpscaleJob[];
  imageTasks: ImageGenTask[];
  videoTasks: VideoGenTask[];
  onCompare: (job: UpscaleJob) => void;
  onUpscale: (path: string) => void;
}) {
  const items = useMemo<AssetItem[]>(() => {
    const fromJobs = jobs
      .filter((job) => job.status === "succeeded" && job.outputPath)
      .map((job) => ({ kind: "upscale" as const, path: job.outputPath!, createdAt: job.createdAt, job }));
    const fromImages = imageTasks
      .filter((task) => task.status === "succeeded")
      .flatMap((task) =>
        task.outputPaths.map((path, index) => ({
          kind: "image" as const,
          path,
          createdAt: task.createdAt + index,
          bytes: task.outputSizes[index] ?? 0
        }))
      );
    const fromVideos = videoTasks
      .filter((task) => task.status === "succeeded" && task.outputPath)
      .map((task) => ({
        kind: "video" as const,
        path: task.outputPath!,
        createdAt: task.createdAt,
        bytes: task.outputBytes ?? 0
      }));
    return [...fromJobs, ...fromImages, ...fromVideos].sort((a, b) => b.createdAt - a.createdAt);
  }, [jobs, imageTasks, videoTasks]);

  return (
    <>
      <div className="module-head">
        <div>
          <h1>资产库</h1>
          <p>集中查看图片、视频和超分结果</p>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="panel empty">还没有产出。跑一次超分、生图或视频，结果会出现在这里。</div>
      ) : (
        <div className="asset-grid">
          {items.map((item) => (
            <div className="asset-card" key={`${item.kind}-${item.path}`}>
              {item.kind === "video" ? (
                <VideoPreview path={item.path} />
              ) : (
                <Thumb path={item.path} max={320} className="thumb-asset" />
              )}
              <span className="asset-name">{basename(item.path)}</span>
              <div className="asset-meta">
                <span className="kind-tag">
                  {item.kind === "upscale" ? "超分" : item.kind === "image" ? "生图" : "视频"}
                </span>
                {item.kind === "upscale" && item.job.targetDimensions ? (
                  <span>
                    {item.job.targetDimensions.width}×{item.job.targetDimensions.height}
                  </span>
                ) : null}
                {item.kind === "upscale" && item.job.outputBytes != null ? (
                  <span>{formatBytes(item.job.outputBytes)}</span>
                ) : null}
                {item.kind === "image" && item.bytes > 0 ? <span>{formatBytes(item.bytes)}</span> : null}
                {item.kind === "video" && item.bytes > 0 ? <span>{formatBytes(item.bytes)}</span> : null}
              </div>
              <div className="asset-actions">
                {item.kind === "video" ? null : item.kind === "upscale" ? (
                  <button className="secondary sm" onClick={() => onCompare(item.job)}>
                    对比
                  </button>
                ) : (
                  <button className="secondary sm" onClick={() => onUpscale(item.path)}>
                    超分到 4K
                  </button>
                )}
                <button className="secondary sm" onClick={() => void window.upscaler.reveal(item.path)}>
                  打开位置
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function ModelSetupCard({
  status,
  selectedFileName,
  onDownload,
  onUse,
  onCancel
}: {
  status: UpscaleModelStatus;
  selectedFileName: string;
  onDownload: (fileName: string) => void;
  onUse: (fileName: string) => void;
  onCancel: () => void;
}) {
  const download = status.download;
  const busy = download.phase === "downloading" || download.phase === "verifying";
  const percent =
    download.totalBytes > 0 ? Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100)) : 0;

  return (
    <section className="panel model-setup">
      <h2>选择并下载超分模型</h2>
      <p className="hw-hint">
        首次使用需要下载 AI 模型（各约 64MB）。模型为开源权重，由你自行下载到本机使用，下载后自动校验完整性。
        商用场景请选择可商用授权的模型。
      </p>
      <div className="model-options">
        {status.models.map((model) => {
          const isDownloadingThis = busy && download.fileName === model.fileName;
          const isSelected = selectedFileName === model.fileName;
          return (
            <div className={`model-option ${isSelected ? "on" : ""}`} key={model.fileName}>
              <div className="model-option-head">
                <strong>{model.displayName}</strong>
                <span className={`pill ${model.commercial ? "succeeded" : "cancelled"}`}>
                  {model.commercial ? "可商用" : "仅限非商业"}
                </span>
              </div>
              <span className="model-option-meta">
                {model.tagline} · {formatBytes(model.sizeBytes)} · {model.license}
              </span>
              {isDownloadingThis ? (
                <>
                  <div
                    className="progress"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={percent}
                    aria-label={`${model.displayName} 下载进度`}
                  >
                    <div style={{ width: `${percent}%` }} />
                  </div>
                  <div className="model-setup-row">
                    <span className="hw-hint">
                      {download.phase === "verifying"
                        ? "正在校验文件完整性…"
                        : `${formatBytes(download.receivedBytes)} / ${formatBytes(download.totalBytes)}（${percent}%）`}
                    </span>
                    {download.phase === "downloading" ? (
                      <button className="secondary sm" onClick={onCancel}>
                        取消
                      </button>
                    ) : null}
                  </div>
                </>
              ) : (
                <div className="model-setup-row">
                  {model.installed ? (
                    isSelected ? (
                      <span className="key-status ok">已安装 · 使用中</span>
                    ) : (
                      <button className="secondary sm" onClick={() => onUse(model.fileName)}>
                        使用此模型
                      </button>
                    )
                  ) : (
                    <button className="primary sm" disabled={busy} onClick={() => onDownload(model.fileName)}>
                      {download.phase === "failed" && download.fileName === model.fileName ? "重试下载" : "下载"}
                    </button>
                  )}
                  {!model.installed && isSelected ? <span className="hint-warn">当前选用，需先下载</span> : null}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {download.message && !busy ? <span className="hint-warn">{download.message}</span> : null}
    </section>
  );
}

function PendingList({ paths, onRemove }: { paths: string[]; onRemove: (path: string) => void }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>待处理图片</h2>
        <span className="count-badge">{paths.length}</span>
      </div>
      <div className="pending-list">
        {paths.map((path) => (
          <div className="pending-item" key={path}>
            <Thumb path={path} />
            <span>{basename(path)}</span>
            <button className="icon-button" aria-label={`移除 ${basename(path)}`} onClick={() => onRemove(path)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function JobList({
  jobs,
  now,
  onCompare,
  onRetry
}: {
  jobs: UpscaleJob[];
  now: number;
  onCompare: (job: UpscaleJob) => void;
  onRetry: (job: UpscaleJob) => void;
}) {
  const hasFinished = jobs.some(
    (job) => job.status === "succeeded" || job.status === "failed" || job.status === "cancelled"
  );

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>
          任务记录 <span className="count-badge">{jobs.length}</span>
        </h2>
        {hasFinished ? (
          <button className="link-button" onClick={() => void window.upscaler.clearFinished()}>
            清空已结束
          </button>
        ) : null}
      </div>
      {jobs.length === 0 ? (
        <div className="empty">还没有任务，拖入图片开始处理。</div>
      ) : (
        <div className="job-list">
          {jobs.map((job) => (
            <JobCard key={job.id} job={job} now={now} onCompare={onCompare} onRetry={onRetry} />
          ))}
        </div>
      )}
    </section>
  );
}

function JobCard({
  job,
  now,
  onCompare,
  onRetry
}: {
  job: UpscaleJob;
  now: number;
  onCompare: (job: UpscaleJob) => void;
  onRetry: (job: UpscaleJob) => void;
}) {
  const active = job.status === "running" || job.status === "queued";

  return (
    <article className={`job ${job.status}`}>
      <div className="job-head">
        <Thumb path={job.inputPath} />
        <div className="job-title">
          <h3>{job.fileName}</h3>
          {active ? <p>{job.message}</p> : null}
        </div>
        <span className={`pill ${job.status}`}>
          {statusText(job.status)}
          {job.status === "running" ? ` ${job.progress}%` : ""}
        </span>
      </div>

      {active ? (
        <div
          className={`progress ${job.status}`}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={job.progress}
          aria-label={`${job.fileName} 处理进度`}
        >
          <div style={{ width: `${job.progress}%` }} />
        </div>
      ) : null}

      <div className="job-meta">
        <span>{processingModeLabel(job.settings.processingMode)}</span>
        <span>
          {job.dimensions ? `${job.dimensions.width}×${job.dimensions.height}` : "尺寸待读取"}
          {" → "}
          {job.targetDimensions ? `${job.targetDimensions.width}×${job.targetDimensions.height}` : "待计算"}
        </span>
        <span>{durationText(job, now)}</span>
        {job.outputBytes != null ? <span>{formatBytes(job.outputBytes)}</span> : null}
      </div>

      {job.status === "failed" && job.error ? (
        <div className="job-error">
          <span>{job.error}</span>
          <button className="secondary sm" onClick={() => onRetry(job)}>
            重试
          </button>
        </div>
      ) : null}

      <div className="job-actions">
        {active ? (
          <button className="secondary sm" onClick={() => void window.upscaler.cancelJob(job.id)}>
            取消
          </button>
        ) : null}
        {job.outputPath && job.status === "succeeded" ? (
          <>
            <button className="secondary sm" onClick={() => onCompare(job)}>
              对比
            </button>
            <button className="secondary sm" onClick={() => void window.upscaler.reveal(job.outputPath!)}>
              打开位置
            </button>
          </>
        ) : null}
        {!active ? (
          <button
            className="secondary sm job-delete"
            title="删除这条记录（不会删除已输出的图片文件）"
            onClick={() => void window.upscaler.removeJob(job.id)}
          >
            删除
          </button>
        ) : null}
      </div>
    </article>
  );
}

function modelLicense(model: string): { text: string; warn: boolean } {
  const name = model.toLowerCase();
  if (name.includes("ultrasharp")) return { text: "CC-BY-NC-SA 4.0 · 仅限非商业", warn: true };
  if (name.includes("realesrgan")) return { text: "BSD 3-Clause · 可商用", warn: false };
  return { text: "授权未知 · 商用前请自行确认", warn: true };
}

/** 弹窗通用：按 Esc 关闭。 */
function useEscapeToClose(onClose: () => void) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

function AboutModal({
  info,
  hardware,
  onClose
}: {
  info: AppInfo | null;
  hardware: HardwareReport | null;
  onClose: () => void;
}) {
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [videoDiag, setVideoDiag] = useState<VideoGatewayDiagnostics | null>(null);
  const [videoDiagLoading, setVideoDiagLoading] = useState(false);
  useEscapeToClose(onClose);

  async function handleExport() {
    const saved = await window.upscaler.exportLogs();
    setExportNote(saved ? `已导出到：${saved}` : "已取消导出");
  }

  async function handleVideoDiagnostics() {
    setVideoDiagLoading(true);
    try {
      setVideoDiag(await window.upscaler.getVideoGatewayDiagnostics());
    } finally {
      setVideoDiagLoading(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>关于 RiverMoon AI 创作台</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="modal-body">
          <dl className="kv">
            <div>
              <dt>版本</dt>
              <dd>{info?.version ?? "—"}</dd>
            </div>
            <div>
              <dt>Electron</dt>
              <dd>{info?.electron ?? "—"}</dd>
            </div>
            <div>
              <dt>AI 引擎</dt>
              <dd>{info?.comfyuiRuntimePath ? basename(info.comfyuiRuntimePath) : "未找到"}</dd>
            </div>
            <div>
              <dt>资源目录</dt>
              <dd className="mono">{info?.resourcesRoot ?? "—"}</dd>
            </div>
          </dl>

          <div className="about-section">
            <h3>本地超分模型与授权</h3>
            {(info?.comfyuiModels ?? []).length === 0 ? (
              <p className="hw-hint">未检测到模型。</p>
            ) : (
              (info?.comfyuiModels ?? []).map((model) => {
                const license = modelLicense(model);
                return (
                  <p key={model} className={license.warn ? "about-license warn" : "about-license"}>
                    <strong>{model}</strong> · {license.text}
                  </p>
                );
              })
            )}
            <p className="hw-hint">
              安装包不包含模型权重，模型由用户在应用内自行下载使用。4x-UltraSharp 为非商业授权（CC-BY-NC-SA
              4.0），商用请自行确认或替换为可商用模型。
            </p>
          </div>

          {hardware ? (
            <div className="about-section">
              <h3>硬件</h3>
              <p className="hw-hint">
                {hardware.ok ? "兼容性自检通过" : "兼容性自检未通过"}
                {hardware.cudaDevices.length > 0 ? ` · ${hardware.cudaDevices.join("、")}` : ""}
              </p>
            </div>
          ) : null}

          <div className="about-section">
            <h3>诊断</h3>
            <div className="modal-footer">
              <button className="secondary" onClick={() => void handleExport()}>
                导出诊断日志
              </button>
              <button className="secondary" disabled={videoDiagLoading} onClick={() => void handleVideoDiagnostics()}>
                {videoDiagLoading ? "检测中…" : "检测视频网关"}
              </button>
              <button className="secondary" onClick={() => void window.upscaler.revealLogs()}>
                打开日志目录
              </button>
            </div>
            {exportNote ? <p className="hw-hint">{exportNote}</p> : null}
            {videoDiag ? (
              <p className={videoDiag.https.ok ? "hw-hint" : "hint-warn"}>{videoGatewaySummary(videoDiag)}</p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function videoGatewaySummary(report: VideoGatewayDiagnostics): string {
  const dnsText = report.dnsAddresses.length > 0 ? report.dnsAddresses.join("、") : "DNS 未解析";
  const httpsText = report.https.ok
    ? `HTTPS 正常，${report.https.modelCount ?? 0} 个模型，${report.https.durationMs}ms`
    : `HTTPS 异常：${report.https.error || report.https.status || "未知错误"}`;
  const fallbackText = report.httpFallback.ok
    ? `公开 HTTP fallback 可用，${report.httpFallback.durationMs}ms`
    : "公开 HTTP fallback 不可用";
  return `${httpsText}；${fallbackText}；DNS：${dnsText}`;
}

function CompareModal({ job, onClose }: { job: UpscaleJob; onClose: () => void }) {
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [position, setPosition] = useState(50);
  // zoom 与 pan 合并成一个状态：所有变换都走函数式更新，原生 wheel 监听器不会闭包过期。
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [failed, setFailed] = useState(false);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const wheelCleanup = useRef<(() => void) | null>(null);
  const panDrag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const dividerDrag = useRef(false);
  useEscapeToClose(onClose);

  useEffect(() => {
    let active = true;
    void (async () => {
      // 对比弹窗走高清预览通道（4096 + q92），避免弹窗里的画质低于输出文件本身。
      const [inputPreview, outputPreview] = await Promise.all([
        loadPreview(job.inputPath, 4096, 92),
        job.outputPath ? loadPreview(job.outputPath, 4096, 92) : Promise.resolve(null)
      ]);
      if (!active) return;
      setBefore(inputPreview);
      setAfter(outputPreview);
      if (!inputPreview || !outputPreview) setFailed(true);
    })();
    return () => {
      active = false;
    };
  }, [job.inputPath, job.outputPath]);

  /** 以视口内 (cx, cy)（相对中心）为锚点做乘法缩放：锚点下的画面内容在缩放前后保持不动。 */
  const zoomBy = useCallback((factor: number, cx: number, cy: number) => {
    const el = viewRef.current;
    setView((current) => {
      const next = clampNumber(Number((current.zoom * factor).toFixed(3)), 1, 8);
      if (next === current.zoom) return current;
      if (next === 1) return { zoom: 1, x: 0, y: 0 };
      const limitX = el ? (el.clientWidth * next) / 2 : Infinity;
      const limitY = el ? (el.clientHeight * next) / 2 : Infinity;
      return {
        zoom: next,
        x: clampNumber(cx - ((cx - current.x) / current.zoom) * next, -limitX, limitX),
        y: clampNumber(cy - ((cy - current.y) / current.zoom) * next, -limitY, limitY)
      };
    });
  }, []);

  // React 17+ 的 onWheel 是被动监听、preventDefault 无效；
  // 用 callback ref 在元素挂载/卸载时挂原生非被动监听器。
  const setViewEl = useCallback(
    (node: HTMLDivElement | null) => {
      wheelCleanup.current?.();
      wheelCleanup.current = null;
      viewRef.current = node;
      if (!node) return;
      const onWheel = (event: WheelEvent) => {
        event.preventDefault();
        const rect = node.getBoundingClientRect();
        // 指数映射：触控板的小 delta 连续平滑，鼠标滚轮一格（±100）约 1.22 倍。
        const factor = Math.exp(-event.deltaY * 0.002);
        zoomBy(factor, event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
      };
      node.addEventListener("wheel", onWheel, { passive: false });
      wheelCleanup.current = () => node.removeEventListener("wheel", onWheel);
    },
    [zoomBy]
  );

  function resetView() {
    setView({ zoom: 1, x: 0, y: 0 });
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (view.zoom <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panDrag.current = { x: event.clientX, y: event.clientY, panX: view.x, panY: view.y };
    setIsPanning(true);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = panDrag.current;
    if (!drag) return;
    const width = event.currentTarget.clientWidth;
    const height = event.currentTarget.clientHeight;
    const clientX = event.clientX;
    const clientY = event.clientY;
    setView((current) => {
      const limitX = (width * current.zoom) / 2;
      const limitY = (height * current.zoom) / 2;
      return {
        ...current,
        x: clampNumber(drag.panX + clientX - drag.x, -limitX, limitX),
        y: clampNumber(drag.panY + clientY - drag.y, -limitY, limitY)
      };
    });
  }

  function handlePointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (panDrag.current) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released by the browser.
      }
    }
    panDrag.current = null;
    setIsPanning(false);
  }

  function handleDividerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dividerDrag.current = true;
  }

  function handleDividerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dividerDrag.current) return;
    const view = viewRef.current;
    if (!view) return;
    const rect = view.getBoundingClientRect();
    setPosition(clampNumber(((event.clientX - rect.left) / rect.width) * 100, 0, 100));
  }

  function handleDividerEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (dividerDrag.current) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released by the browser.
      }
    }
    dividerDrag.current = false;
  }

  const ready = Boolean(before && after);
  const layerStyle = {
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
    // 滚轮缩放用短过渡平滑档位跳变；拖动画面时关掉过渡避免拖尾。
    transition: isPanning ? "none" : "transform 90ms ease-out"
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal compare-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>前后对比 · {job.fileName}</h2>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </div>
        {failed ? (
          <div className="empty">无法加载预览图，原图或输出文件可能已被移动。</div>
        ) : !ready ? (
          <div className="empty">正在加载预览…</div>
        ) : (
          <div className="modal-body">
            <div className="compare-toolbar">
              <button className="secondary sm" aria-label="缩小" onClick={() => zoomBy(1 / 1.3, 0, 0)}>
                −
              </button>
              <span>{Math.round(view.zoom * 100)}%</span>
              <button className="secondary sm" aria-label="放大" onClick={() => zoomBy(1.3, 0, 0)}>
                +
              </button>
              <button className="secondary sm" onClick={resetView}>
                重置
              </button>
            </div>
            <div
              ref={setViewEl}
              className={`compare ${view.zoom > 1 ? "zoomed" : ""}`}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerEnd}
              onPointerCancel={handlePointerEnd}
            >
              <div className="compare-layer" style={layerStyle}>
                <img className="compare-img" src={after ?? ""} alt="处理后" />
                <img
                  className="compare-img compare-top"
                  src={before ?? ""}
                  alt="处理前"
                  style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
                />
              </div>
              <div className="compare-divider" style={{ left: `${position}%` }} />
              <div
                className="compare-handle"
                style={{ left: `${position}%` }}
                role="slider"
                aria-label="对比分割线"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(position)}
                onPointerDown={handleDividerDown}
                onPointerMove={handleDividerMove}
                onPointerUp={handleDividerEnd}
                onPointerCancel={handleDividerEnd}
              />
              <span className="compare-tag left">处理前</span>
              <span className="compare-tag right">处理后</span>
            </div>
            <input
              className="compare-range"
              type="range"
              min={0}
              max={100}
              value={position}
              aria-label="对比位置"
              onChange={(event) => setPosition(Number(event.target.value))}
            />
            <p className="hw-hint">
              拖动分割线或滑块对比，滚轮以鼠标为中心缩放，放大后拖动画面 ·{" "}
              {job.dimensions ? `${job.dimensions.width}×${job.dimensions.height}` : "?"} →{" "}
              {job.targetDimensions ? `${job.targetDimensions.width}×${job.targetDimensions.height}` : "?"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── 预览加载基础设施 ──────────────────────────────────────────
// 并发限流（避免大文件夹下数千张图同时 IPC→sharp 解码打爆主进程）
// + 内存 LRU 缓存（重复打开/对比同一张图时 0 解码）。
const PREVIEW_CONCURRENCY = 4;
const PREVIEW_CACHE_MAX = 200;

const previewCache = new Map<string, string>();
let previewActive = 0;
const previewWaiters: Array<() => void> = [];

function acquirePreviewSlot(): Promise<void> {
  if (previewActive < PREVIEW_CONCURRENCY) {
    previewActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => previewWaiters.push(resolve));
}

function releasePreviewSlot(): void {
  const next = previewWaiters.shift();
  if (next) {
    next(); // 槽位直接交棒给等待者，previewActive 维持不变
  } else {
    previewActive -= 1;
  }
}

/** 经限流 + 缓存加载预览；失败（null）不缓存以便后续重试。 */
async function loadPreview(path: string, maxSide: number, quality = 80): Promise<string | null> {
  const key = `${path}:${maxSide}:${quality}`;
  const cached = previewCache.get(key);
  if (cached !== undefined) {
    previewCache.delete(key);
    previewCache.set(key, cached); // 命中后挪到末尾（最近使用）
    return cached;
  }
  await acquirePreviewSlot();
  try {
    const url = await window.upscaler.getPreview(path, maxSide, quality);
    if (url !== null) {
      previewCache.set(key, url);
      if (previewCache.size > PREVIEW_CACHE_MAX) {
        const oldest = previewCache.keys().next().value;
        if (oldest !== undefined) previewCache.delete(oldest);
      }
    }
    return url;
  } finally {
    releasePreviewSlot();
  }
}

/** 元素进入视口（含 200px 提前量）时返回 true，且只触发一次。 */
function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, inView];
}

function Thumb({ path, max = 120, className }: { path: string; max?: number; className?: string }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!inView) return;
    let active = true;
    void loadPreview(path, max).then((url) => {
      if (active) setSrc(url);
    });
    return () => {
      active = false;
    };
  }, [path, max, inView]);

  return (
    <div className={`thumb ${className ?? ""}`} ref={ref}>
      {src ? <img src={src} alt="" /> : null}
    </div>
  );
}

function BrandMark({ size = 24, framed = false }: { size?: number; framed?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 256 256" fill="none" aria-hidden="true">
      {framed ? (
        <rect x="36" y="36" width="184" height="184" rx="46" fill="none" stroke="currentColor" strokeWidth="14" />
      ) : null}
      <g stroke="currentColor" strokeWidth={framed ? 17 : 22} strokeLinecap="round" strokeLinejoin="round">
        <path d="M110 146 L146 110" />
        <path d="M146 110 H126 M146 110 V130" />
        <path d="M110 146 H130 M110 146 V126" />
      </g>
    </svg>
  );
}

function basename(filePath: string) {
  return filePath.split(/[\\/]/).pop() || filePath;
}

function isStoppedRemoteSyncTask(task: VideoGenTask): boolean {
  return task.status === "cancelled" && Boolean(task.remoteJobId) && !task.outputPath;
}

function isRecoverableRemoteVideoTask(task: VideoGenTask): boolean {
  if (!task.remoteJobId || task.outputPath) return false;
  if (task.status === "cancelled") return true;
  return task.status === "failed" && Boolean(task.downloadUrl || task.contentUrl);
}

function isClearableFinishedVideoTask(task: VideoGenTask): boolean {
  if (isRecoverableRemoteVideoTask(task)) return false;
  return (
    task.status === "succeeded" || task.status === "failed" || task.status === "cancelled" || task.status === "expired"
  );
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function statusText(status: UpscaleJob["status"]) {
  switch (status) {
    case "queued":
      return "等待中";
    case "running":
      return "处理中";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
  }
}

function formatDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatUsd(value: number): string {
  const maximumFractionDigits = value > 0 && value < 0.1 ? 4 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits
  }).format(value);
}

function processingModeLabel(mode: ProcessingMode): string {
  if (mode === "webClear") return "网页增强";
  if (mode === "aiUpscaleWebClear") return "AI+增强";
  return "AI 超分";
}

function durationText(job: UpscaleJob, now: number): string {
  if (job.status === "queued") return "等待计时";
  const duration =
    job.status === "running" && job.startedAt
      ? now - job.startedAt
      : typeof job.durationMs === "number"
        ? job.durationMs
        : job.startedAt && job.finishedAt
          ? job.finishedAt - job.startedAt
          : null;
  if (duration == null) return "未计时";
  if (job.status === "cancelled" && duration === 0) return "—";
  const prefix = job.status === "running" ? "已用" : "耗时";
  return `${prefix} ${formatDuration(duration)}`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes.toString().padStart(2, "0")}分${seconds.toString().padStart(2, "0")}秒`;
  if (minutes > 0) return `${minutes}分${seconds.toString().padStart(2, "0")}秒`;
  return `${seconds}秒`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/** 顶层错误边界：任一渲染异常时显示可读回退页，而非整屏白。 */
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("UI 渲染异常", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <h2>界面出错了</h2>
          <p>请重启应用。若反复出现，可在日志目录导出诊断信息反馈。</p>
          <pre>{this.state.error.message}</pre>
          <button className="secondary" onClick={() => void window.upscaler.revealLogs()}>
            打开日志目录
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
