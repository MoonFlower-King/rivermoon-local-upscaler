# RiverMoon AI Studio Product Report / RiverMoon AI 创作台产品报告

Version: v0.1.0  
Report date: 2026-07-08  
Product scope: Windows desktop app, local image upscaling, AI image generation, AI video generation, GPT chat, asset library, settings, diagnostics, manual update check.

---

## 中文版

### 1. 执行摘要

RiverMoon AI 创作台是 RiverMoon 桌面创作工具的当前 Windows 版本。产品核心目标是把网站 AI 图片增强中的高频 GPU 推理迁移到用户自己的 NVIDIA 显卡上运行，从而降低生产服务器远程显卡消耗，同时保留 RiverMoon 云端账户能力，让用户在同一个桌面应用内完成图片超分、AI 生图、AI 视频、GPT 对话和资产管理。

当前版本已经具备灰度候选版基础：

1. 本地图片超分链路已固定为 ComfyUI + PyTorch/CUDA + `4x-UltraSharp.pth`。
2. 本地超分不需要 RiverMoon API Key，不上传图片。
3. AI 生图、AI 视频、GPT 对话通过 RiverMoon 网关接入，需要用户 API Key。
4. 任务记录、本地资产、诊断日志和版本更新检查已经接入桌面工作流。
5. 打包版已经通过结构 smoke、启动 smoke、lint、test、build 等自动化验证。

当前不应对外宣称为完全商业消费级版本。原因包括：

1. 真实视频付费 E2E 仍需用户 Key 和真实参考图验收。
2. 网站 AI 与桌面输出尚未完成正式同图差分报告。
3. `4x-UltraSharp.pth` 存在非商业授权风险，当前通过用户自下载降低分发风险，但正式商业发布仍需法律确认。
4. Windows 代码签名未完成，用户可能看到未知发布者提示。

---

### 2. 产品定位

一句话定位：

```text
RiverMoon AI 创作台是一款整合本地 AI 图片超分与 RiverMoon 云端 AI 创作能力的 Windows 桌面应用。
```

产品边界：

| 模块 | 执行位置 | 价值 | 当前状态 |
| --- | --- | --- | --- |
| 图片超分 | 用户本机 | 减少 RiverMoon 生产 GPU 消耗，保护原图隐私 | 已实现 |
| AI 生图 | RiverMoon 图片网关 | 延伸网站生图能力到桌面端 | 已接入，需真实 Key GUI 验收 |
| AI 视频 | RiverMoon 视频网关 | 提供桌面端视频生成入口 | 首版接入，真实付费 E2E 未闭环 |
| GPT 对话 | RiverMoon Agent 网关 | 提供创作辅助、图片分析、提示词优化 | 已接入，需真实 Key GUI 验收 |
| 资产库 | 本机 | 统一管理超分、生图、视频产物 | 首版实现 |
| 设置/诊断 | 本机 + GitHub | Key、更新、诊断、发布支持 | 已实现 |

产品不是：

1. 通用 ComfyUI 工作台。
2. 单纯网页壳。
3. 全模型本地运行工具。
4. 面向所有显卡的通用超分工具。

---

### 3. 用户价值

#### 3.1 对普通用户

1. 打开软件直接进入工作区，不需要理解 ComfyUI。
2. 拖入图片即可在本机处理。
3. 本地超分不上传原图。
4. 成功后可以前后对比、打开位置、继续处理。
5. 连接 RiverMoon Key 后，可在同一个应用内使用生图、视频和 GPT。

#### 3.2 对 RiverMoon 业务

1. 将图片高清修复的 GPU 成本从生产 worker 迁移到用户本机。
2. 桌面端成为 RiverMoon Key 用户的长期入口。
3. 资产库把本地超分、云端生图、云端视频串成连续工作流。
4. 余额、充值、模型合同和任务失败提示形成消费闭环。
5. GitHub Release 更新按钮提供后续版本分发基础。

#### 3.3 对支持团队

1. 诊断日志包含版本、runtime、CUDA、模型、网关状态。
2. Key、签名 URL、敏感路径会脱敏。
3. 任务状态可持久化，方便复盘用户问题。
4. 发布脚本能检查 GitHub Release 发包风险。

---

### 4. 功能范围

#### 4.1 图片超分

当前链路：

```text
LoadImage
-> UpscaleModelLoader(4x-UltraSharp.pth)
-> ImageUpscaleWithModel
-> ImageScale(Lanczos, target width/height)
-> SaveImage
```

核心特性：

1. 支持 PNG/JPG/WebP 输入。
2. 固定网站同款 AI 链路，不暴露 SUPIR、DiffBIR、NCNN/Vulkan 等旧入口。
3. 默认最大长边 4096。
4. 支持真实 4x。
5. 支持自定义最大长边。
6. 真实 ComfyUI 进度，不按时间伪造百分比。
7. 支持任务持久化。
8. 支持前后对比、缩放、拖动。
9. 缺少模型时显示下载入口。

#### 4.2 AI 生图

云端能力：

```text
https://img.rivermoon7.com/v1/image/contract
https://img.rivermoon7.com/v1/images/generations
https://img.rivermoon7.com/v1/images/edits
```

能力：

1. 读取线上图片合同。
2. 展示模型、尺寸、质量、格式、原生输出和自定义尺寸。
3. 支持参考图编辑。
4. 支持分镜模板。
5. 生成图保存到本地资产库。
6. 生图产物可以继续本地超分。

#### 4.3 AI 视频

云端能力：

```text
https://video.rivermoon7.com/v1/video/contract
```

能力：

1. 读取 HTTPS 实时合同。
2. 支持文生视频、图生视频、多参考图视频。
3. 合同不支持的模式保持门控。
4. 上传参考图到 source-cache。
5. 任务提交、轮询、下载和恢复。
6. 停止同步时明确提示远端可能仍在处理或计费。
7. 外部 CDN 下载不携带 RiverMoon Key。
8. 签名 URL 不进入持久化诊断。

当前限制：

1. 首尾帧模式在当前生产合同中未开放。
2. 真实付费文生、图生、多参考图 E2E 仍需真实 Key 验收。

#### 4.4 GPT 对话

云端能力：

```text
https://img.rivermoon7.com/v1/responses
```

能力：

1. 文本对话。
2. 图片分析。
3. 模型选择。
4. 推理强度选择。
5. 流式输出。
6. 取消输出。
7. 本机历史会话。

#### 4.5 资产库

统一展示：

1. 本地超分输出。
2. AI 生图输出。
3. AI 视频输出。

支持：

1. 预览。
2. 打开文件位置。
3. 图片继续超分。

#### 4.6 设置、诊断和更新

能力：

1. API Key 连接、校验、清除。
2. 余额和模型数量展示。
3. 诊断日志导出。
4. 手动检查 GitHub 更新。
5. 打开 GitHub Release 下载页。

更新机制：

```text
GitHub releases/latest
fallback: GitHub tags?per_page=1
```

当前是手动下载更新，不是静默自动更新。

---

### 5. 技术架构

#### 5.1 桌面架构

```text
React Renderer
-> Electron preload typed IPC
-> Electron main process
-> Local queues / cloud adapters / file system / diagnostics
```

关键原则：

1. 渲染层不直接接触明文 API Key。
2. 渲染层不直接读取任意本地文件。
3. 主进程负责路径白名单、文件选择、任务提交、网络请求和日志。
4. 本地超分与云端生成任务都有持久化记录。

#### 5.2 本地超分架构

```text
Renderer drag/drop or file picker
-> main process job queue
-> managed ComfyUI on 127.0.0.1:18188
-> prompt submission
-> websocket progress/history polling
-> output copy/metadata
-> job persistence
```

#### 5.3 云端能力架构

```text
Renderer form
-> IPC
-> main process contract parser
-> main process gateway client
-> RiverMoon gateway
-> result download
-> local asset library
```

#### 5.4 数据存储

本机用户数据包括：

```text
settings.json
jobs.json
image-tasks.json
video-tasks.json
logs\
assets\
```

敏感数据策略：

1. API Key 优先使用 Electron safeStorage。
2. 诊断日志脱敏。
3. 视频签名 URL query 不持久化。
4. 外部下载不携带认证头。

---

### 6. 发布与分发

当前交付物：

```text
release\win-unpacked\
```

必须交付完整目录，不能只交付 exe。

GitHub Release 分发策略：

1. 由于完整 runtime 约 6GB，不能作为单个 GitHub asset 上传。
2. 使用 7-Zip 分卷，每个分卷默认 1900MB。
3. 上传全部 `.7z.001`、`.7z.002` 等分卷。
4. 同时上传 `SHA256SUMS`、`manifest`、`README-DOWNLOAD`。
5. Release notes 由脚本生成。

脚本：

```bash
npm run release:verify
npm run release:github:assets
npm run release:github:preflight
```

预检会阻止：

1. GitHub CLI 未登录。
2. git 工作区未提交。
3. tag 已存在。
4. 交付目录缺失。
5. 单个 asset 超过 2GiB。

---

### 7. 验证状态

当前已通过：

| 验证 | 状态 |
| --- | --- |
| `npm run lint` | 通过 |
| `npm test` | 21 files / 206 tests 通过 |
| `npm run build` | 通过 |
| `npm run dist:dir` | 通过 |
| `npm run release:smoke` | 149 pass / 3 warning |
| `npm run release:launch-smoke` | 通过 |
| GitHub metadata dry run | 通过 |

仍需人工或真实环境验证：

1. 打包版 GUI 完整点击回归。
2. 本地超分同图与网站输出差分。
3. 真实 Key 生图 GUI 回归。
4. 真实 Key GPT 对话回归。
5. 真实付费视频文生、图生、多参考图 E2E。
6. 模型授权确认。
7. Windows 代码签名。

---

### 8. 风险与限制

| 风险 | 影响 | 当前处理 |
| --- | --- | --- |
| CUDA/NVIDIA 依赖 | 非 NVIDIA 用户无法使用本地超分 | 明确系统要求 |
| 包体约 6GB | GitHub 单包上传不可行 | 7-Zip 分卷 |
| 未签名 exe | Windows 可能提示未知发布者 | 发布说明中明确 |
| 4x-UltraSharp 授权风险 | 商业发布法律风险 | 模型不内置，用户自下载；仍需法务确认 |
| 网站效果一致性未完成同图差分 | 不能承诺 100% 一样 | 文档禁止过度宣传 |
| 真实视频 E2E 未闭环 | 视频商业可用性未完全证明 | 保留为发布阻断项 |
| API Key 泄露风险 | 高风险安全问题 | 主进程持有、渲染层掩码、诊断脱敏 |

---

### 9. 路线图建议

短期：

1. 完成 GitHub CLI 登录、版本号更新、tag 和 Release 发布。
2. 安装 7-Zip，生成真实 GitHub 分卷资产。
3. 做打包版 GUI 人工回归。
4. 做网站与桌面同图差分。
5. 完成真实 Key 生图/GPT/视频验收。

中期：

1. 替换或授权可商用超分模型。
2. 完成 Windows 代码签名。
3. 增加更清晰的下载页和用户更新流程。
4. 改进资产库筛选、删除、搜索。
5. 建立崩溃报告和支持工单流程。

长期：

1. 静默自动更新。
2. 可商用模型体系。
3. 更多视频渠道。
4. 企业白标配置。
5. 多语言 UI。

---

### 10. 对外表述建议

推荐表述：

```text
RiverMoon 桌面版支持本地 AI 图片超分和云端 AI 创作。图片超分在用户自己的 Windows 电脑上运行，使用本机 NVIDIA 显卡处理，图片不上传云端；连接 RiverMoon 账户后，还可以生成图片和短视频，并自动保存到本机资产库。
```

谨慎表述：

```text
本地超分链路已按 RiverMoon 网站 AI 高清修复 worker 的 ComfyUI 工作流实现，默认使用 4x-UltraSharp 和 4096 长边策略。
```

禁止表述：

1. “100% 和网站完全一样”。
2. “所有电脑都能用”。
3. “不需要任何环境”。
4. “所有 AI 能力都本地运行”。
5. “AI 生图和 AI 视频不上传任何数据”。
6. “模型可商用无风险”。
7. “首尾帧视频已正式开放”。
8. “正式商业消费级完成”。

---

## English Version

### 1. Executive Summary

RiverMoon AI Studio is the current Windows desktop version of the RiverMoon creative workstation. Its primary goal is to move high-frequency AI image enhancement workloads from RiverMoon production GPUs to the user's own NVIDIA GPU, while keeping RiverMoon cloud account features available inside the same desktop app.

The app currently supports local image upscaling, AI image generation, AI video generation, GPT chat, asset management, diagnostics, and manual update checks.

The current version is suitable as an internal or gray-release candidate:

1. The local image upscaling chain is fixed to ComfyUI + PyTorch/CUDA + `4x-UltraSharp.pth`.
2. Local upscaling does not require a RiverMoon API Key and does not upload images.
3. AI image, AI video, and GPT chat connect to RiverMoon gateways and require a user API Key.
4. Job history, local assets, diagnostics, and manual update checks are integrated.
5. Packaged builds have passed structure smoke, launch smoke, lint, tests, and build checks.

It should not yet be marketed as a fully commercial consumer release because:

1. Real paid AI video E2E still requires real user Key and reference-image validation.
2. Website-vs-desktop same-image diff verification is not complete.
3. `4x-UltraSharp.pth` has non-commercial license risk. The current build avoids bundling it directly, but commercial distribution still needs legal review.
4. Windows code signing is not complete.

---

### 2. Product Positioning

One-line positioning:

```text
RiverMoon AI Studio is a Windows desktop app that combines local AI image upscaling with RiverMoon cloud creation services.
```

Product boundaries:

| Module | Runtime | Value | Current Status |
| --- | --- | --- | --- |
| Image upscaling | User's local machine | Reduce RiverMoon production GPU cost and keep source images local | Implemented |
| AI image generation | RiverMoon image gateway | Bring website image generation to desktop | Integrated, real Key GUI validation pending |
| AI video | RiverMoon video gateway | Desktop video-generation entry point | First version integrated, paid E2E pending |
| GPT chat | RiverMoon Agent gateway | Creative assistant, image analysis, prompt refinement | Integrated, real Key GUI validation pending |
| Asset library | Local machine | Unified output management | First version implemented |
| Settings/diagnostics | Local + GitHub | Key, update, diagnostics, release support | Implemented |

The product is not:

1. A general-purpose ComfyUI workstation.
2. A simple web wrapper.
3. A fully local model suite.
4. A universal upscaler for all GPUs.

---

### 3. User Value

#### 3.1 End Users

1. Open the app directly into a workspace.
2. Drag images to process locally.
3. Local upscaling does not upload source images.
4. Compare before/after, reveal output files, and continue processing.
5. Connect a RiverMoon Key to use image generation, video generation, and GPT chat in the same app.

#### 3.2 RiverMoon Business

1. Moves image enhancement GPU cost from production workers to user devices.
2. Makes the desktop app a long-term entry point for RiverMoon Key users.
3. Connects local upscaling, cloud image generation, and cloud video generation into one workflow.
4. Balance display, recharge guidance, model contracts, and failure states create a clearer consumption loop.
5. GitHub Release update checks establish a foundation for version distribution.

#### 3.3 Support Team

1. Diagnostics include version, runtime, CUDA, model, and gateway status.
2. Keys, signed URLs, and sensitive paths are redacted.
3. Persistent task history helps investigate user issues.
4. Release scripts identify GitHub publishing risks before upload.

---

### 4. Feature Scope

#### 4.1 Image Upscaling

Current chain:

```text
LoadImage
-> UpscaleModelLoader(4x-UltraSharp.pth)
-> ImageUpscaleWithModel
-> ImageScale(Lanczos, target width/height)
-> SaveImage
```

Core features:

1. PNG/JPG/WebP input.
2. Fixed website-matching AI chain.
3. No SUPIR, DiffBIR, NCNN/Vulkan, or legacy entries.
4. Default max side 4096.
5. True 4x mode.
6. Custom max side.
7. Real ComfyUI progress, no time-based fake progress.
8. Persistent job history.
9. Before/after compare with zoom and pan.
10. In-app model download when missing.

#### 4.2 AI Image Generation

Cloud endpoints:

```text
https://img.rivermoon7.com/v1/image/contract
https://img.rivermoon7.com/v1/images/generations
https://img.rivermoon7.com/v1/images/edits
```

Capabilities:

1. Reads live image contract.
2. Shows models, sizes, quality, format, native output, and custom size controls.
3. Supports reference-image editing.
4. Supports storyboard templates.
5. Saves generated results to the local asset library.
6. Sends generated images to local upscaling.

#### 4.3 AI Video

Cloud contract:

```text
https://video.rivermoon7.com/v1/video/contract
```

Capabilities:

1. Reads HTTPS live contract.
2. Supports text-to-video, image-to-video, and multi-reference video when enabled by contract.
3. Keeps unsupported modes gated.
4. Uploads reference images to source-cache.
5. Handles submit, poll, download, and resume.
6. Clearly states that stopping local sync may not cancel the remote job.
7. Does not send RiverMoon Key to external CDN downloads.
8. Does not persist signed URL query strings.

Current limitations:

1. First/last frame is not enabled in the current production contract.
2. Real paid E2E for text/image/multi-reference video remains pending.

#### 4.4 GPT Chat

Cloud endpoint:

```text
https://img.rivermoon7.com/v1/responses
```

Capabilities:

1. Text chat.
2. Image analysis.
3. Model selection.
4. Reasoning effort selection.
5. Streaming output.
6. Cancel current response.
7. Local conversation history.

#### 4.5 Asset Library

Shows:

1. Local upscale outputs.
2. AI image outputs.
3. AI video outputs.

Actions:

1. Preview.
2. Reveal in folder.
3. Continue image upscaling.

#### 4.6 Settings, Diagnostics, Updates

Capabilities:

1. API Key connection, validation, and clearing.
2. Balance and model count display.
3. Diagnostic export.
4. Manual GitHub update check.
5. Open GitHub Release download page.

Update check:

```text
GitHub releases/latest
fallback: GitHub tags?per_page=1
```

This is manual download, not silent auto-update.

---

### 5. Technical Architecture

#### 5.1 Desktop Architecture

```text
React Renderer
-> Electron preload typed IPC
-> Electron main process
-> Local queues / cloud adapters / file system / diagnostics
```

Core principles:

1. Renderer never receives the plain API Key.
2. Renderer cannot read arbitrary local files.
3. Main process owns path allowlists, file selection, task submission, network calls, and logging.
4. Local and cloud tasks are persisted.

#### 5.2 Local Upscaling Architecture

```text
Renderer drag/drop or file picker
-> main process job queue
-> managed ComfyUI on 127.0.0.1:18188
-> prompt submission
-> websocket progress/history polling
-> output copy/metadata
-> job persistence
```

#### 5.3 Cloud Feature Architecture

```text
Renderer form
-> IPC
-> main process contract parser
-> main process gateway client
-> RiverMoon gateway
-> result download
-> local asset library
```

#### 5.4 Data Storage

Local user data includes:

```text
settings.json
jobs.json
image-tasks.json
video-tasks.json
logs\
assets\
```

Sensitive data policy:

1. API Key uses Electron safeStorage where available.
2. Diagnostics are redacted.
3. Signed video URL query strings are not persisted.
4. External downloads do not carry authentication headers.

---

### 6. Release And Distribution

Current deliverable:

```text
release\win-unpacked\
```

The full folder must be distributed. The exe alone is not sufficient.

GitHub Release strategy:

1. The full runtime is about 6GB, so it cannot be uploaded as one GitHub Release asset.
2. Use multipart 7-Zip archives, 1900MB per part by default.
3. Upload every `.7z.001`, `.7z.002`, etc. part.
4. Upload `SHA256SUMS`, `manifest`, and `README-DOWNLOAD`.
5. Release notes are generated by script.

Scripts:

```bash
npm run release:verify
npm run release:github:assets
npm run release:github:preflight
```

Preflight blocks:

1. GitHub CLI is not logged in.
2. Git working tree is dirty.
3. Tag already exists.
4. Portable build is missing.
5. Any single asset exceeds 2GiB.

---

### 7. Validation Status

Passed:

| Check | Status |
| --- | --- |
| `npm run lint` | Passed |
| `npm test` | 21 files / 206 tests passed |
| `npm run build` | Passed |
| `npm run dist:dir` | Passed |
| `npm run release:smoke` | 149 pass / 3 warnings |
| `npm run release:launch-smoke` | Passed |
| GitHub metadata dry run | Passed |

Still pending:

1. Full packaged GUI manual regression.
2. Website-vs-desktop same-image diff.
3. Real Key image-generation GUI validation.
4. Real Key GPT chat validation.
5. Real paid video E2E for text/image/multi-reference modes.
6. Model licensing review.
7. Windows code signing.

---

### 8. Risks And Limitations

| Risk | Impact | Current Handling |
| --- | --- | --- |
| NVIDIA/CUDA dependency | Non-NVIDIA users cannot use local upscaling | Clear system requirements |
| Around 6GB package | Single GitHub asset upload is not possible | Multipart 7-Zip assets |
| Unsigned exe | Windows may show unknown publisher | Release notes disclose it |
| 4x-UltraSharp license risk | Legal risk for commercial distribution | Model is not bundled; user-initiated download; legal review still needed |
| Website output parity not formally proven | Cannot claim 100% identical output | Overclaiming is prohibited |
| Real video E2E pending | Commercial video readiness not fully proven | Kept as release blocker |
| API Key leakage risk | High security impact | Main-process key use, masked renderer state, redacted diagnostics |

---

### 9. Roadmap Recommendations

Short term:

1. Log in to GitHub CLI, bump version, create tag, and publish Release.
2. Install 7-Zip and generate real multipart GitHub assets.
3. Complete packaged GUI manual regression.
4. Complete website-vs-desktop same-image diff.
5. Complete real Key validation for image, GPT, and video.

Mid term:

1. Replace or license a commercially safe upscaling model.
2. Complete Windows code signing.
3. Improve user-facing download and update flow.
4. Add asset filtering, deletion, and search.
5. Establish crash reporting and support workflow.

Long term:

1. Silent auto-update.
2. Commercial model registry.
3. More video channels.
4. Enterprise white-label configuration.
5. Multilingual UI.

---

### 10. Recommended External Messaging

Recommended:

```text
RiverMoon Desktop supports local AI image upscaling and RiverMoon cloud AI creation. Image upscaling runs on the user's Windows machine with an NVIDIA GPU and does not upload source images. After connecting a RiverMoon account, users can also generate images and short videos, with results saved to the local asset library.
```

Cautious:

```text
The local upscaling chain is implemented to match the RiverMoon website AI enhancement worker workflow as closely as currently verified, using 4x-UltraSharp and the default 4096 longest-side policy.
```

Do not claim:

1. "100% identical to the website."
2. "Works on every computer."
3. "No environment required."
4. "All AI features run locally."
5. "AI image and AI video do not upload any data."
6. "The model is commercially risk-free."
7. "First/last-frame video is officially available."
8. "Fully commercial consumer release is complete."
