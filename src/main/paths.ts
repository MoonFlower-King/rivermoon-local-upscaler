import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export function appRoot(): string {
  return app.isPackaged ? process.resourcesPath : path.resolve(process.cwd(), "resources");
}

export function modelsRoot(): string {
  return path.join(appRoot(), "models");
}

export function comfyRuntimeRoot(): string {
  const configured = process.env.RIVERMOON_COMFYUI_ROOT || process.env.COMFYUI_ROOT;
  if (configured && fs.existsSync(configured)) return configured;

  const workerRoot = "D:/ComfyUI";
  if (fs.existsSync(path.join(workerRoot, "main.py"))) return workerRoot;

  return path.join(appRoot(), "comfyui-runtime");
}

export function comfyPythonPath(): string | null {
  const root = comfyRuntimeRoot();
  const candidates = [
    path.join(root, "python_embeded", "python.exe"),
    path.join(root, "python", "python.exe"),
    path.join(root, "venv", "Scripts", "python.exe")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function comfyMainPath(): string {
  return path.join(comfyRuntimeRoot(), "main.py");
}

export function comfyInputRoot(): string {
  return path.join(comfyRuntimeRoot(), "input");
}

export function comfyOutputRoot(): string {
  return path.join(comfyRuntimeRoot(), "output");
}

export function comfyUpscaleModelsRoot(): string {
  return path.join(comfyRuntimeRoot(), "models", "upscale_models");
}

/** runtime 目录不可写时模型的回退位置（配合 extra_model_paths.yaml 挂给 ComfyUI）。 */
export function userModelsRoot(): string {
  return path.join(app.getPath("userData"), "models", "upscale_models");
}

export function extraModelPathsConfig(): string {
  return path.join(app.getPath("userData"), "extra_model_paths.yaml");
}

export function findComfyModel(modelName = "4x-UltraSharp.pth"): string | null {
  for (const dir of [comfyUpscaleModelsRoot(), userModelsRoot()]) {
    const candidate = path.join(dir, modelName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** SUPIR 修复链路的本机资源检查：ComfyUI-SUPIR 节点 + SUPIR/SDXL 双模型。 */
export function supirResources(): { available: boolean; missing: string[] } {
  const root = comfyRuntimeRoot();
  const checks = [
    { label: "ComfyUI-SUPIR 节点", target: path.join(root, "custom_nodes", "ComfyUI-SUPIR") },
    {
      label: "SUPIR-v0Q_fp16.safetensors",
      target: path.join(root, "models", "checkpoints", "SUPIR-v0Q_fp16.safetensors")
    },
    {
      label: "sd_xl_base_1.0.safetensors",
      target: path.join(root, "models", "checkpoints", "sd_xl_base_1.0.safetensors")
    }
  ];
  const missing = checks.filter((check) => !fs.existsSync(check.target)).map((check) => check.label);
  return { available: missing.length === 0, missing };
}

export function logsRoot(): string {
  const dir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listComfyModels(): string[] {
  const names = new Set<string>();
  for (const dir of [comfyUpscaleModelsRoot(), userModelsRoot()]) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.toLowerCase().endsWith(".pth")) names.add(entry);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}
