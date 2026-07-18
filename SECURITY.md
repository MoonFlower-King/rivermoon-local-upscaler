# 安全策略

## 支持范围

项目处于早期阶段，只为最新 GitHub Release 和 `main` 分支提供安全修复。历史版本可能不会回补。

## 私密报告漏洞

不要为安全漏洞创建公开 Issue。请使用：

[GitHub Security Advisory](https://github.com/MoonFlower-King/rivermoon-local-upscaler/security/advisories/new)

报告应尽量包含受影响版本、复现步骤、影响范围和建议缓解方式。请不要发送真实用户 API Key、付费账户凭据或无关私人内容。

## 数据与信任边界

| 模块 | 执行位置 | 会发送的内容 |
| --- | --- | --- |
| AI 生图 | RiverMoon 图片网关 | 提示词、模型参数和用户选择的参考图 |
| AI 视频 | RiverMoon 视频网关 | 提示词、模型参数和用户选择的参考图 |
| GPT 对话 | RiverMoon Agent 网关 | 对话文本、推理参数和用户添加的图片附件 |
| 图片超分 | 用户本机 | 不上传原图；本机 ComfyUI 仅监听回环地址 |
| 图片超分 · 智能模式（可选） | 判定走云端，处理在本机 | 仅一张缩小到 512 长边的预览图（用于类型判定），不上传原图 |

云端模块需要用户自己的 RiverMoon API Key。本地超分不需要 Key；智能模式是超分模块中唯一的可选云端步骤，需要 Key，未配置或云端不可达时自动回退纯本地链路。

## 客户端安全措施

- 明文 API Key 只存在于 Electron 主进程，使用 `safeStorage` 加密落盘。
- Renderer 通过 `contextBridge` 使用类型化 IPC，不直接访问网络或 Node.js。
- 主进程限制新窗口、外部导航和可读取的本地路径。
- 视频认证请求只发往允许的 HTTPS 网关；外部 CDN 下载不附带 Key。
- 签名下载 URL 不写入任务持久化和诊断文本。
- 诊断输出会清理 Key、URL 查询凭据和本机路径；分享前仍应人工复核。
- 本地 ComfyUI 绑定 `127.0.0.1`，不应对局域网公开。

## 凭据处理

- 不要把 Key 写进 `.env` 并提交到 Git。
- 不要在 Issue、PR、截图、终端录屏或日志中展示 Key。
- 在聊天、日志或公开渠道中出现过的 Key 应立即撤销并更换。
- 付费 E2E 只能由维护者在受控环境中手动运行。

## 不属于安全漏洞的情况

普通安装、CUDA 配置、模型下载、余额或合同同步问题请使用 [Discussions](https://github.com/MoonFlower-King/rivermoon-local-upscaler/discussions) 或普通 Bug 模板。不要通过 Security Advisory 请求常规技术支持。

## 披露流程

维护者会确认报告、评估影响、准备修复并协调发布时间。在修复公开前，请给维护者合理时间完成升级与用户通知。
