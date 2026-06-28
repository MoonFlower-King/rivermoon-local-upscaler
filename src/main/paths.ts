import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

export function appRoot(): string {
  return app.isPackaged ? process.resourcesPath : path.resolve(process.cwd(), "resources");
}

export function enginesRoot(): string {
  return path.join(appRoot(), "engines", "win32-x64");
}

export function modelsRoot(): string {
  return path.join(appRoot(), "models");
}

export function comfyRuntimeRoot(): string {
  const configured = process.env.RIVERMOON_COMFYUI_ROOT || process.env.COMFYUI_ROOT;
  if (configured && fs.existsSync(configured)) return configured;

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

export function comfyDiffbirModelsRoot(): string {
  return path.join(comfyRuntimeRoot(), "models", "diffbir");
}

export function comfyCheckpointsRoot(): string {
  return path.join(comfyRuntimeRoot(), "models", "checkpoints");
}

export function comfyCustomNodeRoot(name: string): string {
  return path.join(comfyRuntimeRoot(), "custom_nodes", name);
}

export function findEngine(): string | null {
  const candidates = [
    path.join(enginesRoot(), "realesrgan-ncnn-vulkan.exe"),
    path.join(enginesRoot(), "upscayl-bin.exe")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export function findComfyModel(modelName = "4x-UltraSharp.pth"): string | null {
  const candidate = path.join(comfyUpscaleModelsRoot(), modelName);
  return fs.existsSync(candidate) ? candidate : null;
}

export function findComfyCheckpoint(modelName: string): string | null {
  const candidate = path.join(comfyCheckpointsRoot(), modelName);
  return fs.existsSync(candidate) ? candidate : null;
}

export function findDiffbirModel(modelName: string): string | null {
  const candidate = path.join(comfyDiffbirModelsRoot(), modelName);
  return fs.existsSync(candidate) ? candidate : null;
}

export function logsRoot(): string {
  const dir = path.join(app.getPath("userData"), "logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function tempRoot(): string {
  const dir = path.join(app.getPath("userData"), "temp");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function listAvailableModels(): string[] {
  const dir = modelsRoot();
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir);
  const paramStems = new Set(
    entries.filter((entry) => entry.endsWith(".param")).map((entry) => path.basename(entry, ".param"))
  );
  return entries
    .filter((entry) => entry.endsWith(".bin"))
    .map((entry) => path.basename(entry, ".bin"))
    .filter((stem) => paramStems.has(stem))
    .sort((a, b) => a.localeCompare(b));
}

export function listComfyModels(): string[] {
  const dir = comfyUpscaleModelsRoot();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.toLowerCase().endsWith(".pth"))
    .sort((a, b) => a.localeCompare(b));
}

export function listComfyCheckpoints(): string[] {
  const dir = comfyCheckpointsRoot();
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((entry) => /\.(safetensors|ckpt|pth)$/i.test(entry))
    .sort((a, b) => a.localeCompare(b));
}
