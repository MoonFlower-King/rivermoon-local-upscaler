# Changelog

本文件记录面向用户和贡献者的重要变化，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

### Security

- 主窗口导航校验改为按 URL 解析比较：开发态精确比较 origin（防 `http://127.0.0.1:5173@evil.com` 绕过），打包态只允许渲染层入口文件。

### Changed

- `package-lock.json` 依赖下载地址统一为 npm 官方源，避免受限网络与 CI 无法访问镜像源。

## [0.2.0] - 2026-07-18

### Added

- AI 视频：HTTPS 能力合同、文生/图生/多参考图、任务恢复与本地下载。
- GPT 对话：Responses 流式输出、推理强度、图片分析和本机历史。
- AI 生图实时合同、参考图编辑、自定义尺寸、原生直出与分镜模板。
- AI 生图会话式工作台：独立会话列表、会话内任务流、提交即出现的多任务卡片，以及结果图一键继续编辑。
- GitHub 开源配套：中英文 README、贡献/安全/支持文档、CodeQL、Dependabot、CODEOWNERS。
- `npm run repo:preflight`：检查待公开文件、Git 历史大对象、密钥痕迹和生成物。
- 超分处理模式扩展为五档：网站 AI 高清修复（UltraSharp 工作流）、AI+网页增强、仅网页增强（秒级 sharp 链）、SUPIR 扩散修复（快速×1.5 / 高清×4 双强度，需本机 SUPIR 环境）、智能模式（GPT 看图自动分流，未连接 Key 自动回退本地链路）。
- 超分模型注册表新增 RealESRGAN x4plus 与 RealESRGAN Anime6B（均 BSD-3 可商用，按需下载 + SHA256 校验）。
- 任务记录支持逐条删除（不删除输出文件）。

### Changed

- 产品定位从单功能本地超分更新为 RiverMoon AI 创作台。
- 新用户默认进入 AI 生图，已使用用户恢复上次模块。
- 生图工作区升级为左侧会话列表、右侧任务时间线和底部参数区的双栏布局，并保留创作舞台替换边界。
- 旧版平铺生图记录升级后自动归入「历史生成」会话；删除会话仅解除任务关联，不删除已有任务。
- 安装包和 Git 仓库均不包含 `4x-UltraSharp.pth`；模型由用户主动下载。
- 公开文档明确区分本地超分与云端 AI 模块的数据边界。

### Security

- API Key 仅在 Electron 主进程中使用，并通过 `safeStorage` 加密保存。
- 视频签名 URL 不进入任务持久化和诊断文本。
- 公开仓库预检阻止常见凭据、大文件、用户数据和运行时目录误提交。

## [0.1.0] - 2026-06-28

### Added

- 首个内部 Windows 版本。
- 本地 ComfyUI/CUDA 图片超分、任务队列、真实进度、持久化和前后对比。
- RiverMoon API Key、账户状态、AI 生图和资产库基础能力。

[Unreleased]: https://github.com/MoonFlower-King/rivermoon-local-upscaler/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/MoonFlower-King/rivermoon-local-upscaler/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MoonFlower-King/rivermoon-local-upscaler/releases/tag/v0.1.0
