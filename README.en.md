<div align="center">
  <img src="build/icon.png" width="88" alt="RiverMoon" />
  <h1>RiverMoon AI Studio</h1>
  <p>A Windows creative desktop app that combines RiverMoon cloud AI services with local NVIDIA GPU upscaling.</p>

  [中文](README.md) · [User Guide](docs/USER_GUIDE_BILINGUAL.md) · [Product Report](docs/PRODUCT_REPORT_BILINGUAL.md)

  [![CI](https://github.com/MoonFlower-King/rivermoon-local-upscaler/actions/workflows/ci.yml/badge.svg)](https://github.com/MoonFlower-King/rivermoon-local-upscaler/actions/workflows/ci.yml)
  [![CodeQL](https://github.com/MoonFlower-King/rivermoon-local-upscaler/actions/workflows/codeql.yml/badge.svg)](https://github.com/MoonFlower-King/rivermoon-local-upscaler/actions/workflows/codeql.yml)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
  ![Platform](https://img.shields.io/badge/platform-Windows%20x64-blue.svg)
</div>

## Scope

RiverMoon AI Studio contains both hosted AI features and a local GPU tool:

| Module | Execution | RiverMoon API Key | User content upload |
| --- | --- | --- | --- |
| AI image generation | RiverMoon image gateway | Required | Prompts and reference images are sent to the service |
| AI video generation | RiverMoon video gateway | Required | Prompts and reference images are sent to the service |
| GPT chat and image analysis | RiverMoon Agent gateway | Required | Messages and image attachments are sent to the service |
| Image upscaling | Local ComfyUI/CUDA | Not required | No |
| Image upscaling · Smart Mode (optional) | Routing decision in the cloud, processing stays local | Required | A downscaled 512px preview is sent to the cloud for content-type detection |

Upscaling is fully local and offline by default. Only when the user explicitly selects Smart Mode does the app send a 512px preview to a cloud GPT for content-type routing (photo / illustration / text); the actual image processing always runs locally, and the app falls back to the pure local pipeline when no Key is configured or the cloud is unreachable.

This repository contains the open-source Windows desktop client. The hosted `rivermoon7.com` backend is not part of this repository. Cloud features require a user-provided API Key.

## Features

- Contract-driven AI image generation, editing, custom sizes, formats, qualities, and storyboard templates.
- Text-to-video, image-to-video, multi-reference video, task recovery, and local downloads.
- Streaming GPT responses, reasoning controls, image analysis, and local conversation history.
- Local ComfyUI/PyTorch/CUDA upscaling with five processing modes (UltraSharp AI restore / AI + web-style enhance / enhance only / SUPIR diffusion repair / GPT smart routing), an on-demand model registry (4x-UltraSharp, RealESRGAN x4plus, RealESRGAN Anime6B), and a default 4096-pixel maximum side.
- Unified local asset library, account balance, diagnostics, and GitHub Release update checks.

## Security model

- The renderer has no direct network access and never receives the plaintext API Key.
- Electron `safeStorage` encrypts the Key in the main process.
- Main-process allowlists constrain local file reads.
- Authenticated video requests use the HTTPS gateway; external CDN downloads do not carry the Key.
- Diagnostic output redacts Keys, signed URLs, and local paths.

See [SECURITY.md](SECURITY.md) for the complete boundary.

## Development

Requirements: Windows 10/11 x64, Node.js 20+, and Git. NVIDIA/CUDA plus a local ComfyUI/PyTorch runtime are only required for full local-upscaling tests.

```powershell
git clone https://github.com/MoonFlower-King/rivermoon-local-upscaler.git
cd rivermoon-local-upscaler
npm ci
npm run check
npm run dev:electron
```

`npm run check` runs the public-repository preflight, formatting checks, lint, unit tests, and a production build. It does not download the multi-gigabyte ComfyUI runtime.

Prepare a local runtime when testing image upscaling:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-comfyui-runtime.ps1 `
  -SourceComfyUI "D:\ComfyUI"
```

The repository and release package do not commit `4x-UltraSharp.pth`. The app downloads and verifies it only after an explicit user action. Its non-commercial license remains a release constraint; see [NOTICE](NOTICE).

## Environment variables

The app does not automatically load `.env` files. Set development variables in the current shell and never commit real credentials:

```powershell
$env:RIVERMOON_TEST_KEY = "your-development-key"
npm run dev:electron
```

See [.env.example](.env.example) for the supported variables.

## Build and release checks

```powershell
npm run dist:dir
npm run release:smoke
npm run release:launch-smoke
```

Distribute the entire `release/win-unpacked/` folder. The full runtime is several gigabytes, so GitHub Releases use multipart 7-Zip assets. See [BUILD_AND_RELEASE.md](docs/BUILD_AND_RELEASE.md).

Before pushing source changes:

```powershell
npm run repo:preflight
```

Before tagging a public release:

```powershell
npm run repo:preflight:strict
```

## License

Project-authored source code is licensed under the [MIT License](LICENSE). Third-party runtimes, model weights, hosted services, and brand assets keep their own terms. See [NOTICE](NOTICE).
