# Codex Desktop 交接文档

## 项目一句话

`RiverMoon AI 创作台` 是连接 `rivermoon7.com` 的 Windows 桌面创作应用，当前包含：

- AI 生图
- AI 视频
- GPT 对话与图片分析
- 本地图片超分
- 资产库、账户、诊断和 GitHub 更新

本地超分使用用户自己的 NVIDIA/CUDA 显卡，图片不上传。AI 生图、AI 视频和 GPT 对话是云端能力，必须通过主进程连接 RiverMoon 中转站并使用用户自己的 API Key。

## 工作目录

```text
D:\rivermoon-local-upscaler
```

请只在这个目录继续处理。旧 Web 项目可用于核对网站合同和链路，但不参与桌面版构建。

## 当前交付产物

```text
D:\rivermoon-local-upscaler\release\win-unpacked\RiverMoon AI 创作台.exe
```

交付时复制整个 `release\win-unpacked\` 目录，不能只复制 exe。

## 当前产品决策

- 不得删除或隐藏 AI 生图、AI 视频、GPT 对话等云端模块。
- 新用户默认进入 AI 生图；已使用过的用户恢复上次所在模块。
- 生图工作区保持“参数/参考素材”和“创作舞台”分离，为后续无限画布替换创作舞台预留边界。
- RiverMoon Key 由主进程和 `safeStorage` 保管，渲染层不得接触明文 Key。
- 生图和视频的模型、尺寸、能力与限制必须由实时合同驱动，不能在 UI 中伪造能力。
- 本地超分固定使用网站同款 AI 工作流，不重新接回 Pro、SUPIR、Vulkan/NCNN 等旧入口。
- 本地任务与云端任务记录都必须持久化，真实状态、真实计时、真实进度优先。

## 本地超分链路

```text
LoadImage
-> UpscaleModelLoader(4x-UltraSharp.pth)
-> ImageUpscaleWithModel
-> ImageScale(Lanczos, target width/height)
-> SaveImage
```

默认最大长边 `4096`，贴近网页端历史输出；选择真实 4x 时不限制长边。模型权重不随安装包分发，由用户在应用内自行下载。

## 云端链路

```text
Renderer
-> preload IPC
-> Electron main process
-> RiverMoon image/video/agent gateway
-> local asset/task persistence
-> renderer event update
```

渲染层不直接请求网络。图片、视频和对话请求分别由主进程 adapter 处理，并使用图片合同、HTTPS 视频合同和 Responses 流式事件约束行为。

## 重要源码位置

```text
src/main/main.ts                    Electron 主进程、IPC、账户、诊断与更新
src/main/cloud/image-gen.ts         RiverMoon 生图网关
src/main/cloud/image-protocol.ts    图片合同、参数与参考图校验
src/main/cloud/image-queue.ts       生图任务与持久化
src/main/cloud/video-gen.ts         RiverMoon 视频网关
src/main/cloud/video-protocol.ts    视频合同、参数与参考图校验
src/main/cloud/video-queue.ts       视频任务与持久化
src/main/cloud/agent-gen.ts         GPT/Responses 流式网关
src/main/cloud/agent-protocol.ts    对话请求与事件协议
src/main/comfy-engine.ts            本地 ComfyUI 启动与真实进度
src/main/job-queue.ts               本地超分任务队列
src/main/model-downloader.ts        4x-UltraSharp 按需下载与校验
src/renderer/main.tsx               React UI 与全部工作区
src/renderer/styles.css             响应式浅色/深色界面
resources/comfyui-runtime           内置 ComfyUI + Python/PyTorch/CUDA runtime
```

旧轻量超分文件仍是遗留代码，不是当前产品入口，不要重新接回。

## 验证命令

每次改代码至少执行：

```bash
npm run build
npm run lint
npm test
```

生成交付目录并验证：

```bash
npm run dist:dir
npm run release:smoke
npm run release:launch-smoke
```

人工回归至少覆盖 AI 生图、AI 视频、GPT 对话、资产库、设置、本地超分，以及关闭重开后的任务记录。

## 已知限制

- 本地超分需要 NVIDIA/CUDA；当前没有 CPU、DirectML、AMD/Intel fallback。
- `4x-UltraSharp.pth` 为非商业授权，商业发版前必须完成授权确认或替换模型。
- 完整 ComfyUI/PyTorch/CUDA runtime 体积较大。
- 未代码签名的 Windows 安装包会提示未知发布者。
- 真实付费生图/视频和 GPT E2E 需要有效 RiverMoon Key，自动化测试不能代替人工付费链路验收。
