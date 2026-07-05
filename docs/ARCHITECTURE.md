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
- Apple-style vibrancy design with light/dark themes: CSS tokens switch via `prefers-color-scheme`, rendered over the Win11 acrylic window material (plain background fallback elsewhere).

### Preload

Exposes typed IPC for file picking, starting jobs, listing jobs, subscribing to updates, revealing files, previews, settings, app info, hardware check, and logs.

### Main Process

- Owns local `user-data` path (falls back to the Electron default when the local directory is not writable).
- Loads settings and saved jobs.
- Validates renderer-supplied paths against an allowlist and reads image dimensions.
- Computes target size.
- Resolves collision-free output paths: appends `_2`/`_3`… when the target file already exists (`src/main/output-path.ts`).
- Starts and monitors ComfyUI; cancelling a running job interrupts ComfyUI to free the GPU immediately.
- Records the output file size (`outputBytes`) on success.
- Emits throttled job updates.
- Writes `jobs.json`, `settings.json`, and logs.

### Comfy Engine

- Starts bundled ComfyUI/Python if needed.
- Submits prompt with a per-job random `client_id`.
- Listens to websocket progress events (`progress_state`, legacy `progress`) via the main process's native `WebSocket` (Electron 42.5.2 / Node 24, no extra dependency).
- Low-frequency history polling doubles as a completion safety net; when the websocket is unavailable it falls back to polling only (completion checks, no time-based fake progress).
- Cancellation POSTs `/interrupt` and removes the prompt from `/queue`.
- Copies or transcodes final output, then cleans up temporary input/output files inside the ComfyUI runtime.
- Pure protocol logic (prompt building, progress mapping, history health checks such as `assertHistoryHealthy`) lives in `src/main/comfy-protocol.ts`, unit-tested with vitest.

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

## Quality Gates

Run after every code change:

```text
npm run build
npm run lint
npm test
```

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
