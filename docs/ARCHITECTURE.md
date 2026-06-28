# Architecture

## Product Goal

Deliver a standalone local Windows image upscaler that opens directly to a work area, processes images locally, and matches the historical website `AI` upscaling chain as closely as practical.

## Current Chain

```text
Renderer
-> Main process job queue
-> Managed local ComfyUI on 127.0.0.1:18188
-> LoadImage
-> UpscaleModelLoader(4x-UltraSharp.pth)
-> ImageUpscaleWithModel
-> ImageScale(lanczos, max side setting)
-> SaveImage
-> copy/convert output to user directory
```

Default max side is `4096`. `0` means true 4x.

## Runtime Components

### Renderer

- Drop zone.
- File/folder picker.
- Pending list.
- Job list.
- Settings panel.
- Compact status card.
- Compare modal with zoom/pan.

### Preload

Exposes typed IPC for file picking, starting jobs, listing jobs, subscribing to updates, revealing files, previews, settings, app info, hardware check, and logs.

### Main Process

- Owns local `user-data` path.
- Loads settings and saved jobs.
- Validates paths and reads image dimensions.
- Computes target size.
- Starts and monitors ComfyUI.
- Emits job updates.
- Writes `jobs.json`, `settings.json`, and logs.

### Comfy Engine

- Starts bundled ComfyUI/Python if needed.
- Submits prompt with a fixed `client_id`.
- Listens to websocket progress events.
- Uses history polling as completion fallback.
- Copies or transcodes final output.

## Persistence

Packaged app data lives next to the exe:

```text
release\win-unpacked\user-data\
```

Important files:

```text
settings.json
jobs.json
logs\
```

## Distribution

Use `electron-builder` for Windows. Current portable delivery is:

```text
release\win-unpacked\
```

The app is ASAR-packed. Runtime resources are copied via `extraResources`.

## Failure Model

Expected failures should become understandable Chinese UI messages:

- Missing ComfyUI Runtime.
- Missing `4x-UltraSharp.pth`.
- CUDA unavailable.
- Driver/CUDA import failure.
- Unsupported file type.
- Output path not writable.
- ComfyUI prompt validation or execution error.

## Explicitly Out Of Current Scope

- Pro / DiffBIR.
- SUPIR.
- NCNN/Vulkan fallback.
- CPU fallback.
- DirectML fallback.
