# RiverMoon 本地超分

> 一个 **完全本地运行** 的 Windows 图片超分（放大 / 高清化）桌面工具。
> 拖入图片即可用「网站同款 AI 链路」在本机处理，**不上传云端、不需要任何 API Key**。

![平台](https://img.shields.io/badge/platform-Windows%20x64-blue)
![许可](https://img.shields.io/badge/license-MIT-green)
![技术栈](https://img.shields.io/badge/Electron-React-blueviolet)

---

## ✨ 核心功能

- 🖼️ **本地超分**：基于 ComfyUI + PyTorch/CUDA + `4x-UltraSharp.pth`，效果对齐旧网页端「AI 高清」。
- 🔒 **隐私优先**：图片不出本机，内置 ComfyUI 仅监听 `127.0.0.1`。
- 📂 **批量处理**：支持单图、多选、整文件夹递归扫描。
- 🎚️ **可控输出**：PNG / JPEG / WebP；最大长边可调（默认 4096，填 `0` = 真实 4x）。
- 📊 **真实进度**：进度来自 ComfyUI 的 websocket 事件 / history 状态，不按时间伪造。
- 🗂️ **任务记录持久化**：关闭重开仍在，最新任务置顶，显示每个任务的耗时。
- 🔍 **前后对比**：成功任务支持滑块对比、滚轮缩放、拖动画面。
- 🩺 **自助诊断**：右侧资源 / CUDA 检测卡片，关于页可导出诊断日志。

## 🧱 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面外壳 | Electron 34 |
| 界面 | React 19 + TypeScript + Vite |
| 主进程 | Node.js（TypeScript，strict） |
| 图像处理 | sharp（libvips） |
| 推理引擎 | 内置 ComfyUI + PyTorch + CUDA |
| 超分模型 | 4x-UltraSharp.pth |

处理链路：

```text
LoadImage
  → UpscaleModelLoader(4x-UltraSharp.pth)
  → ImageUpscaleWithModel
  → ImageScale(Lanczos, 目标宽高)
  → SaveImage
```

## ⚙️ 环境要求

- Windows 10 / 11 x64
- **NVIDIA 显卡 + 可用 CUDA 驱动**（当前无 CPU / DirectML / AMD / Intel fallback）
- 开发：[Node.js](https://nodejs.org/) 20 LTS+、[Git](https://git-scm.com/)
- 本地一份 [ComfyUI](https://github.com/comfyanonymous/ComfyUI)（供准备脚本复制运行时）

## 🚀 快速开始（开发）

```bash
# 1. 克隆
git clone https://github.com/<your-name>/rivermoon-local-upscaler.git
cd rivermoon-local-upscaler

# 2. 安装依赖
npm install

# 3. （可选）配置本地环境变量
copy .env.example .env   # 然后按需修改

# 4. 准备 ComfyUI 运行时（体积大，不随仓库提供）
#    -SourceComfyUI 指向你本机已有的 ComfyUI 目录
powershell -ExecutionPolicy Bypass -File scripts/prepare-comfyui-runtime.ps1 -SourceComfyUI "本机ComfyUI路径"
#    并把 4x-UltraSharp.pth 放到：
#    resources/comfyui-runtime/models/upscale_models/4x-UltraSharp.pth

# 5. 启动开发模式
npm run dev:electron
```

> 💡 本机若设置了 `ELECTRON_RUN_AS_NODE=1`，开发必须用 `npm run dev:electron`
> （脚本会自动清掉该变量），否则 Electron 会以纯 Node 模式启动而看不到窗口。

## 📦 构建与打包

```bash
npm run build       # 类型检查 + 编译主进程/渲染层到 dist/
npm run dist:dir    # 生成免安装目录：release/win-unpacked/
npm run dist        # 生成 NSIS 安装包
```

> ⚠️ 打包产物体积较大（内置 ComfyUI/PyTorch/CUDA）。交付免安装版时需复制**整个**
> `release/win-unpacked/` 目录，不能只复制 exe。

## ⚙️ 配置说明

| 环境变量 | 作用 | 默认 |
| --- | --- | --- |
| `RIVERMOON_USE_EXTERNAL_COMFYUI` | 开发期复用外部 ComfyUI（`1` 开启） | `0` |
| `RIVERMOON_COMFYUI_URL` | 外部 ComfyUI 地址 | `http://127.0.0.1:8188` |
| `RIVERMOON_COMFYUI_ROOT` | 自定义 runtime 根目录 | 内置 `resources/comfyui-runtime` |

应用内可调：输出格式、最大长边、输出目录。详见 `.env.example` 与 [中文使用教程](docs/中文使用教程.md)。

## 📁 目录结构

```text
src/
  main/        Electron 主进程：IPC、任务队列、ComfyUI 引擎、硬件检测、持久化
  preload/     contextBridge 安全桥
  renderer/    React UI
scripts/       运行时准备 / 模型下载脚本
docs/          架构、构建、使用教程等文档
build/         应用图标
```

## 📖 使用教程

详见 [docs/中文使用教程.md](docs/中文使用教程.md) 与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## ⚖️ 开源协议

本项目**源代码**以 [MIT](LICENSE) 许可发布。

> ⚠️ **重要合规提示**：应用运行所依赖的第三方组件各有独立且更严格的许可，**不受 MIT 约束**：
> - ComfyUI → GPL-3.0
> - `4x-UltraSharp.pth` → CC-BY-NC-SA 4.0（**仅限非商业**）
> - CUDA 运行库 → NVIDIA EULA
>
> **任何商业分发前**，必须先解决上述授权（尤其替换非商业模型）。详见 [NOTICE](NOTICE)。

## 🤝 贡献

欢迎提 Issue 与 PR！请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
安全问题请走私密渠道，见 [SECURITY.md](SECURITY.md)。

## ❗ 已知限制

- 仅支持 Windows x64 + NVIDIA CUDA，暂无其它后端 fallback。
- 内置完整 ComfyUI/PyTorch/CUDA 时交付体积较大。
- 默认模型为非商业授权，商用前必须替换或取得授权。
