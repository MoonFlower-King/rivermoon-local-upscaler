<div align="center">
  <img src="build/icon.png" width="88" alt="RiverMoon" />
  <h1>RiverMoon AI 创作台</h1>
  <p>连接 RiverMoon 云端 AI 能力与用户本机 NVIDIA 显卡的 Windows 桌面创作应用。</p>

  [English](README.en.md) · [用户指南](docs/USER_GUIDE_BILINGUAL.md) · [产品报告](docs/PRODUCT_REPORT_BILINGUAL.md)

  [![CI](https://github.com/MoonFlower-King/rivermoon-local-upscaler/actions/workflows/ci.yml/badge.svg)](https://github.com/MoonFlower-King/rivermoon-local-upscaler/actions/workflows/ci.yml)
  [![CodeQL](https://github.com/MoonFlower-King/rivermoon-local-upscaler/actions/workflows/codeql.yml/badge.svg)](https://github.com/MoonFlower-King/rivermoon-local-upscaler/actions/workflows/codeql.yml)
  [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
  ![Platform](https://img.shields.io/badge/platform-Windows%20x64-blue.svg)
</div>

## 产品边界

RiverMoon AI 创作台包含云端创作能力和本地 GPU 工具，两类能力的数据边界不同：

| 模块 | 执行位置 | 是否需要 RiverMoon API Key | 用户内容是否上传 |
| --- | --- | --- | --- |
| AI 生图 | RiverMoon 图片网关 | 是 | 提示词和参考图会发送到云端 |
| AI 视频 | RiverMoon 视频网关 | 是 | 提示词和参考图会发送到云端 |
| GPT 对话与图片分析 | RiverMoon Agent 网关 | 是 | 对话和图片附件会发送到云端 |
| 图片超分 | 用户本机 ComfyUI/CUDA | 否 | 否 |
| 图片超分 · 智能模式（可选） | 分流判定走云端，处理仍在本机 | 是 | 会把缩小的预览图（512 长边）发送到云端做类型判定 |

超分默认完全本地离线。只有用户主动选择「智能模式」时，才会把一张 512 长边的预览图发给云端 GPT 判定图片类型（照片/插画/文字），随后的图像处理仍全部在本机完成；未连接 Key 或云端不可达时自动回退纯本地链路。

本仓库开源的是 Windows 桌面客户端。`rivermoon7.com` 托管服务及其服务端实现不包含在本仓库中；使用云端模块需要用户自行获取 API Key。

## 功能

- AI 生图：实时图片合同、模型/质量/格式/尺寸、参考图编辑、自定义尺寸和分镜模板。
- AI 视频：HTTPS 实时合同、文生视频、图生视频、多参考图、任务恢复和本地下载。
- GPT 对话：Responses 流式输出、推理强度、图片分析和本机对话历史。
- 本地超分：ComfyUI + PyTorch/CUDA，五种处理模式（网站 AI 高清修复 / AI+网页增强 / 仅网页增强 / SUPIR 扩散修复 / GPT 智能分流），多模型注册表（4x-UltraSharp、RealESRGAN x4plus、RealESRGAN Anime6B）按需下载，默认最大长边 4096。
- 资产库：统一查看生图、视频和超分产物。
- 账户与更新：API Key 安全存储、余额、充值入口、诊断和 GitHub Release 更新检查。

## 安全架构

```text
React renderer
  -> typed contextBridge IPC
  -> Electron main process
      -> RiverMoon image/video/agent gateways
      -> local ComfyUI on 127.0.0.1
      -> local task and asset persistence
```

- 渲染层不直接访问网络，也不接触明文 API Key。
- API Key 由 Electron 主进程使用 `safeStorage` 加密保存。
- 本地文件读取受主进程路径白名单约束。
- 视频认证请求只访问 HTTPS 网关；外部 CDN 下载不携带 API Key。
- 诊断输出会清理 Key、签名 URL 和本机路径等敏感信息。

更多信息见 [SECURITY.md](SECURITY.md)。

## 源码快速开始

### 前置条件

- Windows 10/11 x64
- Node.js 20 或更高版本
- Git
- 完整测试本地超分时需要 NVIDIA 显卡、CUDA 驱动和本机 ComfyUI/PyTorch 运行时

### 安装与检查

```powershell
git clone https://github.com/MoonFlower-King/rivermoon-local-upscaler.git
cd rivermoon-local-upscaler
npm ci
npm run check
```

`npm run check` 会执行公开仓库预检、格式检查、lint、全量单元测试（237+ 项）和生产构建。源码构建不需要下载数 GB 的 ComfyUI 运行时。

### 启动桌面开发环境

```powershell
npm run dev:electron
```

云端模块可在应用设置页连接用户自己的 RiverMoon API Key。本地超分需要先准备运行时：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-comfyui-runtime.ps1 `
  -SourceComfyUI "D:\ComfyUI"
```

仓库和安装包都不提交 `4x-UltraSharp.pth`。应用会在用户主动操作后下载并校验模型。该模型存在非商业授权限制，详见 [NOTICE](NOTICE)。

## 环境变量

应用不会自动加载 `.env` 文件。需要开发测试变量时，请在当前 PowerShell 会话显式设置：

```powershell
$env:RIVERMOON_TEST_KEY = "your-development-key"
npm run dev:electron
```

不要把真实 Key 写进脚本、Issue、PR、截图或日志。完整变量说明见 [.env.example](.env.example)。

## 构建 Windows 交付目录

```powershell
npm run dist:dir
npm run release:smoke
npm run release:launch-smoke
```

输出目录：

```text
release/win-unpacked/
```

必须分发整个目录，不能只复制 exe。完整运行时约数 GB，因此 GitHub Release 使用分卷 7-Zip 资产；见 [构建与发布文档](docs/BUILD_AND_RELEASE.md)。

## 开源仓库约束

以下内容必须留在 Git 仓库之外：

- `resources/comfyui-runtime/`
- 模型权重，如 `.pth`、`.safetensors`、`.onnx`
- `release/`、`dist/`、`release-check/`
- `.local-user-data/`、日志、任务记录和本机资产
- `.env*`、API Key、签名 URL、代码签名证书

推送前运行：

```powershell
npm run repo:preflight
```

发布 tag 前使用严格模式：

```powershell
npm run repo:preflight:strict
```

详细清单见 [开源发布检查表](docs/OPEN_SOURCE_RELEASE_CHECKLIST.md)。

## 文档

- [用户指南（中英双语）](docs/USER_GUIDE_BILINGUAL.md)
- [产品报告（中英双语）](docs/PRODUCT_REPORT_BILINGUAL.md)
- [架构](docs/ARCHITECTURE.md)
- [贡献指南](CONTRIBUTING.md)
- [支持渠道](SUPPORT.md)
- [第三方授权](NOTICE)

## 许可证

本仓库中由项目贡献者编写的源码采用 [MIT License](LICENSE)。第三方运行时、模型权重、托管服务和品牌资产受各自条款约束，不因本仓库采用 MIT 而自动获得相同授权。
