# Build And Release Notes

## Current Build

Project root:

```text
D:\rivermoon-local-upscaler
```

Portable release:

```text
D:\rivermoon-local-upscaler\release\win-unpacked\RiverMoon 本地超分.exe
```

Delivery is the full portable directory:

```text
D:\rivermoon-local-upscaler\release\win-unpacked\
```

Copy the whole directory. Do not copy only the exe.

## Included Assets

Current product keeps only the website-matching AI chain:

```text
resources/comfyui-runtime/python_embeded/python.exe
resources/comfyui-runtime/main.py
resources/comfyui-runtime/models/upscale_models/4x-UltraSharp.pth
build/icon.ico
docs/
```

The release build filters out DiffBIR, SUPIR, other upscale models, and old lightweight engine/model resources.

## Commands

```bash
npm run build
npm run dist:dir
```

Use `npm run dist` only when a NSIS installer is specifically needed. It is currently unsigned.

## Validation

After packaging, launch:

```text
D:\rivermoon-local-upscaler\release\win-unpacked\RiverMoon 本地超分.exe
```

Verify:

- Window opens directly to the workspace.
- Only `网站同款 AI` is visible.
- Right-side status card can run CUDA detection.
- Settings persist.
- Task records persist after close/reopen.
- Newest tasks appear first.
- A sample image can run through ComfyUI and produce output.
- Successful job offers `对比` and `打开位置`.
- Compare modal supports zoom and pan.

Packaged Python CUDA check:

```bash
release/win-unpacked/resources/comfyui-runtime/python_embeded/python.exe -c "import torch; print(torch.__version__, torch.cuda.is_available(), torch.version.cuda)"
```

Expected on the verified NVIDIA machine:

```text
2.5.1+cu121 True 12.1
```

## Release Cleanup

For current portable delivery, keep only:

```text
release\win-unpacked\
```

Remove old installers, old `.blockmap` files, `.downloads`, and `release\builder-debug.yml` unless actively debugging electron-builder.

## Known Limitations

- Requires NVIDIA/CUDA and current drivers.
- No DirectML, CPU, AMD, or Intel GPU fallback.
- Installer/exe are unsigned.
- `4x-UltraSharp.pth` license must be resolved before commercial customer distribution.
