# 贡献指南

感谢你参与 RiverMoon AI 创作台。提交 Issue 或 Pull Request 前，请先阅读本文件、[行为准则](CODE_OF_CONDUCT.md)和[安全策略](SECURITY.md)。

## 可以贡献什么

- 修复桌面客户端 Bug。
- 改进 AI 生图、AI 视频、GPT 对话、本地超分和资产库工作流。
- 增加测试、诊断和可访问性支持。
- 改进 Windows/NVIDIA 环境兼容性和文档。
- 为未来无限画布提出边界清晰、可验证的实现方案。

RiverMoon 托管后端不在本仓库中。涉及服务端合同或计费行为的改动，需要先在 Issue 中说明客户端与服务端的契约变化。

## 开发环境

最低要求：

- Windows 10/11 x64
- Node.js 20+
- Git

安装并运行源码检查：

```powershell
git clone https://github.com/MoonFlower-King/rivermoon-local-upscaler.git
cd rivermoon-local-upscaler
npm ci
npm run check
```

启动桌面开发环境：

```powershell
npm run dev:electron
```

只有完整测试本地超分时才需要 NVIDIA/CUDA 与 ComfyUI/PyTorch 运行时：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-comfyui-runtime.ps1 `
  -SourceComfyUI "D:\ComfyUI"
```

模型权重不进入 Git。应用会在用户主动操作后下载并校验 `4x-UltraSharp.pth`。

## API Key 与付费测试

- 不得把真实 API Key 写进源码、`.env`、测试快照、Issue、PR、截图或日志。
- 开发环境可通过当前 shell 的 `RIVERMOON_TEST_KEY` 注入 Key；应用不会自动加载 `.env`。
- 普通 PR 只运行本地单元测试和合同 dry-run，不运行会计费的 E2E。
- `npm run video:paid-e2e` 必须由维护者在明确确认计费后手动执行。
- 使用过或在聊天/日志中暴露过的 Key 必须先撤销再公开仓库。

## 架构边界

- Renderer 不直接访问网络，不接触明文 Key。
- 云端请求必须经过 preload IPC 和 Electron 主进程 adapter。
- 图片/视频能力必须由实时合同驱动，不能在 UI 中伪造模型能力。
- 本地超分保持 ComfyUI + PyTorch/CUDA + `4x-UltraSharp.pth` 工作流。
- 不重新接回 DiffBIR、SUPIR、NCNN/Vulkan 等已退出产品入口的旧链路。
- 生图参数/素材区与创作舞台保持解耦，为无限画布预留稳定边界。
- 本地任务和云端任务必须使用真实状态、真实计时和持久化记录。

## 提交 Issue

提交前先搜索现有 Issue。Bug 报告应包含：

- 受影响模块和软件版本。
- 可重复的最小步骤。
- 期望结果与实际结果。
- Windows、显卡和驱动信息（本地超分问题）。
- 已脱敏的错误信息或诊断摘要。

不要公开 API Key、签名 URL、本机绝对路径、私人提示词或用户图片。安全问题请走 [GitHub Security Advisory](https://github.com/MoonFlower-King/rivermoon-local-upscaler/security/advisories/new)。

## 提交 Pull Request

1. 从 `main` 创建聚焦的分支，例如 `fix/...`、`feat/...` 或 `docs/...`。
2. 一个 PR 只解决一个明确问题。
3. 为行为变化补测试，并更新相关文档与 `CHANGELOG.md`。
4. 运行：

   ```powershell
   npm run check
   ```

5. UI 改动需验证 1440x900 和应用最小窗口尺寸，附前后截图。
6. 涉及发布结构时额外运行：

   ```powershell
   npm run dist:dir
   npm run release:smoke
   npm run release:launch-smoke
   ```

7. 使用 PR 模板说明风险、测试范围和未验证项。

## 代码规范

- TypeScript 开启 strict，保持现有类型边界。
- 2 空格缩进，双引号，使用 Prettier。
- 优先复用现有模块与协议解析器，避免在 UI 中重复实现服务端规则。
- 注释解释原因和约束，不复述代码。
- 不提交构建产物、运行时、模型、用户数据或证书。

推荐 Conventional Commits：

```text
feat(image): add canvas node selection
fix(video): reject expired signed download URLs
docs: clarify cloud data boundary
test(agent): cover streamed error completion
```

## 许可证

提交代码即表示你有权提供该贡献，并同意该贡献按仓库的 [MIT License](LICENSE) 发布。第三方代码或资产必须保留其许可证与来源说明。
