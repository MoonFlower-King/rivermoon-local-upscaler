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

## 当前验收状态

- `npm run build` 通过。
- 当前产品只保留网站同款 AI。
- Pro/SUPIR/轻量 Vulkan 入口已移除。

## 真实剩余待办

1. 用真实客户样图和网页端结果做观感对比，确认默认 `4096` 是否足够接近旧网站。
2. 解决 `4x-UltraSharp.pth` 商业授权，或替换为可商用模型。
3. 代码签名安装包和 exe。
4. 在不同 NVIDIA 显卡/驱动版本机器上测试。
5. 如果必须覆盖弱 GPU/无 NVIDIA 机器，再评估 DirectML/CPU fallback。

## 不要接回

- Pro / DiffBIR。
- SUPIR。
- 轻量 Vulkan / NCNN。
- 自动时间估算进度。
