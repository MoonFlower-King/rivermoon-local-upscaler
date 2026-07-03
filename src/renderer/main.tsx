import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { DEFAULT_SETTINGS } from "../main/settings";
import type { AppInfo, AssetStatus, HardwareReport, ImageFormat, UpscaleJob, UpscaleSettings } from "../main/types";
import "./styles.css";

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
  const dragDepth = useRef(0);

  useEffect(() => {
    void init();
    const unsubscribe = window.upscaler.onJobsUpdated(setJobs);
    return unsubscribe;
  }, []);

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
    const hasRunningJob = jobs.some((job) => job.status === "running");
    if (!hasRunningJob) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [jobs]);

  async function init() {
    const [assets, saved, currentJobs, info] = await Promise.all([
      window.upscaler.getAssetStatus(),
      window.upscaler.getSettings(),
      window.upscaler.listJobs(),
      window.upscaler.getAppInfo()
    ]);
    setAssetStatus(assets);
    setJobs(currentJobs);
    setAppInfo(info);
    setSettings(saved);
    setSettingsLoaded(true);
    // 启动即自动自检（命中缓存时瞬时返回），用户不再需要自己发现“检测”按钮。
    void probeHardware(false);
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
      className="app"
      onDragEnter={handleDragEnter}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={handleDragLeave}
      onDrop={(event) => void handleDrop(event)}
    >
      <header className="topbar">
        <div className="topbar-title">
          <span className="brand-mark">
            <BrandMark size={30} framed />
          </span>
          <div>
            <h1>RiverMoon 本地超分</h1>
            <p>本地 AI 高清放大，图片不离开这台电脑</p>
          </div>
        </div>
        <div className="topbar-actions">
          <StatusPill
            assetStatus={assetStatus}
            hardware={hardware}
            loading={hardwareLoading}
            counts={counts}
            onRetest={() => void probeHardware(true)}
          />
          <button className="secondary" onClick={() => setShowAbout(true)}>
            关于
          </button>
        </div>
      </header>

      <div className="workspace">
        <section className="left">
          {hasContent ? (
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
          <SettingsPanel
            settings={settings}
            settingsLoaded={settingsLoaded}
            status={assetStatus}
            onChange={setSettings}
            onSelectOutputDirectory={() => void selectOutputDirectory()}
          />
        </aside>
      </div>

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

function SettingsPanel({
  settings,
  settingsLoaded,
  status,
  onChange,
  onSelectOutputDirectory
}: {
  settings: UpscaleSettings;
  settingsLoaded: boolean;
  status: AssetStatus | null;
  onChange: (settings: UpscaleSettings) => void;
  onSelectOutputDirectory: () => void;
}) {
  type SizeMode = "web" | "full" | "custom";
  const deriveMode = (maxSide: number): SizeMode => (maxSide === 4096 ? "web" : maxSide === 0 ? "full" : "custom");
  const [sizeMode, setSizeMode] = useState<SizeMode>(deriveMode(settings.maxSide));
  const [customText, setCustomText] = useState(String(settings.maxSide || 8192));
  const lastCustom = useRef(settings.maxSide > 0 && settings.maxSide !== 4096 ? settings.maxSide : 8192);

  // 设置异步加载完成后按持久化值校准一次单选态。
  useEffect(() => {
    if (!settingsLoaded) return;
    setSizeMode(deriveMode(settings.maxSide));
    if (settings.maxSide > 0 && settings.maxSide !== 4096) {
      lastCustom.current = settings.maxSide;
      setCustomText(String(settings.maxSide));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsLoaded]);

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
              贴近网页版<small>长边不超过 4096</small>
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
              商用分发前请逐一确认模型授权；4x-UltraSharp 为非商业授权，需替换为可商用模型或取得授权。
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
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [failed, setFailed] = useState(false);
  const viewRef = useRef<HTMLDivElement>(null);
  const panDrag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const dividerDrag = useRef(false);
  // wheel 回调是原生监听器，用 ref 镜像最新值避免闭包过期。
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  zoomRef.current = zoom;
  panRef.current = pan;
  useEscapeToClose(onClose);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [inputPreview, outputPreview] = await Promise.all([
        loadPreview(job.inputPath, 2400),
        job.outputPath ? loadPreview(job.outputPath, 2400) : Promise.resolve(null)
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

  /** 以视口内 (cx, cy)（相对中心）为锚点缩放：锚点下的画面内容在缩放前后保持不动。 */
  function zoomAt(delta: number, cx: number, cy: number) {
    const current = zoomRef.current;
    const next = clampNumber(Number((current + delta).toFixed(2)), 1, 6);
    if (next === current) return;
    if (next === 1) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }
    const view = viewRef.current;
    const currentPan = panRef.current;
    const limitX = view ? (view.clientWidth * next) / 2 : Infinity;
    const limitY = view ? (view.clientHeight * next) / 2 : Infinity;
    setZoom(next);
    setPan({
      x: clampNumber(cx - ((cx - currentPan.x) / current) * next, -limitX, limitX),
      y: clampNumber(cy - ((cy - currentPan.y) / current) * next, -limitY, limitY)
    });
  }

  // React 17+ 的 onWheel 是被动监听、preventDefault 无效，必须挂原生非被动监听器。
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(
        event.deltaY < 0 ? 0.25 : -0.25,
        event.clientX - rect.left - rect.width / 2,
        event.clientY - rect.top - rect.height / 2
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed, before, after]);

  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (zoom <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    panDrag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = panDrag.current;
    if (!drag) return;
    const limitX = (event.currentTarget.clientWidth * zoom) / 2;
    const limitY = (event.currentTarget.clientHeight * zoom) / 2;
    setPan({
      x: clampNumber(drag.panX + event.clientX - drag.x, -limitX, limitX),
      y: clampNumber(drag.panY + event.clientY - drag.y, -limitY, limitY)
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
  const layerStyle = { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` };

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
              <button className="secondary sm" aria-label="缩小" onClick={() => zoomAt(-0.5, 0, 0)}>
                −
              </button>
              <span>{Math.round(zoom * 100)}%</span>
              <button className="secondary sm" aria-label="放大" onClick={() => zoomAt(0.5, 0, 0)}>
                +
              </button>
              <button className="secondary sm" onClick={resetView}>
                重置
              </button>
            </div>
            <div
              ref={viewRef}
              className={`compare ${zoom > 1 ? "zoomed" : ""}`}
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
async function loadPreview(path: string, maxSide: number): Promise<string | null> {
  const key = `${path}:${maxSide}`;
  const cached = previewCache.get(key);
  if (cached !== undefined) {
    previewCache.delete(key);
    previewCache.set(key, cached); // 命中后挪到末尾（最近使用）
    return cached;
  }
  await acquirePreviewSlot();
  try {
    const url = await window.upscaler.getPreview(path, maxSide);
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
