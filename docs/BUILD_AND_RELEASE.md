# Build And Release Notes

## Current Build

Project root:

```text
D:\rivermoon-local-upscaler
```

Portable release:

```text
D:\rivermoon-local-upscaler\release\win-unpacked\RiverMoon AI 创作台.exe
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
build/icon.ico
docs/
```

The release build filters out DiffBIR, SUPIR, old lightweight engine/model resources, and `.pth` model weights. The app downloads `4x-UltraSharp.pth` on first use through the in-app model downloader, verifies SHA256, and stores it under user data when packaged.

This is intentional for the current build because `4x-UltraSharp.pth` is marked non-commercial (`CC-BY-NC-SA 4.0`). Commercial distribution must either replace it with a commercially licensed model or keep the current user-initiated download flow and disclose the license clearly.

User-facing and release-facing documents packaged under `resources/docs/` include:

- `USER_GUIDE_BILINGUAL.md`: Chinese/English end-user guide.
- `PRODUCT_REPORT_BILINGUAL.md`: Chinese/English product report for release, business, and technical review.
- `PRODUCT_DOCUMENT.md`: internal product specification and validation baseline.
- `BUILD_AND_RELEASE.md`: build, packaging, and GitHub Release procedure.

## Commands

```bash
npm run build
npm run dist:dir
npm run release:smoke
npm run release:launch-smoke
npm run release:github:assets
npm run release:github:preflight
npm run agent:responses-smoke
npm run image:contract-smoke
npm run video:contract-smoke
npm run video:paid-e2e:dry-run
```

Full non-billing release gate:

```bash
npm run release:verify
```

Online non-billing cloud gateway gate:

```bash
npm run release:online-smoke
```

Manual paid video E2E gate:

```bash
npm run video:paid-e2e
```

Use `npm run dist` only when a NSIS installer is specifically needed. It is currently unsigned.

`npm run release:smoke` checks the packaged `release\win-unpacked` directory without submitting cloud jobs or charging the account. It validates the exe, `app.asar`, agent/image/video module bundles, packaged agent Responses streaming code, packaged image gateway contract/edit code, packaged video gateway safety/retry/download-validation code, ComfyUI runtime, product docs, legacy resource filtering, and expected model packaging state.

`npm run release:launch-smoke` starts the packaged exe with a temporary `RIVERMOON_USER_DATA_DIR`, waits until the app writes its startup log, main-window load log, and React renderer-ready log with the `AI 视频` navigation module present, keeps it alive briefly to catch renderer crashes or unresponsive-window signals, then closes the smoke-test process. This avoids the normal single-instance lock from a development build that may already be open. It proves the packaged main process can start, create its local data area, load the renderer entrypoint, mount the main React app with the video module registered, and survive a short post-load stability window, but it does not click through the UI or validate video generation.

`npm run release:verify` runs lint, tests, `dist:dir`, `release:smoke`, and `release:launch-smoke` in order. It is the preferred local gate before handing off a portable build, but it still does not replace manual GUI QA, model download verification, website-vs-desktop image diff, code signing, real Key HTTPS GPT conversation E2E, real Key HTTPS image generation E2E, or real Key HTTPS video E2E.

## GitHub Release Packaging

The portable package currently contains the embedded ComfyUI/PyTorch/CUDA runtime and is about 6GB before compression. GitHub Release assets must stay below 2GiB per file, so do not upload one full zip. Publish multipart assets instead.

Prerequisites:

- Install GitHub CLI and log in:

```bash
gh auth login
```

- Install 7-Zip and make `7z.exe` available in `PATH`, or set:

```bash
set RIVERMOON_7Z_PATH=C:\Program Files\7-Zip\7z.exe
```

Recommended flow:

```bash
npm run release:verify
npm run release:github:assets
npm run release:github:preflight
```

`npm run release:github:assets` writes GitHub-ready files under:

```text
release\github\
```

It creates multipart `.7z.001`, `.7z.002`, ... assets, `SHA256SUMS-vX.Y.Z.txt`, `manifest-vX.Y.Z.json`, `README-DOWNLOAD-vX.Y.Z.txt`, and `RELEASE_NOTES-vX.Y.Z.md`.

`npm run release:github:preflight` checks the publish blockers:

- GitHub CLI login.
- Clean git working tree.
- Remote tag availability.
- Existing portable build.
- GitHub asset size limit.
- Checksum file presence.

Create the GitHub Release after preflight passes:

```bash
gh release create v0.1.1 release/github/RiverMoon-AI-Studio-v0.1.1-portable.7z.* release/github/SHA256SUMS-v0.1.1.txt release/github/manifest-v0.1.1.json release/github/README-DOWNLOAD-v0.1.1.txt --repo MoonFlower-King/rivermoon-local-upscaler --title "RiverMoon AI Studio v0.1.1" --notes-file release/github/RELEASE_NOTES-v0.1.1.md
```

Before running that command, bump `package.json` to the target version and commit all release changes. Do not create a tag from a dirty working tree.

## GitHub Releases Update Button

The Settings page includes a manual update check button. It reads the current app version from `app.getVersion()`, asks the main process to check:

```text
https://api.github.com/repos/MoonFlower-King/rivermoon-local-upscaler/releases/latest
```

If GitHub returns 404 for latest Release, the app falls back to the latest tag:

```text
https://api.github.com/repos/MoonFlower-King/rivermoon-local-upscaler/tags?per_page=1
```

This is not silent auto-update. When a newer version is found, the app opens the GitHub Releases/Tags page through a main-process allowlist and the user downloads the new portable package manually.

For predictable customer updates:

- Bump `package.json` version before building.
- Build and verify `release\win-unpacked\`.
- Publish the full portable archive under GitHub Releases, not only a tag.
- Keep release tag names semver-like, for example `v0.1.1`.
- Do not ask customers to replace only the exe; they must replace the full portable directory.

`npm run agent:responses-smoke` posts a tiny request to `https://img.rivermoon7.com/v1/responses` without a Key and expects an authenticated JSON failure. Passing proves the production agent endpoint exists and still requires API login; it does not submit an authenticated GPT request or charge the account.

`npm run image:contract-smoke` builds the app, then fetches the public HTTPS image contract from `https://img.rivermoon7.com/v1/image/contract` without a Key. It parses the live contract with the same `image-protocol` code used by the desktop app and verifies `gpt-image-2`, 4K landscape/portrait sizes, high quality, PNG/JPEG output, generation/edit endpoints, reference-image support, and native size mode. It does not upload reference images, submit generation jobs, download generated images, or charge the account.

`npm run video:contract-smoke` builds the app, then fetches the public HTTPS video contract from `https://video.rivermoon7.com/v1/video/contract` without a Key. It parses the live contract with the same `video-protocol` code used by the desktop app, verifies enabled models, text-to-video, image-to-video, reference-to-video, top-level reference types, and `multi_reference` endpoint alias preservation. It does not upload files, submit jobs, poll jobs, download videos, or charge the account.

`npm run release:online-smoke` runs `agent:responses-smoke`, `image:contract-smoke`, and `video:contract-smoke`. Keep it separate from `release:verify` because it requires external network access and healthy production agent/image/video gateways. Passing this online smoke proves only unauthenticated endpoint/contract compatibility; it does not prove real Key authentication, GPT billing, image reference upload, paid image generation, video source upload, paid video generation, billing, refund handling, image/video download, or GUI behavior.

`npm run video:paid-e2e:dry-run` builds the app and runs `scripts/video-paid-e2e.mjs --dry-run`. It fetches the live HTTPS video contract, selects a model for the configured mode, validates local parameters with the production protocol parser, and exits before Key lookup, source upload, job submission, polling, download, or billing.

`npm run video:paid-e2e` is a manual paid release gate. It is intentionally excluded from `release:verify` because it can submit a real paid video job. It will not run unless all of the following are true:

- `RIVERMOON_API_KEY`, `RIVERMOON_RELAY_KEY`, or `RIVERMOON_KEY` is set.
- `RIVERMOON_PAID_VIDEO_E2E_CONFIRM=I_UNDERSTAND_THIS_SUBMITS_PAID_VIDEO_JOBS` is set exactly.
- `RIVERMOON_PAID_VIDEO_E2E_MODE` is one of `text_to_video`, `image_to_video`, `reference_to_video`, or `first_last_frame`.
- For image/reference modes, `RIVERMOON_PAID_VIDEO_E2E_SOURCE_PATHS` points to readable local reference images.

Useful optional variables:

- `RIVERMOON_PAID_VIDEO_E2E_MODEL`: force a production model id.
- `RIVERMOON_PAID_VIDEO_E2E_PROMPT`: override the default short prompt.
- `RIVERMOON_PAID_VIDEO_E2E_REFERENCE_TYPES`: comma-separated reference types for multi-reference runs.
- `RIVERMOON_PAID_VIDEO_E2E_OUTPUT_DIR`: where downloaded videos are saved.

The paid E2E script redacts Key material and signed URL query values from console output. A passing run proves the command-line production chain for the selected mode: HTTPS contract, optional source-cache upload, paid job submit, polling, download URL policy, binary validation, and local video save. It still does not replace packaged GUI click-through QA.

## Validation

After packaging, launch:

```text
D:\rivermoon-local-upscaler\release\win-unpacked\RiverMoon AI 创作台.exe
```

Verify:

- Window opens directly to the workspace.
- Only `网站同款 AI` is visible.
- Right-side status card can run CUDA detection.
- If `4x-UltraSharp.pth` is not already installed in user data, the model download card appears and can download/verify the model.
- Settings persist.
- Task records persist after close/reopen.
- Newest tasks appear first.
- Settings page `检查更新` can report current/latest version, handle missing GitHub Release gracefully, and open the allowed GitHub download page when a newer version exists.
- GPT 对话 can select `gpt-5.5` or another account chat model, stream a response through `img.rivermoon7.com/v1/responses`, and keep local conversation history.
- AI 生图 shows the same production image-site controls: GPT Image 2, 4K sizes, quality, output format, native output, custom size, reference upload, and storyboard templates.
- A sample image can run through ComfyUI and produce output.
- Successful job offers `对比` and `打开位置`.
- Compare modal supports zoom and pan.

If a development build is already running and blocks manual packaged-app launch through the single-instance lock, close the development window first. For automated smoke testing, use `RIVERMOON_USER_DATA_DIR` to isolate the packaged app user data, as `npm run release:launch-smoke` does.

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
- `4x-UltraSharp.pth` is not bundled in the current package; first-run download must be verified.
- `4x-UltraSharp.pth` license must be resolved before commercial customer distribution or clearly kept as user-initiated non-commercial model download.
