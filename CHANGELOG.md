# 更新日志（Changelog）

本文件记录所有重要变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增 Added
- 开源配套文件：`.gitignore`、`.env.example`、`LICENSE`(MIT)、`NOTICE`、
  `CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`，以及 `.github/` 下的
  Issue / PR 模板与 CI 工作流。

### 变更 Changed
- `README.md` 改写为标准开源文档（移除本机绝对路径，补充部署/依赖/授权说明）。
- `scripts/prepare-comfyui-runtime.ps1` 移除硬编码的个人 Python 路径，改为自动探测 + 参数传入。

### 安全 Security
- 主进程增加外部导航与新窗口拦截（`setWindowOpenHandler` / `will-navigate`），
  并为渲染层注入 `Content-Security-Policy`。
- 增加 IPC 入参基础校验与主进程全局异常兜底。

### 修复 Fixed
- 任务结束后清理复制进 ComfyUI input 目录的临时输入文件，修复磁盘占用持续增长的问题。
- 移除若干死代码（未使用的 `deleteIfExists` 等）。

## [0.1.0] - 2026-06-28

### 新增 Added
- 首个内部交付版本：本地「网站同款 AI」超分链路
  （ComfyUI + PyTorch/CUDA + 4x-UltraSharp.pth）。
- 中文界面、拖拽/文件夹递归导入、PNG/JPEG/WebP 输入输出。
- 任务队列、取消、进度（来自 ComfyUI 真实事件）、任务记录持久化、前后对比缩放。
- 右侧资源/CUDA 检测卡片、关于页、诊断日志导出。

[Unreleased]: https://github.com/<your-name>/rivermoon-local-upscaler/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/<your-name>/rivermoon-local-upscaler/releases/tag/v0.1.0
