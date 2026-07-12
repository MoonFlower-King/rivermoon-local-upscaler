param(
  [string]$SourceComfyUI = "",
  [string]$Destination = "resources\comfyui-runtime",
  [switch]$BuildPortablePython,
  # 留空则自动探测 Python 3.12（py -3.12 / PATH 中的 python）；也可显式传入其安装目录。
  [string]$BasePython = "",
  [switch]$AllowLocalVenvCopy
)

$ErrorActionPreference = "Stop"

if (-not $SourceComfyUI) {
  throw "SourceComfyUI is required. Example: -SourceComfyUI 'D:\ComfyUI'"
}

function Resolve-FullPath([string]$PathValue) {
  if ([System.IO.Path]::IsPathRooted($PathValue)) {
    return [System.IO.Path]::GetFullPath($PathValue)
  }
  return [System.IO.Path]::GetFullPath((Join-Path (Get-Location) $PathValue))
}

$source = Resolve-FullPath $SourceComfyUI
$destinationRoot = Resolve-FullPath $Destination

if (-not (Test-Path (Join-Path $source "main.py"))) {
  throw "SourceComfyUI does not look like ComfyUI: $source"
}

$workspace = [System.IO.Path]::GetFullPath((Get-Location).Path)
if (-not $destinationRoot.StartsWith($workspace, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Destination must stay inside this project workspace: $destinationRoot"
}

Write-Host "Preparing ComfyUI runtime"
Write-Host "Source:      $source"
Write-Host "Destination: $destinationRoot"

if (Test-Path $destinationRoot) {
  Write-Host "Cleaning previous runtime..."
  Remove-Item -LiteralPath $destinationRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $destinationRoot | Out-Null

$dirs = @(
  "alembic_db",
  "app",
  "api_server",
  "comfy",
  "comfy_api",
  "comfy_config",
  "comfy_execution",
  "comfy_extras",
  "middleware",
  "utils"
)

$files = @(
  "main.py",
  "nodes.py",
  "execution.py",
  "server.py",
  "folder_paths.py",
  "node_helpers.py",
  "latent_preview.py",
  "cuda_malloc.py",
  "protocol.py",
  "comfyui_version.py",
  "requirements.txt",
  "pyproject.toml"
)

foreach ($dir in $dirs) {
  $from = Join-Path $source $dir
  if (Test-Path $from) {
    Write-Host "Copy dir  $dir"
    Copy-Item -LiteralPath $from -Destination (Join-Path $destinationRoot $dir) -Recurse -Force
  }
}

foreach ($file in $files) {
  $from = Join-Path $source $file
  if (Test-Path $from) {
    Write-Host "Copy file $file"
    Copy-Item -LiteralPath $from -Destination (Join-Path $destinationRoot $file) -Force
  }
}

Get-ChildItem -LiteralPath $source -Filter "*.py" -File | ForEach-Object {
  Write-Host "Copy root py $($_.Name)"
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $destinationRoot $_.Name) -Force
}

$modelsOut = Join-Path $destinationRoot "models\upscale_models"
New-Item -ItemType Directory -Force -Path $modelsOut | Out-Null
@"
Model weights are intentionally not copied into the repository runtime.
Use the application's explicit model download flow.
"@ | Set-Content -Encoding UTF8 (Join-Path $modelsOut "README.txt")

New-Item -ItemType Directory -Force -Path (Join-Path $destinationRoot "input") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $destinationRoot "output") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $destinationRoot "temp") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $destinationRoot "custom_nodes") | Out-Null
@"
This directory is intentionally empty for the desktop runtime.
The image upscale workflow uses built-in ComfyUI nodes only.
"@ | Set-Content -Encoding UTF8 (Join-Path $destinationRoot "custom_nodes\README.md")

$portablePython = Join-Path $source "python_embeded"
if (Test-Path (Join-Path $portablePython "python.exe")) {
  Write-Host "Copy portable python_embeded"
  Copy-Item -LiteralPath $portablePython -Destination (Join-Path $destinationRoot "python_embeded") -Recurse -Force
} elseif ($BuildPortablePython) {
  $pythonOut = Join-Path $destinationRoot "python_embeded"
  $sitePackages = Join-Path $source "venv\Lib\site-packages"
  if (-not $BasePython) {
    # 自动探测：优先 py -3.12，其次 PATH 中的 python。
    $detected = (& py -3.12 -c "import os,sys;print(os.path.dirname(sys.executable))" 2>$null | Select-Object -First 1)
    if (-not $detected) {
      $cmd = Get-Command python -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($cmd) { $detected = Split-Path $cmd.Source -Parent }
    }
    $BasePython = $detected
  }
  if (-not $BasePython -or -not (Test-Path (Join-Path $BasePython "python.exe"))) {
    throw "未找到 Python 3.12。请用 -BasePython 指定其安装目录（需包含 python.exe），例如：-BasePython 'C:\\Python312'。"
  }
  if (-not (Test-Path $sitePackages)) {
    throw "Source venv site-packages not found: $sitePackages"
  }

  Write-Host "Build portable python_embeded from $BasePython"
  New-Item -ItemType Directory -Force -Path $pythonOut | Out-Null
  Copy-Item -LiteralPath (Join-Path $BasePython "python.exe") -Destination $pythonOut -Force
  Copy-Item -LiteralPath (Join-Path $BasePython "pythonw.exe") -Destination $pythonOut -Force
  Copy-Item -LiteralPath (Join-Path $BasePython "python3.dll") -Destination $pythonOut -Force
  Copy-Item -LiteralPath (Join-Path $BasePython "python312.dll") -Destination $pythonOut -Force
  Copy-Item -LiteralPath (Join-Path $BasePython "vcruntime140.dll") -Destination $pythonOut -Force
  Copy-Item -LiteralPath (Join-Path $BasePython "vcruntime140_1.dll") -Destination $pythonOut -Force
  Copy-Item -LiteralPath (Join-Path $BasePython "Lib") -Destination (Join-Path $pythonOut "Lib") -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $BasePython "DLLs") -Destination (Join-Path $pythonOut "DLLs") -Recurse -Force
  if (Test-Path (Join-Path $BasePython "Scripts")) {
    Copy-Item -LiteralPath (Join-Path $BasePython "Scripts") -Destination (Join-Path $pythonOut "Scripts") -Recurse -Force
  }

  $outSitePackages = Join-Path $pythonOut "Lib\site-packages"
  if (Test-Path $outSitePackages) {
    Remove-Item -LiteralPath $outSitePackages -Recurse -Force
  }
  Write-Host "Copy ComfyUI site-packages"
  Copy-Item -LiteralPath $sitePackages -Destination $outSitePackages -Recurse -Force

@"
.
..
Lib
DLLs
Lib\site-packages
import site
"@ | Set-Content -Encoding ASCII (Join-Path $pythonOut "python._pth")

  @"
@echo off
set PYTHONNOUSERSITE=1
set PYTHONPATH=
"%~dp0python_embeded\python.exe" main.py --port 18188 --listen 127.0.0.1
"@ | Set-Content -Encoding ASCII (Join-Path $destinationRoot "run-comfyui-runtime.bat")
} elseif ($AllowLocalVenvCopy) {
  $venv = Join-Path $source "venv"
  if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) {
    throw "AllowLocalVenvCopy was set but no venv python exists: $venv"
  }
  Write-Warning "Copying a normal venv is for local testing only. It is not a reliable customer runtime."
  Copy-Item -LiteralPath $venv -Destination (Join-Path $destinationRoot "venv") -Recurse -Force
} else {
  @"
ComfyUI code and models were copied, but no portable Python was found.

For a true customer-ready package, add a portable Python runtime with CUDA PyTorch into:

  $destinationRoot\python_embeded

Expected executable:

  $destinationRoot\python_embeded\python.exe

Do not rely on a normal venv for customer delivery. The current source venv points to this machine's base Python.
"@ | Set-Content -Encoding UTF8 (Join-Path $destinationRoot "PYTHON_RUNTIME_REQUIRED.txt")
  Write-Warning "No portable python_embeded found. Runtime package is not yet customer-ready."
}

Write-Host ""
Write-Host "Done."
Write-Host "Runtime size:"
Get-ChildItem -LiteralPath $destinationRoot -Recurse -File | Measure-Object -Property Length -Sum |
  ForEach-Object { "{0:N2} GB" -f (($_.Sum) / 1GB) } |
  Write-Host
