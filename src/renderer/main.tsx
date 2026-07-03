import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { AppInfo, AssetStatus, HardwareReport, ImageFormat, UpscaleJob, UpscaleSettings } from "../main/types";
import "./styles.css";

const DEFAULT_SETTINGS: UpscaleSettings = {
  outputFormat: "png",
  outputDirectory: null,
  maxSide: 4096
};

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

  useEffect(() => {
    void init();
    const unsubscribe = window.upscaler.onJobsUpdated(setJobs);
    return unsubscribe;
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
  }

  async function probeHardware(force = false) {
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
    const files = await window.upscaler.selectFiles();
    addPending(files);
  }

  async function addFolder() {
    const files = await window.upscaler.selectFolder();
    addPending(files);
  }

  async function selectOutputDirectory() {
    const directory = await window.upscaler.selectOutputDirectory();
    if (directory) setSettings((current) => ({ ...current, outputDirectory: directory }));
  }

  function addPending(paths: string[]) {
    setPendingPaths((current) => Array.from(new Set([...current, ...paths])));
  }

  async function start() {
    if (pendingPaths.length === 0) return;
    if (!selectedChainReady) return;
    // 设置已是精简后的合法值；主进程 startJobs 还会再 sanitize 一次。
    await window.upscaler.startJobs({ paths: pendingPaths, settings });
    setPendingPaths([]);
  }

  async function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    // Electron 32+ 不再提供 File.path，用 webUtils.getPathForFile 取真实路径。
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
  const selectedQualityStatus = assetStatus?.qualityModes.standard;
  const selectedChainReady = Boolean(selectedQualityStatus?.ok);
  const startDisabled = pendingPaths.length === 0 || !selectedChainReady;
  const startLabel =
    pendingPaths.length === 0
      ? "开始处理"
      : !selectedChainReady
        ? "当前档位资源缺失"
        : `开始处理 ${pendingPaths.length} 个任务`;

  return (
    <main className="app">
      <header className="topbar">
        <div className="topbar-title">
          <span className="brand-mark">
            <BrandMark size={32} framed />
          </span>
          <div>
            <h1>RiverMoon 本地超分</h1>
            <p>本地运行网站同款 CUDA 高清链路，拖入图片即可处理。</p>
          </div>
        </div>
        <div className="topbar-actions">
          <button className="secondary" onClick={() => setShowAbout(true)}>
            关于
          </button>
          <button className="secondary" onClick={() => void refresh()}>
            刷新状态
          </button>
        </div>
      </header>

      <div className="workspace">
        <section className="left">
          <div
            className={`dropzone ${isDragging ? "dragging" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => void handleDrop(event)}
          >
            <div className="drop-icon">
              <BrandMark size={30} />
            </div>
            <h2>把图片或文件夹拖到这里</h2>
            <p>支持 PNG、JPEG、WebP。选择文件夹时会自动递归扫描。</p>
            <div className="actions">
              <button onClick={() => void addFiles()}>添加图片</button>
              <button className="secondary" onClick={() => void addFolder()}>
                添加文件夹
              </button>
            </div>
          </div>

          <PendingList paths={pendingPaths} onRemove={(path) => setPendingPaths((items) => items.filter((item) => item !== path))} />

          <JobList jobs={jobs} now={now} onCompare={setCompareJob} />
        </section>

        <aside className="right">
          <StatusPanel
            assetStatus={assetStatus}
            hardware={hardware}
            hardwareLoading={hardwareLoading}
            counts={counts}
            onRetest={() => void probeHardware(true)}
          />
          <SettingsPanel
            settings={settings}
            status={assetStatus}
            hardware={hardware}
            onChange={setSettings}
            onSelectOutputDirectory={() => void selectOutputDirectory()}
          />
          <button className="primary start" disabled={startDisabled} onClick={() => void start()}>
            {startLabel}
          </button>
          <button className="secondary" onClick={() => void window.upscaler.clearFinished()}>
            清空已结束任务
          </button>
        </aside>
      </div>

      {showAbout ? <AboutModal info={appInfo} hardware={hardware} onClose={() => setShowAbout(false)} /> : null}
      {compareJob ? <CompareModal job={compareJob} onClose={() => setCompareJob(null)} /> : null}
    </main>
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
          <button className="icon-button" onClick={onClose}>
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
              <dt>网站同款 Runtime</dt>
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

function StatusPanel({
  assetStatus,
  hardware,
  hardwareLoading,
  counts,
  onRetest
}: {
  assetStatus: AssetStatus | null;
  hardware: HardwareReport | null;
  hardwareLoading: boolean;
  counts: Record<UpscaleJob["status"], number>;
  onRetest: () => void;
}) {
  const ready = Boolean(assetStatus?.qualityModes.standard.ok);
  const checking = hardwareLoading && !hardware;
  const verdict = checking ? "检测中" : ready ? "网站同款 AI 可用" : "配置缺失";

  return (
    <section className={`status-compact ${ready ? "ok" : "warn"}`}>
      <div>
        <span>运行状态</span>
        <strong>{verdict}</strong>
        <small>
          CUDA {hardware?.comfyuiCudaAvailable ? "可用" : checking ? "检测中" : "待检测"} · 处理中 {counts.running} · 等待 {counts.queued}
        </small>
      </div>
      <button className="secondary" disabled={hardwareLoading} onClick={onRetest}>
        {hardwareLoading ? "检测中" : "检测"}
      </button>
      {!ready ? <p>{assetStatus?.missing.join("、") || "正在检查资源"}</p> : null}
    </section>
  );
}

function SettingsPanel({
  settings,
  status,
  onChange,
  onSelectOutputDirectory
}: {
  settings: UpscaleSettings;
  status: AssetStatus | null;
  hardware: HardwareReport | null;
  onChange: (settings: UpscaleSettings) => void;
  onSelectOutputDirectory: () => void;
}) {
  const selectedQualityStatus = status?.qualityModes.standard;

  return (
    <section className="settings">
      <h2>超分设置</h2>
      <p className="section-note">固定使用网站同款 AI：ComfyUI + 4x-UltraSharp.pth + CUDA。</p>

      <div className="chain-card">
        <strong>网站同款 AI</strong>
        <span>旧网站 AI 按钮对应链路</span>
      </div>

      {selectedQualityStatus && !selectedQualityStatus.ok ? (
        <p className="quality-warning">当前链路缺少：{selectedQualityStatus.missing.join("、")}</p>
      ) : null}

      <label>
        输出格式
        <select
          value={settings.outputFormat}
          onChange={(event) => onChange({ ...settings, outputFormat: event.target.value as ImageFormat })}
        >
          <option value="png">PNG</option>
          <option value="jpg">JPEG</option>
          <option value="webp">WebP</option>
        </select>
      </label>

      <label>
        最大长边（默认 4096；0 = 真实 4x）
        <input
          type="number"
          min={0}
          max={16384}
          value={settings.maxSide}
          onChange={(event) => onChange({ ...settings, maxSide: Number(event.target.value) })}
        />
      </label>
      <p className="field-hint">要贴近旧网页效果，保留 4096；要真实 4x，填 0。</p>

      <div className="output-row">
        <div>
          <span>输出目录</span>
          <p>{settings.outputDirectory || "原图同级目录 / upscaled"}</p>
        </div>
        <button className="secondary" onClick={onSelectOutputDirectory}>
          更改
        </button>
      </div>
    </section>
  );
}
function PendingList({ paths, onRemove }: { paths: string[]; onRemove: (path: string) => void }) {
  if (paths.length === 0) return null;
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>待处理图片</h2>
        <span>{paths.length}</span>
      </div>
      <div className="pending-list">
        {paths.map((path) => (
          <div className="pending-item" key={path}>
            <Thumb path={path} />
            <span>{basename(path)}</span>
            <button className="icon-button" onClick={() => onRemove(path)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function JobList({ jobs, now, onCompare }: { jobs: UpscaleJob[]; now: number; onCompare: (job: UpscaleJob) => void }) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h2>任务记录</h2>
        <span>{jobs.length}</span>
      </div>
      {jobs.length === 0 ? (
        <div className="empty">还没有任务。</div>
      ) : (
        <div className="job-list">
          {jobs.map((job) => (
            <article className={`job ${job.status}`} key={job.id}>
              <div className="job-main">
                <div>
                  <h3>{job.fileName}</h3>
                  <p>{job.message}</p>
                  {job.error && <pre>{job.error}</pre>}
                </div>
                <strong>{statusText(job.status)}</strong>
              </div>
              <div className="progress">
                <div style={{ width: `${job.progress}%` }} />
              </div>
              <div className="job-meta">
                <span>
                  {job.dimensions ? `${job.dimensions.width}x${job.dimensions.height}` : "未知尺寸"} {"->"}{" "}
                  {job.targetDimensions ? `${job.targetDimensions.width}x${job.targetDimensions.height}` : "待计算"}
                </span>
                <span>{durationText(job, now)}</span>
              </div>
              <div className="job-actions">
                {job.status === "running" || job.status === "queued" ? (
                  <button className="secondary" onClick={() => void window.upscaler.cancelJob(job.id)}>
                    取消
                  </button>
                ) : null}
                {job.outputPath && job.status === "succeeded" ? (
                  <>
                    <button className="secondary" onClick={() => onCompare(job)}>
                      对比
                    </button>
                    <button className="secondary" onClick={() => void window.upscaler.reveal(job.outputPath!)}>
                      打开位置
                    </button>
                  </>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function CompareModal({ job, onClose }: { job: UpscaleJob; onClose: () => void }) {
  const [before, setBefore] = useState<string | null>(null);
  const [after, setAfter] = useState<string | null>(null);
  const [position, setPosition] = useState(50);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [dragStart, setDragStart] = useState<{ x: number; y: number; panX: number; panY: number } | null>(null);
  const [failed, setFailed] = useState(false);
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

  const ready = Boolean(before && after);
  const clampedZoom = Math.max(1, Math.min(6, zoom));
  const layerStyle = {
    transform: `translate(${pan.x}px, ${pan.y}px) scale(${clampedZoom})`
  };

  function setZoomKeepingPan(nextZoom: number) {
    const value = Math.max(1, Math.min(6, Number(nextZoom.toFixed(2))));
    setZoom(value);
    if (value === 1) setPan({ x: 0, y: 0 });
  }

  function resetView() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const delta = event.deltaY < 0 ? 0.25 : -0.25;
    setZoomKeepingPan(clampedZoom + delta);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (clampedZoom <= 1) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStart({ x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y });
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart) return;
    const limitX = event.currentTarget.clientWidth * clampedZoom * 0.5;
    const limitY = event.currentTarget.clientHeight * clampedZoom * 0.5;
    setPan({
      x: clampNumber(dragStart.panX + event.clientX - dragStart.x, -limitX, limitX),
      y: clampNumber(dragStart.panY + event.clientY - dragStart.y, -limitY, limitY)
    });
  }

  function handlePointerEnd(event: React.PointerEvent<HTMLDivElement>) {
    if (dragStart) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Pointer capture may already be released by the browser.
      }
    }
    setDragStart(null);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal compare-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>前后对比 · {job.fileName}</h2>
          <button className="icon-button" onClick={onClose}>
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
              <button className="secondary" onClick={() => setZoomKeepingPan(clampedZoom - 0.5)}>
                -
              </button>
              <span>{Math.round(clampedZoom * 100)}%</span>
              <button className="secondary" onClick={() => setZoomKeepingPan(clampedZoom + 0.5)}>
                +
              </button>
              <button className="secondary" onClick={resetView}>
                重置
              </button>
            </div>
            <div
              className={`compare ${clampedZoom > 1 ? "zoomed" : ""}`}
              onWheel={handleWheel}
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
              <span className="compare-tag left">处理前</span>
              <span className="compare-tag right">处理后</span>
            </div>
            <input
              className="compare-range"
              type="range"
              min={0}
              max={100}
              value={position}
              onChange={(event) => setPosition(Number(event.target.value))}
            />
            <p className="hw-hint">
              拖动滑块对比，滚轮或按钮缩放，放大后拖动画面 ·{" "}
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

function Thumb({ path, max = 120 }: { path: string; max?: number }) {
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
    <div className="thumb" ref={ref}>
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

