# Implementation Plan

本文档记录当前实现状态和后续真实待办。早期 MVP/P0/P1/P2 中的大部分产品化任务已经完成，不要重复实现。

## 已完成

- Electron + React + TypeScript + Vite 桌面应用。
- 中文 macOS 浅色工具界面。
- 打开软件直接进入工作区。
- 右侧小卡片显示资源/CUDA 检测。
- 图片文件检测、文件夹递归扫描。
- ComfyUI CUDA runtime 集成。
- `4x-UltraSharp.pth` 网站同款模型链路。
- PNG/JPEG/WebP 输入输出。
- 输出目录选择。
- 最大长边控制，默认 `4096`，填 `0` 真实 4x。
- 设置持久化。
- 任务队列、取消、清空已结束任务、打开输出位置。
- 任务记录持久化，关闭重开仍保留。
- 最新任务显示在最前。
- 每个任务显示已用时间/总耗时，并写入持久化记录。
- ComfyUI websocket / history 真实进度同步。
- 前后对比预览，支持缩放和拖动。
- 关于页、诊断日志写入、打开日志目录、导出诊断日志。
- 品牌图标和 `electron-builder` 图标配置。
- AI 生图云端队列、Key 管理、账户状态、资产库落盘。
- AI 生图站点对齐：读取 `img.rivermoon7.com/v1/image/contract`，支持模型标签、4K 尺寸、质量、格式、原生直出、自定义尺寸、参考图编辑和分镜模板。
- GPT 对话：接入 `img.rivermoon7.com/v1/responses`，使用同一 API Key 登录体系，支持模型选择、推理强度、流式输出、本机历史和图片分析输入。
- AI 视频首版：生产 HTTPS 合同、文生/图生/多参考图模式、参考图 source-cache、远端任务提交/轮询/下载。
- AI 视频任务持久化、远端任务恢复、停止同步、recent 合并、下载失败恢复。
- 视频下载安全策略：认证请求只走 HTTPS 网关，外部 CDN 不带 Key，签名 URL 不进入持久化和诊断。
- 视频发布门禁：`release:smoke`、`release:launch-smoke`、`release:online-smoke`、`video:paid-e2e:dry-run`、`video:paid-e2e`。

## 当前验收状态

- `npm run build` 通过。
- `npm run lint` 通过。
- `npm test` 通过：21 个测试文件，206 个测试。
- 图片合同实测可解析：`2026-06-07.phase1`，4 个模型；`gpt-image-2` 支持 4K、High、PNG/JPEG/WebP、20 张参考图、原生直出。
- `npm run release:online-smoke` 通过：生产视频合同可解析；当前 `first_last_frame=0`。
- `npm run video:paid-e2e:dry-run` 通过：只校验生产合同和本地参数，不读取 Key、不上传、不计费。
- `npm run release:verify` 通过：打包、release smoke、launch smoke 通过；仍有代码签名、模型下载、真实付费视频 E2E 警告。
- 当前产品只保留网站同款 AI。
- Pro/SUPIR/轻量 Vulkan 入口已移除。

## 真实剩余待办

1. 用真实客户样图和网页端结果做观感对比，确认默认 `4096` 是否足够接近旧网站。
2. 解决 `4x-UltraSharp.pth` 商业授权，或替换为可商用模型。
3. 代码签名安装包和 exe。
4. 在不同 NVIDIA 显卡/驱动版本机器上测试。
5. 如果必须覆盖弱 GPU/无 NVIDIA 机器，再评估 DirectML/CPU fallback。
6. 使用真实 Key 跑 `npm run video:paid-e2e` 文生视频，确认提交、轮询、下载、可播放。
7. 使用真实 Key 和真实参考图跑 `npm run video:paid-e2e` 图生视频与多参考图视频。
8. 打包版 GUI 人工回归 AI 视频：合同同步、禁用原因、任务记录、下载预览、资产库。
9. 真实 Key 生图 GUI 点击链路再次验收：4K PNG、参考图编辑、自定义尺寸、分镜模板。
10. 真实 Key GPT 对话 GUI 点击链路验收：文本对话、图片分析、模型切换、推理强度和取消流式输出。

## 不要接回

- Pro / DiffBIR。
- SUPIR。
- 轻量 Vulkan / NCNN。
- 自动时间估算进度。
