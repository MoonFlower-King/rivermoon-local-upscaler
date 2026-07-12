# RiverMoon AI Studio User Guide / RiverMoon AI 创作台用户使用指南

Version: v0.1.0  
Document date: 2026-07-08  
Product: RiverMoon AI 创作台 for Windows  
Package type: portable `win-unpacked` folder

---

## 中文版

### 1. 产品简介

RiverMoon AI 创作台是一款 Windows 桌面应用，面向需要处理图片、生成图片、生成视频和使用 GPT 对话的 RiverMoon 用户。

它包含两类能力：

| 能力 | 执行位置 | 是否需要 API Key | 是否上传用户内容 |
| --- | --- | --- | --- |
| 图片超分 | 用户本机 NVIDIA/CUDA | 否 | 否 |
| AI 生图 | RiverMoon 图片网关 | 是 | prompt 和参考图会发送云端 |
| AI 视频 | RiverMoon 视频网关 | 是 | prompt 和参考图会发送云端 |
| GPT 对话 | RiverMoon Agent/Responses 网关 | 是 | 对话文本和图片附件会发送云端 |

最核心的本地超分链路是：

```text
ComfyUI + PyTorch/CUDA + 4x-UltraSharp.pth
```

默认输出尺寸策略是最大长边 4096，贴近 RiverMoon 网站历史 AI 增强输出。用户也可以选择真实 4x 输出。

重要说明：

1. 本地图片超分不上传图片。
2. AI 生图、AI 视频、GPT 对话是云端能力，会连接 RiverMoon 服务。
3. 当前版本需要 NVIDIA 显卡和 CUDA，不支持 AMD、Intel、CPU、DirectML fallback。
4. 当前 exe 未代码签名，Windows 可能提示未知发布者。

---

### 2. 安装与启动

#### 2.1 从 GitHub Release 下载

GitHub Release 可能使用分卷压缩包发布，文件名类似：

```text
RiverMoon-AI-Studio-v0.1.0-portable.7z.001
RiverMoon-AI-Studio-v0.1.0-portable.7z.002
RiverMoon-AI-Studio-v0.1.0-portable.7z.003
...
```

下载要求：

1. 下载全部 `.7z.001`、`.7z.002`、`.7z.003` 等分卷。
2. 所有分卷放在同一个文件夹。
3. 使用 7-Zip 打开 `.7z.001`。
4. 解压得到完整 `win-unpacked` 文件夹。

不要只下载或复制 exe。软件必须依赖完整目录运行。

#### 2.2 启动软件

进入解压后的目录：

```text
win-unpacked\
```

双击：

```text
RiverMoon AI 创作台.exe
```

如果 Windows 提示未知发布者，这是因为当前版本未签名。确认来源是官方 GitHub Release 后，可以继续运行。

---

### 3. 系统要求

最低建议环境：

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / Windows 11 |
| 显卡 | NVIDIA 显卡 |
| 驱动 | 支持 CUDA 的 NVIDIA 驱动 |
| 磁盘空间 | 建议预留 10GB 以上 |
| 内存 | 建议 16GB 以上 |
| 网络 | 本地超分不需要网络；AI 生图、AI 视频、GPT 对话和模型下载需要网络 |

本地超分依赖内置 ComfyUI/PyTorch/CUDA runtime。完整包体较大，这是正常情况。

---

### 4. 首次使用流程

1. 解压完整 `win-unpacked` 文件夹。
2. 启动 `RiverMoon AI 创作台.exe`。
3. 软件打开后默认进入“图片超分”工作区。
4. 查看右上角或右侧状态提示，确认运行环境是否正常。
5. 如果提示缺少模型，点击模型下载卡片中的“下载模型”。
6. 下载完成后，拖入图片开始本地超分。

模型说明：

- 当前本地超分模型为 `4x-UltraSharp.pth`。
- 模型约 67MB。
- 软件会校验 SHA256。
- 当前发布包不内置该模型，避免把非商业授权权重直接打进安装包。

---

### 5. 图片超分

#### 5.1 添加图片

支持三种方式：

1. 把图片拖入工作区。
2. 点击“添加图片”选择文件。
3. 点击“添加文件夹”递归扫描文件夹中的图片。

支持格式：

```text
PNG
JPG / JPEG
WebP
```

#### 5.2 输出设置

当前 AI 超分固定使用网站同款链路，输出格式固定为 PNG。

输出尺寸有三种策略：

| 模式 | 说明 | 适合场景 |
| --- | --- | --- |
| 贴近网页版 | 最大长边 4096 | 希望接近网站历史输出 |
| 真实 4x | 不限制尺寸，按模型真实放大 | 需要最大尺寸、能接受更慢处理 |
| 自定义长边 | 输出最长边不超过输入值 | 需要控制文件大小或输出规格 |

默认输出目录：

```text
原图同级目录\upscaled\
```

也可以在右侧设置中选择固定输出目录。

#### 5.3 开始处理

1. 添加图片后，底部会显示待处理数量。
2. 点击“开始处理 N 张”。
3. 任务会进入队列。
4. 运行中显示真实进度和已用时间。
5. 完成后显示耗时、输出尺寸、文件大小和操作按钮。

#### 5.4 任务记录

任务记录会持久化保存。关闭软件后再打开，历史任务仍然存在。

任务状态包括：

| 状态 | 含义 |
| --- | --- |
| 等待中 | 已加入队列，等待处理 |
| 运行中 | 正在由本机 ComfyUI 处理 |
| 成功 | 已生成输出文件 |
| 失败 | 处理失败，可查看错误原因 |
| 已取消 | 用户取消或上次关闭时任务未完成 |

#### 5.5 前后对比

成功任务可点击“对比”：

1. 拖动滑块查看处理前后。
2. 滚轮或按钮缩放。
3. 放大后拖动画面查看细节。
4. 点击重置恢复默认视图。

---

### 6. AI 生图

AI 生图是云端能力，需要 RiverMoon API Key。

#### 6.1 连接账户

1. 打开“设置”。
2. 在“中转站账户”输入 API Key。
3. 点击“连接”。
4. 连接成功后，侧栏会显示余额、掩码 Key 和可用模型数量。

安全说明：

- 明文 Key 只在主进程中使用。
- 渲染层只看到掩码 Key。
- 诊断日志不会导出明文 Key。

#### 6.2 生成图片

进入“AI 生图”模块后：

1. 选择模型。
2. 输入提示词。
3. 选择尺寸、质量、输出格式。
4. 如需参考图，点击上传参考图。
5. 点击生成。
6. 成功后图片会保存到本机资产库。

当前桌面端会读取 RiverMoon 图片合同，展示站点同款能力，例如：

- GPT Image 2。
- 4K 横图/竖图尺寸。
- 质量选项。
- PNG/JPEG/WebP 输出。
- 原生直出。
- 自定义尺寸。
- 参考图编辑。
- 分镜模板。

#### 6.3 参考图编辑

上传参考图后，桌面端会走图片编辑链路。

注意：

1. 参考图会发送到 RiverMoon 图片网关。
2. 参考图顺序会保留。
3. 提示词中可使用类似 `@图1` 的引用方式。

#### 6.4 生图结果继续超分

生图完成后，可以在结果卡或资产库中点击“超分到 4K”。软件会把生成图送入本地超分队列。

---

### 7. AI 视频

AI 视频是云端能力，需要 RiverMoon API Key。

#### 7.1 视频模式

当前 UI 按生产合同门控，只有合同支持的模式才能提交。

常见模式：

| 模式 | 说明 |
| --- | --- |
| 文生视频 | 只输入 prompt 生成视频 |
| 图生视频 | 上传一张参考图生成视频 |
| 多参考图视频 | 上传多张参考图，并设置参考类型 |
| 首尾帧 | 仅在生产合同开放后可用 |

当前生产合同未开放首尾帧时，软件不会允许提交该模式。

#### 7.2 提交视频任务

1. 打开“AI 视频”。
2. 等待合同同步。
3. 选择模型、模式、比例、时长、分辨率。
4. 输入 prompt。
5. 按模式上传参考图。
6. 点击生成。

视频任务通常需要等待较长时间。任务卡会显示远端 job 状态、同步状态、输出文件和失败原因。

#### 7.3 停止同步与恢复

如果本地停止同步，远端任务可能仍在处理或计费。软件会明确提示，不会把本地停止伪装成远端取消。

可恢复任务可以点击恢复同步，软件只会继续轮询和下载，不会重复提交付费任务。

---

### 8. GPT 对话

GPT 对话需要 RiverMoon API Key。

功能包括：

1. 文本对话。
2. 图片分析。
3. 历史对话。
4. 模型选择。
5. 推理强度选择。
6. 流式输出。
7. 取消当前输出。

图片输入说明：

- 图片会在本地压缩后发送到 Agent/Responses 网关。
- 图片附件适合用于分析、描述、改写提示词等任务。

---

### 9. 资产库

资产库统一展示本机生成或处理的结果。

包括：

1. 本地超分输出。
2. AI 生图结果。
3. AI 视频结果。

常用操作：

| 操作 | 说明 |
| --- | --- |
| 预览 | 查看图片或视频 |
| 打开位置 | 在文件管理器中定位输出文件 |
| 超分到 4K | 对图片产物继续本地超分 |

---

### 10. 设置

设置页包含：

1. RiverMoon API Key 连接。
2. 版本更新检查。
3. 关于面板。
4. 诊断日志导出入口。

#### 10.1 检查更新

点击“检查更新”后，软件会请求 GitHub Release：

```text
https://api.github.com/repos/MoonFlower-King/rivermoon-local-upscaler/releases/latest
```

如果没有 Release，会回退检查最新 tag。

当前更新方式是手动下载：

1. 软件提示有新版本。
2. 点击“打开下载页”。
3. 从 GitHub Release 下载新包。
4. 解压后替换完整 `win-unpacked` 文件夹。

当前不做静默自动更新。

#### 10.2 导出诊断

遇到问题时，可在关于面板导出诊断日志。诊断内容包括：

- 应用版本。
- Electron / Node 版本。
- ComfyUI runtime 状态。
- 模型状态。
- CUDA 检测结果。
- 视频网关检测结果。
- 最近日志。

诊断不会包含明文 API Key。

---

### 11. 常见问题

#### 11.1 为什么提示缺少环境？

请确认你启动的是完整 `win-unpacked` 目录中的 exe，而不是单独复制出来的 exe。

完整目录中应该包含：

```text
resources\
resources\app.asar
resources\comfyui-runtime\
```

#### 11.2 为什么提示 CUDA 不可用？

当前版本需要 NVIDIA/CUDA。请尝试：

1. 更新 NVIDIA 驱动。
2. 关闭占用显存的软件。
3. 重启软件。
4. 在状态卡中重新检测。

#### 11.3 为什么图片处理很慢？

速度取决于：

1. 显卡性能。
2. 输入图片尺寸。
3. 是否首次启动 ComfyUI。
4. 是否选择真实 4x。
5. 显存是否被其他软件占用。

#### 11.4 为什么网站和桌面效果看起来不同？

需要确认：

1. 是否使用同一张输入图。
2. 是否使用同一尺寸策略。
3. 是否对比的是网站“AI 增强”而不是其他生图/修复链路。
4. 输出是否被网页或聊天工具二次压缩。
5. 本地模型 SHA256 是否正确。

当前版本不能承诺和网站 100% 完全一致。需要通过同图、同模型、同尺寸策略和差分验证确认。

#### 11.5 为什么 AI 生图或视频失败？

常见原因：

1. API Key 未连接。
2. API Key 无效。
3. 余额不足。
4. 网络无法访问 RiverMoon 网关。
5. 上游模型临时繁忙。
6. 参考图格式或大小不符合要求。

请查看任务卡错误提示，必要时导出诊断日志。

#### 11.6 为什么没有 AMD / Intel / CPU 支持？

当前本地超分链路固定为 ComfyUI + PyTorch/CUDA，目标是复刻生产 worker 的 NVIDIA/CUDA 链路。AMD、Intel、CPU、DirectML fallback 不在当前版本范围内。

---

### 12. 隐私与数据说明

本地超分：

```text
图片不上传云端。
任务在本机执行。
输出保存在本机。
```

AI 生图：

```text
prompt 会发送到 RiverMoon 图片网关。
参考图会上传到 RiverMoon 图片网关。
生成结果下载并保存到本机。
```

AI 视频：

```text
prompt 会发送到 RiverMoon 视频网关。
参考图会上传到 source-cache。
视频结果下载并保存到本机。
```

GPT 对话：

```text
对话文本会发送到 RiverMoon Agent/Responses 网关。
图片附件会发送到云端模型。
```

API Key：

```text
明文 Key 不展示在界面中。
诊断日志会脱敏。
```

---

## English Version

### 1. Product Overview

RiverMoon AI Studio is a Windows desktop app for image upscaling, AI image generation, AI video generation, and GPT chat.

It provides two kinds of capabilities:

| Capability | Runs On | API Key Required | User Content Upload |
| --- | --- | --- | --- |
| Image upscaling | Local NVIDIA/CUDA machine | No | No |
| AI image generation | RiverMoon image gateway | Yes | Prompts and reference images are uploaded |
| AI video generation | RiverMoon video gateway | Yes | Prompts and reference images are uploaded |
| GPT chat | RiverMoon Agent/Responses gateway | Yes | Text and image attachments are uploaded |

The local upscaling chain is:

```text
ComfyUI + PyTorch/CUDA + 4x-UltraSharp.pth
```

The default output policy limits the longest side to 4096 pixels, matching the historical RiverMoon website output more closely. Users can also choose true 4x output.

Important notes:

1. Local image upscaling does not upload images.
2. AI image, AI video, and GPT chat are cloud features connected to RiverMoon services.
3. The current version requires NVIDIA/CUDA and does not support AMD, Intel, CPU, or DirectML fallback.
4. The executable is currently unsigned, so Windows may show an unknown publisher warning.

---

### 2. Installation And Launch

#### 2.1 Download From GitHub Release

The GitHub Release may be published as multipart 7-Zip archives:

```text
RiverMoon-AI-Studio-v0.1.0-portable.7z.001
RiverMoon-AI-Studio-v0.1.0-portable.7z.002
RiverMoon-AI-Studio-v0.1.0-portable.7z.003
...
```

Download rules:

1. Download every `.7z.001`, `.7z.002`, `.7z.003`, etc. file.
2. Keep all parts in the same folder.
3. Open `.7z.001` with 7-Zip.
4. Extract the complete `win-unpacked` folder.

Do not download or copy only the exe. The app requires the full folder.

#### 2.2 Launch

Open the extracted folder:

```text
win-unpacked\
```

Double-click:

```text
RiverMoon AI 创作台.exe
```

If Windows warns about an unknown publisher, it means this build is not code-signed. Continue only if the package came from the official GitHub Release.

---

### 3. System Requirements

Recommended environment:

| Item | Requirement |
| --- | --- |
| OS | Windows 10 / Windows 11 |
| GPU | NVIDIA GPU |
| Driver | NVIDIA driver with CUDA support |
| Disk | At least 10GB free space recommended |
| Memory | 16GB or higher recommended |
| Network | Not required for local upscaling; required for AI image, AI video, GPT chat, and model download |

The local upscaler ships with an embedded ComfyUI/PyTorch/CUDA runtime, so the package size is large by design.

---

### 4. First-Time Workflow

1. Extract the full `win-unpacked` folder.
2. Launch `RiverMoon AI 创作台.exe`.
3. The app opens directly to the Image Upscale workspace.
4. Check the runtime status indicator.
5. If the model is missing, click "Download Model".
6. After the model is installed, drag images into the workspace.

Model notes:

- The local upscaling model is `4x-UltraSharp.pth`.
- The model is about 67MB.
- The app verifies SHA256 after download.
- The model is not bundled in the package to avoid distributing non-commercial weights directly.

---

### 5. Image Upscaling

#### 5.1 Add Images

You can:

1. Drag images into the workspace.
2. Click "Add Images".
3. Click "Add Folder" to recursively scan a folder.

Supported formats:

```text
PNG
JPG / JPEG
WebP
```

#### 5.2 Output Settings

The current AI upscaling chain is fixed to the website-matching workflow. Output format is fixed to PNG.

Output size modes:

| Mode | Description | Best For |
| --- | --- | --- |
| Website-like | Longest side limited to 4096 | Matching historical website output |
| True 4x | No max-side limit | Maximum resolution, slower processing |
| Custom max side | Longest side is capped by user value | Controlling output size |

Default output folder:

```text
Same folder as the source image\upscaled\
```

You can also choose a fixed output folder.

#### 5.3 Start Processing

1. Add images.
2. Confirm the pending count.
3. Click "Start Processing".
4. Jobs enter the local queue.
5. Running jobs show real progress and elapsed time.
6. Finished jobs show duration, output dimensions, file size, and actions.

#### 5.4 Job History

Job history is persisted locally and remains after restart.

Job states:

| State | Meaning |
| --- | --- |
| Queued | Waiting in queue |
| Running | Being processed by local ComfyUI |
| Succeeded | Output file created |
| Failed | Failed with readable error |
| Cancelled | Cancelled by user or stopped during previous shutdown |

#### 5.5 Compare Before / After

For successful jobs, click "Compare":

1. Drag the slider to compare before and after.
2. Use mouse wheel or buttons to zoom.
3. Drag the zoomed image to inspect details.
4. Reset to return to the default view.

---

### 6. AI Image Generation

AI image generation is a cloud feature and requires a RiverMoon API Key.

#### 6.1 Connect Account

1. Open Settings.
2. Paste your API Key under the account section.
3. Click Connect.
4. After connection, the sidebar shows balance, masked key, and available model count.

Security notes:

- Plain API Key is only used in the main process.
- The renderer only receives a masked key.
- Diagnostic logs do not export the plain key.

#### 6.2 Generate Images

In the AI Image module:

1. Select a model.
2. Enter a prompt.
3. Choose size, quality, and output format.
4. Upload reference images if needed.
5. Click Generate.
6. Results are saved to the local asset library.

The desktop app reads the RiverMoon image contract and exposes website-matching controls, including:

- GPT Image 2.
- 4K landscape and portrait sizes.
- Quality options.
- PNG/JPEG/WebP output.
- Native output mode.
- Custom size.
- Reference-image editing.
- Storyboard templates.

#### 6.3 Reference Image Editing

When reference images are attached, the app uses the image editing pathway.

Notes:

1. Reference images are uploaded to the RiverMoon image gateway.
2. Reference order is preserved.
3. Prompts may refer to images with syntax such as `@Image 1`.

#### 6.4 Upscale Generated Images

After image generation succeeds, click "Upscale to 4K" from the result card or Asset Library to send the generated image into the local upscaling queue.

---

### 7. AI Video

AI video is a cloud feature and requires a RiverMoon API Key.

#### 7.1 Video Modes

The UI is controlled by the live production contract. Only supported modes can be submitted.

Common modes:

| Mode | Description |
| --- | --- |
| Text to video | Generate video from prompt only |
| Image to video | Generate video from one reference image |
| Multi-reference video | Generate video from multiple typed reference images |
| First/last frame | Available only if production contract enables it |

If the production contract does not expose first/last frame, the app will not allow submitting that mode.

#### 7.2 Submit A Video Job

1. Open AI Video.
2. Wait for contract sync.
3. Select model, mode, aspect ratio, duration, and resolution.
4. Enter prompt.
5. Upload reference images when required.
6. Click Generate.

Video jobs may take longer. The task card shows remote job state, sync status, output file, and failure reason.

#### 7.3 Stop Sync And Resume

If local sync is stopped, the remote job may still be processing or charging. The app makes this explicit and does not pretend local stop equals remote cancellation.

Recoverable jobs can be resumed. Resume only polls/downloads the existing remote job and does not submit a duplicate paid task.

---

### 8. GPT Chat

GPT Chat requires a RiverMoon API Key.

Features:

1. Text chat.
2. Image analysis.
3. Local conversation history.
4. Model selection.
5. Reasoning effort selection.
6. Streaming response.
7. Cancel current response.

Image input notes:

- Images are compressed locally before upload.
- Image attachments are useful for analysis, description, and prompt rewriting.

---

### 9. Asset Library

The Asset Library shows locally saved outputs:

1. Local upscale outputs.
2. AI image results.
3. AI video results.

Common actions:

| Action | Description |
| --- | --- |
| Preview | View image or video |
| Reveal in folder | Open output location in file explorer |
| Upscale to 4K | Send image output to local upscale queue |

---

### 10. Settings

Settings include:

1. RiverMoon API Key connection.
2. Version update check.
3. About panel.
4. Diagnostic export.

#### 10.1 Check For Updates

Click "Check Updates". The app checks GitHub Releases:

```text
https://api.github.com/repos/MoonFlower-King/rivermoon-local-upscaler/releases/latest
```

If no Release exists, it falls back to the latest tag.

Current update flow is manual:

1. The app detects a newer version.
2. Click "Open Download Page".
3. Download the new package from GitHub Release.
4. Extract and replace the full `win-unpacked` folder.

Silent auto-update is not implemented.

#### 10.2 Export Diagnostics

When reporting problems, export diagnostics from the About panel.

Diagnostics include:

- App version.
- Electron / Node versions.
- ComfyUI runtime status.
- Model status.
- CUDA probe result.
- Video gateway diagnostics.
- Recent logs.

Diagnostics do not include the plain API Key.

---

### 11. FAQ

#### 11.1 Why does the app say the environment is missing?

Make sure you launched the exe from the full `win-unpacked` folder, not a copied standalone exe.

The full folder should contain:

```text
resources\
resources\app.asar
resources\comfyui-runtime\
```

#### 11.2 Why is CUDA unavailable?

The current version requires NVIDIA/CUDA. Try:

1. Update NVIDIA driver.
2. Close other GPU-heavy apps.
3. Restart the app.
4. Run the status check again.

#### 11.3 Why is image processing slow?

Speed depends on:

1. GPU performance.
2. Input image size.
3. First ComfyUI startup cost.
4. Whether true 4x output is selected.
5. Other software using VRAM.

#### 11.4 Why does desktop output look different from the website?

Check:

1. Same input image.
2. Same output size policy.
3. Whether the website comparison uses the same AI enhance path rather than another generation/repair path.
4. Whether the output was compressed by browser, chat, or upload tools.
5. Whether local model SHA256 is correct.

The current version does not claim 100% identical output. It requires same-image, same-model, same-size, and diff verification.

#### 11.5 Why did AI image or video fail?

Common causes:

1. API Key not connected.
2. Invalid API Key.
3. Insufficient balance.
4. Network cannot reach RiverMoon gateway.
5. Upstream model is temporarily busy.
6. Reference image format or size is invalid.

Check the task card error and export diagnostics if needed.

#### 11.6 Why is AMD / Intel / CPU not supported?

The local upscaling chain is fixed to ComfyUI + PyTorch/CUDA to match the production NVIDIA/CUDA worker chain. AMD, Intel, CPU, and DirectML fallback are out of scope for this version.

---

### 12. Privacy And Data Notes

Local upscaling:

```text
Images are not uploaded.
Processing runs locally.
Outputs are saved locally.
```

AI image generation:

```text
Prompts are sent to the RiverMoon image gateway.
Reference images are uploaded to the RiverMoon image gateway.
Generated results are downloaded and saved locally.
```

AI video:

```text
Prompts are sent to the RiverMoon video gateway.
Reference images are uploaded to source-cache.
Video outputs are downloaded and saved locally.
```

GPT chat:

```text
Chat text is sent to the RiverMoon Agent/Responses gateway.
Image attachments are sent to the cloud model.
```

API Key:

```text
The plain key is not shown in the UI.
Diagnostics redact sensitive values.
```
