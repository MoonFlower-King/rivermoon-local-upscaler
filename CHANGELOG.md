# Changelog

本文件记录面向用户和贡献者的重要变化，格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/)。

## [Unreleased]

### Added

- AI 视频：HTTPS 能力合同、文生/图生/多参考图、任务恢复与本地下载。
- GPT 对话：Responses 流式输出、推理强度、图片分析和本机历史。
- AI 生图实时合同、参考图编辑、自定义尺寸、原生直出与分镜模板。
- GitHub 开源配套：中英文 README、贡献/安全/支持文档、CodeQL、Dependabot、CODEOWNERS。
- `npm run repo:preflight`：检查待公开文件、Git 历史大对象、密钥痕迹和生成物。

### Changed

- 产品定位从单功能本地超分更新为 RiverMoon AI 创作台。
- 新用户默认进入 AI 生图，已使用用户恢复上次模块。
- 生图工作区拆分为参数/参考素材区与创作舞台，为无限画布预留边界。
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

[Unreleased]: https://github.com/MoonFlower-King/rivermoon-local-upscaler/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MoonFlower-King/rivermoon-local-upscaler/releases/tag/v0.1.0
