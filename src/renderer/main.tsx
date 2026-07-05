import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_SETTINGS } from "../main/settings";
import type {
  AccountStatus,
  AppInfo,
  AssetStatus,
  HardwareReport,
  ImageFormat,
  ImageGenTask,
  UpscaleJob,
  UpscaleModelStatus,
  UpscaleSettings
} from "../main/types";
import "./styles.css";

type ModuleId = "upscale" | "imagegen" | "assets" | "settings";

const NAV_ITEMS: Array<{ id: ModuleId; label: string; badge?: string }> = [
  { id: "upscale", label: "图片超分", badge: "免费" },
  { id: "imagegen", label: "AI 生图" },
  { id: "assets", label: "资产库" },
  { id: "settings", label: "设置" }
];

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
  const [module, setModule] = useState<ModuleId>("upscale");
  const [account, setAccount] = useState<AccountStatus | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [imageTasks, setImageTasks] = useState<ImageGenTask[]>([]);
  const [modelStatus, setModelStatus] = useState<UpscaleModelStatus | null>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    void init();
    const unsubscribeJobs = window.upscaler.onJobsUpdated(setJobs);
    const unsubscribeImages = window.upscaler.onImageTasksUpdated(setImageTasks);
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
      unsubscribeModel();
    };
    // init 只应在挂载时执行一次，依赖数组刻意留空。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 生图任务到达终态后刷新余额（主进程已把账户缓存失效，这里只需重取）。
  const finishedImageCount = imageTasks.filter(
    (task) => task.status === "succeeded" || task.status === "failed" || task.status === "cancelled"
  ).length;
  useEffect(() => {
    if (finishedImageCount === 0) return;
    const timer = setTimeout(() => void window.upscaler.getAccountStatus().then(setAccount), 1200);
    return () => clearTimeout(timer);
  }, [finishedImageCount]);

  // 窗口重新聚焦时刷新资源与任务状态，替代旧的手动“刷新状态”按钮。
  useEffect(() => {
    const onFocus = () => void refresh();
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
      jobs.some((job) => job.status === "running") || imageTasks.some((task) => task.status === "running");
    if (!hasRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [jobs, imageTasks]);

  async function init() {
    const [assets, saved, currentJobs, info, currentImageTasks, currentModel] = await Promise.all([
      window.upscaler.getAssetStatus(),
      window.upscaler.getSettings(),
      window.upscaler.listJobs(),
      window.upscaler.getAppInfo(),
      window.upscaler.listImageTasks(),
      window.upscaler.getModelStatus()
    ]);
    setAssetStatus(assets);
    setJobs(currentJobs);
    setImageTasks(currentImageTasks);
    setModelStatus(currentModel);
    setAppInfo(info);
    setSettings(saved);
    setSettingsLoaded(true);
    // 启动即自动自检（命中缓存时瞬时返回），用户不再需要自己发现“检测”按钮。
    void probeHardware(false);
    // 账户状态并行加载，不阻塞首屏。
    void window.upscaler.getAccountStatus().then(setAccount);
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

  /** 「超分到 4K」联动：云端产物直接进本地超分队列并切到超分模块。 */
  function upscaleImage(path: string) {
    void window.upscaler.startJobs({ paths: [path], settings });
    setModule("upscale");
  }

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
    addPending(files);
    // 在任何模块拖入图片都视为想要超分，自动切过去。
    setModule("upscale");
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
  const chainReady = Boolean(chainStatus?.ok);
  const hasContent = pendingPaths.length > 0 || jobs.length > 0;

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
          <span>RiverMoon</span>
        </div>
        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${module === item.id ? "on" : ""}`}
              onClick={() => setModule(item.id)}
            >
              {item.label}
              {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <AccountCard
          account={account}
          onTopup={() => void window.upscaler.openTopup()}
          onGoSettings={() => setModule("settings")}
        />
      </aside>

      <section className="content">
        {module === "upscale" ? (
          <>
            <div className="module-head">
              <div>
                <h1>图片超分</h1>
                <p>本地 AI 高清放大，图片不离开这台电脑 · 永久免费</p>
              </div>
              <StatusPill
                assetStatus={assetStatus}
                hardware={hardware}
                loading={hardwareLoading}
                counts={counts}
                onRetest={() => void probeHardware(true)}
              />
            </div>
            <div className="workspace">
        <section className="left">
          {modelStatus && !modelStatus.installed ? (
            <ModelSetupCard
              status={modelStatus}
              onDownload={() => void window.upscaler.downloadModel()}
              onCancel={() => void window.upscaler.cancelModelDownload()}
            />
          ) : null}
          {modelStatus?.installed === false ? null : hasContent ? (
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
                <p className="hint-warn">当前无法开始，缺少：{chainStatus?.missing.join("、") || "必需资源"}</p>
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
              onChange={setSettings}
              onSelectOutputDirectory={() => void selectOutputDirectory()}
            />
          ) : null}
        </aside>
      </div>
          </>
        ) : null}

        {module === "imagegen" ? (
          <ImageGenModule
            account={account}
            tasks={imageTasks}
            now={now}
            onGoSettings={() => setModule("settings")}
            onUpscale={upscaleImage}
          />
        ) : null}
        {module === "assets" ? (
          <AssetsModule jobs={jobs} imageTasks={imageTasks} onCompare={setCompareJob} onUpscale={upscaleImage} />
        ) : null}
        {module === "settings" ? (
          <SettingsModule
            account={account}
            busy={accountBusy}
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
  onRetest
}: {
  assetStatus: AssetStatus | null;
  hardware: HardwareReport | null;
  loading: boolean;
  counts: Record<UpscaleJob["status"], number>;
  onRetest: () => void;
}) {
  const [open, setOpen] = useState(false);

  const assetsReady = Boolean(assetStatus?.qualityModes.standard.ok);
  const checking = loading && !hardware;
  const state: "busy" | "ok" | "warn" = checking
    ? "busy"
    : !assetsReady || (hardware != null && !hardware.ok)
      ? "warn"
      : hardware?.ok
        ? "ok"
        : "busy";
  const label = checking
    ? "检测中…"
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
                <dd>{assetsReady ? "完整" : `缺少 ${assetStatus?.missing.join("、") || "必需资源"}`}</dd>
              </div>
              <div>
                <dt>CUDA</dt>
                <dd>
                  {hardware == null
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
  onChange,
  onSelectOutputDirectory
}: {
  settings: UpscaleSettings;
  status: AssetStatus | null;
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

  return (
    <section className="settings">
      <h2>超分设置</h2>

      <div className="chain-card">
        <strong>网站同款 AI</strong>
        <span>与 RiverMoon 网页版相同的处理效果，4x 模型放大</span>
      </div>

      {chainStatus && !chainStatus.ok ? (
        <p className="quality-warning">当前缺少：{chainStatus.missing.join("、")}</p>
      ) : null}

      <div className="field">
        <span className="field-label">输出格式</span>
        <div className="seg" role="radiogroup" aria-label="输出格式">
          {(["png", "jpg", "webp"] as ImageFormat[]).map((format) => (
            <button
              key={format}
              className={settings.outputFormat === format ? "on" : ""}
              onClick={() => onChange({ ...settings, outputFormat: format })}
            >
              {format === "png" ? "PNG" : format === "jpg" ? "JPEG" : "WebP"}
            </button>
          ))}
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
            <input type="radio" name="size-mode" checked={sizeMode === "custom"} onChange={() => selectMode("custom")} />
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
        <span className="account-label">账户</span>
        <p className="account-note">读取中…</p>
      </div>
    );
  }
  if (!account.connected) {
    return (
      <div className="account-card">
        <span className="account-label">账户</span>
        <p className="account-note">{account.error ?? "未连接中转站，生图功能需要 API Key"}</p>
        <button className="secondary sm" onClick={onGoSettings}>
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
  return (
    <div className="account-card">
      <span className="account-label">余额</span>
      <strong className="account-balance">{balanceText}</strong>
      <span className="account-note">
        {account.maskedKey} · 模型 {account.models.length} 个
      </span>
      <button className="primary sm" onClick={onTopup}>
        充值
      </button>
    </div>
  );
}

function SettingsModule({
  account,
  busy,
  onConnect,
  onClear,
  onShowAbout
}: {
  account: AccountStatus | null;
  busy: boolean;
  onConnect: (key: string) => void;
  onClear: () => void;
  onShowAbout: () => void;
}) {
  const [keyInput, setKeyInput] = useState("");
  const connected = Boolean(account?.connected);

  return (
    <>
      <div className="module-head">
        <div>
          <h1>设置</h1>
          <p>账户与应用信息</p>
        </div>
      </div>
      <section className="panel settings-page">
        <h2>中转站账户</h2>
        <p className="hw-hint">
          在 rivermoon7.com 获取 API Key 后粘贴连接。AI 生图会把提示词发送到中转站处理；本地超分不上传任何图片。
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
        <h2>关于</h2>
        <p className="hw-hint">版本信息、内置模型授权与诊断日志导出。</p>
        <div>
          <button className="secondary" onClick={onShowAbout}>
            打开关于面板
          </button>
        </div>
      </section>
    </>
  );
}

const IMAGE_SIZE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "1024x1024", label: "方形 1024" },
  { value: "1536x1024", label: "横版 1536×1024" },
  { value: "1024x1536", label: "竖版 1024×1536" }
];

/** 从账户可用模型里挑出生图模型；没有匹配时全量展示（不同分组命名各异）。 */
function pickImageModels(models: string[]): string[] {
  const matched = models.filter((id) => /image|dall|flux|seedream|stable|sd3|cogview|wanx/i.test(id));
  return matched.length > 0 ? matched : models;
}

function ImageGenModule({
  account,
  tasks,
  now,
  onGoSettings,
  onUpscale
}: {
  account: AccountStatus | null;
  tasks: ImageGenTask[];
  now: number;
  onGoSettings: () => void;
  onUpscale: (path: string) => void;
}) {
  const models = useMemo(() => pickImageModels(account?.models ?? []), [account]);
  const [selectedModel, setSelectedModel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState(IMAGE_SIZE_OPTIONS[0]!.value);
  const [count, setCount] = useState(1);

  // 派生生效模型：所选模型不在列表里（换 Key/刷新）时自动落到第一个，无需同步 effect。
  const model = selectedModel && models.includes(selectedModel) ? selectedModel : (models[0] ?? "");

  const connected = Boolean(account?.connected);
  const canGenerate = connected && model.length > 0 && prompt.trim().length > 0;

  function generate() {
    if (!canGenerate) return;
    void window.upscaler.startImageTask({ model, prompt: prompt.trim(), size, count });
  }

  return (
    <>
      <div className="module-head">
        <div>
          <h1>AI 生图</h1>
          <p>云端模型生成图片，产物自动保存到本机资产库</p>
        </div>
        {connected ? <span className="key-status ok">模型 {models.length} 个可用</span> : null}
      </div>

      {!connected ? (
        <div className="panel empty">
          <p>连接 rivermoon7.com 账户后即可生成图片。</p>
          <button className="primary" onClick={onGoSettings}>
            去连接账户
          </button>
        </div>
      ) : (
        <>
          <section className="panel gen-controls">
            <div className="gen-row">
              <label>
                模型
                <select value={model} onChange={(event) => setSelectedModel(event.target.value)}>
                  {models.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                尺寸
                <select value={size} onChange={(event) => setSize(event.target.value)}>
                  {IMAGE_SIZE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
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
            </div>
            <div className="gen-prompt-row">
              <textarea
                rows={3}
                placeholder="描述你想要的画面，例如：一只鲸鱼漂浮在星空城市上方，水彩风格"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
              <button className="primary gen-btn" disabled={!canGenerate} onClick={generate}>
                生成
              </button>
            </div>
          </section>

          <ImageTaskList tasks={tasks} now={now} onUpscale={onUpscale} />
        </>
      )}
    </>
  );
}

function ImageTaskList({
  tasks,
  now,
  onUpscale
}: {
  tasks: ImageGenTask[];
  now: number;
  onUpscale: (path: string) => void;
}) {
  const hasFinished = tasks.some((task) => task.status !== "running" && task.status !== "queued");
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>
          生成记录 <span className="count-badge">{tasks.length}</span>
        </h2>
        {hasFinished ? (
          <button className="link-button" onClick={() => void window.upscaler.clearFinishedImageTasks()}>
            清空已结束
          </button>
        ) : null}
      </div>
      {tasks.length === 0 ? (
        <div className="empty">还没有生成记录，写一段提示词试试。</div>
      ) : (
        <div className="job-list">
          {tasks.map((task) => (
            <ImageTaskCard key={task.id} task={task} now={now} onUpscale={onUpscale} />
          ))}
        </div>
      )}
    </section>
  );
}

function ImageTaskCard({
  task,
  now,
  onUpscale
}: {
  task: ImageGenTask;
  now: number;
  onUpscale: (path: string) => void;
}) {
  const active = task.status === "running" || task.status === "queued";
  const promptPreview = task.params.prompt.length > 64 ? `${task.params.prompt.slice(0, 64)}…` : task.params.prompt;

  return (
    <article className={`job ${task.status}`}>
      <div className="job-head">
        <div className="job-title">
          <h3>{promptPreview}</h3>
          <p>
            {task.params.model} · {task.params.size.replace("x", "×")} · {task.params.count} 张
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
            <button className="secondary sm" onClick={() => void window.upscaler.startImageTask(task.params)}>
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
      </div>
    </article>
  );
}

type AssetItem =
  | { kind: "upscale"; path: string; createdAt: number; job: UpscaleJob }
  | { kind: "image"; path: string; createdAt: number; bytes: number };

function AssetsModule({
  jobs,
  imageTasks,
  onCompare,
  onUpscale
}: {
  jobs: UpscaleJob[];
  imageTasks: ImageGenTask[];
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
    return [...fromJobs, ...fromImages].sort((a, b) => b.createdAt - a.createdAt);
  }, [jobs, imageTasks]);

  return (
    <>
      <div className="module-head">
        <div>
          <h1>资产库</h1>
          <p>本机产出的所有图片：超分输出与云端生成</p>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="panel empty">还没有产出。跑一次超分或生图，结果会出现在这里。</div>
      ) : (
        <div className="asset-grid">
          {items.map((item) => (
            <div className="asset-card" key={`${item.kind}-${item.path}`}>
              <Thumb path={item.path} max={320} className="thumb-asset" />
              <span className="asset-name">{basename(item.path)}</span>
              <div className="asset-meta">
                <span className="kind-tag">{item.kind === "upscale" ? "超分" : "生图"}</span>
                {item.kind === "upscale" && item.job.targetDimensions ? (
                  <span>
                    {item.job.targetDimensions.width}×{item.job.targetDimensions.height}
                  </span>
                ) : null}
                {item.kind === "upscale" && item.job.outputBytes != null ? (
                  <span>{formatBytes(item.job.outputBytes)}</span>
                ) : null}
                {item.kind === "image" && item.bytes > 0 ? <span>{formatBytes(item.bytes)}</span> : null}
              </div>
              <div className="asset-actions">
                {item.kind === "upscale" ? (
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
  onDownload,
  onCancel
}: {
  status: UpscaleModelStatus;
  onDownload: () => void;
  onCancel: () => void;
}) {
  const download = status.download;
  const busy = download.phase === "downloading" || download.phase === "verifying";
  const percent = download.totalBytes > 0 ? Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100)) : 0;

  return (
    <section className="panel model-setup">
      <h2>下载超分模型</h2>
      <p className="hw-hint">
        首次使用需要下载 AI 模型 {status.fileName}（约 {formatBytes(status.sizeBytes)}）。模型为开源权重，
        由你自行下载到本机使用；授权：{status.license}。下载完成后自动校验完整性。
      </p>
      {busy ? (
        <>
          <div
            className="progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label="模型下载进度"
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
          <button className="primary" onClick={onDownload}>
            {download.phase === "failed" ? "重试下载" : "下载模型"}
          </button>
          {download.message ? <span className="hint-warn">{download.message}</span> : null}
        </div>
      )}
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
      </div>
    </article>
  );
}

function modelLicense(model: string): { text: string; warn: boolean } {
  const name = model.toLowerCase();
  if (name.includes("ultrasharp")) return { text: "CC-BY-NC-SA 4.0 · 仅限非商业", warn: true };
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
  useEscapeToClose(onClose);

  async function handleExport() {
    const saved = await window.upscaler.exportLogs();
    setExportNote(saved ? `已导出到：${saved}` : "已取消导出");
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>关于 RiverMoon 本地超分</h2>
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
            <h3>内置模型与授权</h3>
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
              <button className="secondary" onClick={() => void window.upscaler.revealLogs()}>
                打开日志目录
              </button>
            </div>
            {exportNote ? <p className="hw-hint">{exportNote}</p> : null}
          </div>
        </div>
      </div>
    </div>
  );
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
