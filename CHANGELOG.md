# 更新日志（Changelog）

本文件记录所有重要变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增 Added
- 开源配套文件：`.gitignore`、`.env.example`、`LICENSE`(MIT)、`NOTICE`、
  `CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`，以及 `.github/` 下的
  Issue / PR 模板与 CI 工作流。

### 新增（优化迭代）
- 引入 `vitest` 单元测试与 `npm test`，覆盖 `sanitizeSettings` / `computeTargetDimensions` /
  任务记录归一化等纯函数；CI 增加测试步骤。
- 渲染层预览并发限流（最多 4 路）、`IntersectionObserver` 懒加载、LRU 缓存。
- 应用退出时清理内置 ComfyUI 子进程；新增单实例锁。

### 变更 Changed
- `README.md` 改写为标准开源文档（移除本机绝对路径，补充部署/依赖/授权说明）。
- `scripts/prepare-comfyui-runtime.ps1` 移除硬编码的个人 Python 路径，改为自动探测 + 参数传入。
- 任务持久化解耦：UI 广播与磁盘落盘分离，进度更新节流（≤1 次/500ms、异步）。
- `UpscaleSettings` 收敛为 `outputFormat/outputDirectory/maxSide`，模型与倍数改为产品常量。
- 「最大长边」语义改为**仅放大、绝不缩小**；按 EXIF 朝向归一化尺寸与预览。
- 抽离 `jobs-normalize.ts`（纯函数，便于测试）；ComfyUI 节点 id 收敛为 `NODE` 常量。
- `UpscalerApi` 接口单点定义，preload `satisfies` + `global.d.ts` 引用，杜绝漂移。
- `@vitejs/plugin-react` 移至 devDependencies；新增 `engines.node >= 20`。

### 安全 Security
- 主进程增加外部导航与新窗口拦截（`setWindowOpenHandler` / `will-navigate`），
  并为渲染层注入 `Content-Security-Policy`。
- 增加 IPC 入参基础校验与主进程全局异常兜底。
- 渲染层启用 `sandbox`（需打包后冒烟验证）。

### 修复 Fixed
- 任务记录改**原子写**（tmp + rename），修复写入途中崩溃导致 `jobs.json` 损坏丢失的风险。
- 任务结束后清理复制进 ComfyUI input 目录的临时输入文件，修复磁盘占用持续增长的问题。
- 窗口加载失败兜底（`showErrorBox`）；渲染层 `ErrorBoundary` 防白屏；弹窗支持 Esc 关闭。
- 移除大量死代码（`upscaler-engine` / `engine-errors` 及 `paths`/`image` 未用导出等）。

## [0.1.0] - 2026-06-28

### 新增 Added
- 首个内部交付版本：本地「网站同款 AI」超分链路
  （ComfyUI + PyTorch/CUDA + 4x-UltraSharp.pth）。
- 中文界面、拖拽/文件夹递归导入、PNG/JPEG/WebP 输入输出。
- 任务队列、取消、进度（来自 ComfyUI 真实事件）、任务记录持久化、前后对比缩放。
- 右侧资源/CUDA 检测卡片、关于页、诊断日志导出。

[Unreleased]: https://github.com/<your-name>/rivermoon-local-upscaler/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/<your-name>/rivermoon-local-upscaler/releases/tag/v0.1.0
