import { app } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { comfyMainPath, comfyPythonPath, findComfyModel } from "./paths.js";
import { log } from "./logger.js";
import type { GpuInfo, HardwareReport } from "./types.js";

const GPU_QUERY_TIMEOUT_MS = 8000;
/** CUDA 自检要冷启动 python + torch，比 WMI 查询慢得多，超时给足。 */
const CUDA_PROBE_TIMEOUT_MS = 15_000;

/**
 * 带缓存的硬件检测。ComfyUI Runtime / 模型指纹未变时直接返回上次结果；
 * force=true（用户手动“重新检测”）或指纹变化时才真正重跑。
 */
export async function getHardwareReport(force = false): Promise<HardwareReport> {
  const fingerprint = hardwareFingerprint();
  if (!force) {
    const cached = readCache();
    if (cached && cached.fingerprint === fingerprint) return cached.report;
  }
  const report = await probeHardware();
  writeCache(fingerprint, report);
  return report;
}

function cachePath(): string {
  return path.join(app.getPath("userData"), "hardware-cache.json");
}

/** ComfyUI Runtime 和 4x-UltraSharp 模型指纹；任一变化即让缓存失效。 */
function hardwareFingerprint(): string {
  const comfyPython = comfyPythonPath() ?? "none";
  const comfyMain = fs.existsSync(comfyMainPath()) ? comfyMainPath() : "none";
  const comfyModel = findComfyModel("4x-UltraSharp.pth") ?? "none";
  return `${comfyPython}|${comfyMain}|${comfyModel}`;
}

function readCache(): { fingerprint: string; report: HardwareReport } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath(), "utf8"));
    if (parsed && typeof parsed.fingerprint === "string" && parsed.report) {
      return parsed as { fingerprint: string; report: HardwareReport };
    }
  } catch {
    // 缓存缺失或损坏时忽略。
  }
  return null;
}

function writeCache(fingerprint: string, report: HardwareReport): void {
  try {
    fs.writeFileSync(cachePath(), JSON.stringify({ fingerprint, report }), "utf8");
  } catch {
    // 缓存写入失败不致命。
  }
}

/**
 * 网站同款 AI 兼容性检测。当前版本只判断 ComfyUI Runtime、CUDA 和 4x-UltraSharp 模型。
 */
export async function probeHardware(): Promise<HardwareReport> {
  const issues: string[] = [];
  const hints: string[] = [];

  // 运行时（引擎）与模型分开判断：模型按需下载是正常状态，不应报成“引擎缺失”。
  const comfyRuntimeFound = Boolean(comfyPythonPath() && fs.existsSync(comfyMainPath()));
  const modelFound = Boolean(findComfyModel("4x-UltraSharp.pth"));
  const gpus = await queryGpus();

  if (!comfyRuntimeFound) {
    issues.push("未找到内置 AI 引擎运行时。");
    hints.push("请重新安装完整版，或先运行 scripts\\prepare-comfyui-runtime.ps1 准备 resources/comfyui-runtime。");
  } else if (!modelFound) {
    issues.push("超分模型尚未下载。");
    hints.push("打开「图片超分」页，点击「下载模型」即可开始使用（约 64MB）。");
  }

  const durationMs: number | null = null;
  let comfyuiCudaAvailable = false;
  let cudaDevices: string[] = [];

  if (comfyRuntimeFound) {
    const result = await probeComfyCuda();
    comfyuiCudaAvailable = result.ok;
    cudaDevices = result.devices;
    if (!result.ok) {
      issues.push(result.issue);
      for (const hint of result.hints) hints.push(hint);
    }
  }

  const report: HardwareReport = {
    ok: comfyRuntimeFound && comfyuiCudaAvailable && modelFound,
    comfyuiRuntimeFound: comfyRuntimeFound,
    comfyuiCudaAvailable,
    cudaDevices,
    gpus,
    durationMs,
    issues,
    hints: dedupe(hints)
  };
  log(`硬件检测 ok=${report.ok} cuda=[${cudaDevices.join("、")}] 问题=${issues.join("|") || "无"}`);
  return report;
}

async function probeComfyCuda(): Promise<{ ok: boolean; devices: string[]; issue: string; hints: string[] }> {
  const python = comfyPythonPath();
  if (!python) {
    return {
      ok: false,
      devices: [],
      issue: "未找到 ComfyUI 使用的 Python。",
      hints: ["请确认 resources/comfyui-runtime 内包含 python_embeded/python.exe、python/python.exe 或 venv/Scripts/python.exe。"]
    };
  }

  return new Promise((resolve) => {
    const script = [
      "import json, torch",
      "devices=[]",
      "ok=torch.cuda.is_available()",
      "count=torch.cuda.device_count() if ok else 0",
      "devices=[torch.cuda.get_device_name(i) for i in range(count)]",
      "print(json.dumps({'ok': bool(ok), 'devices': devices}))"
    ].join("; ");
    const child = spawn(python, ["-c", script], {
      cwd: path.dirname(comfyMainPath()),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let errorOutput = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorOutput += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill(), CUDA_PROBE_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({
        ok: false,
        devices: [],
        issue: "无法启动 ComfyUI Python 进行 CUDA 检测。",
        hints: ["请重新安装完整版，或导出诊断日志检查内置 Python。"]
      });
    });
    child.on("exit", () => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(output.trim()) as { ok?: boolean; devices?: string[] };
        const devices = Array.isArray(parsed.devices) ? parsed.devices.filter((item) => typeof item === "string") : [];
        if (parsed.ok && devices.length > 0) {
          resolve({ ok: true, devices, issue: "", hints: [] });
          return;
        }
      } catch {
        // Fall through to failure.
      }
      resolve({
        ok: false,
        devices: [],
        issue: "ComfyUI CUDA 检测未通过。",
        hints: [
          "网站同款质量链路需要 NVIDIA 显卡和可用驱动。",
          errorOutput.trim() ? `Python 输出：${errorOutput.trim().slice(0, 300)}` : "请确认显卡驱动已正确安装。"
        ]
      });
    });
  });
}

async function queryGpus(): Promise<GpuInfo[]> {
  return new Promise((resolve) => {
    // 用 Get-WmiObject 而非 Get-CimInstance：在 electron 冷启动的子进程里，
    // CIM 会话初始化要约 10 秒，而 Get-WmiObject 走老的 COM 直连，约 0.5 秒返回相同数据。
    const child = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-WmiObject Win32_VideoController | Select-Object Name,DriverVersion | ConvertTo-Json -Compress"
      ],
      { windowsHide: true }
    );

    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });
    // 读掉 stderr，避免管道缓冲填满导致子进程阻塞。
    child.stderr?.on("data", () => {});

    const timer = setTimeout(() => child.kill(), GPU_QUERY_TIMEOUT_MS);
    child.on("error", () => {
      clearTimeout(timer);
      resolve([]);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(parseGpuJson(output));
    });
  });
}

function parseGpuJson(raw: string): GpuInfo[] {
  const text = raw.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    return entries
      .map((entry): GpuInfo | null => {
        const name = typeof entry?.Name === "string" ? entry.Name.trim() : "";
        if (!name) return null;
        const driverVersion =
          typeof entry?.DriverVersion === "string" && entry.DriverVersion.trim()
            ? entry.DriverVersion.trim()
            : null;
        return { name, driverVersion };
      })
      .filter((gpu): gpu is GpuInfo => gpu !== null);
  } catch {
    return [];
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
