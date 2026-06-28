# 贡献指南

感谢你愿意为 **RiverMoon 本地超分** 出一份力！本文档面向零基础到资深的所有开发者，
照着做即可顺利提交 Issue 或 Pull Request。

## 目录

- [行为准则](#行为准则)
- [我能贡献什么](#我能贡献什么)
- [本地开发环境](#本地开发环境)
- [提交 Issue](#提交-issue)
- [提交 Pull Request](#提交-pull-request)
- [代码规范](#代码规范)
- [提交信息规范](#提交信息规范)

## 行为准则

请保持友善、就事论事。不接受人身攻击、骚扰或歧视性言论。

## 我能贡献什么

- 🐛 报告 Bug（用 Issue 模板）
- ✨ 提出功能建议
- 📝 改进文档 / 中文使用教程
- 🔧 修复代码、补测试、做性能优化
- 🌐 适配 CPU / DirectML / AMD / Intel 等 GPU fallback（当前仅 NVIDIA CUDA）

## 本地开发环境

> 仅在 Windows x64 + NVIDIA 显卡上完整验证过。

1. 安装 [Node.js](https://nodejs.org/) 20 LTS 或更高、[Git](https://git-scm.com/)。
2. 克隆并安装依赖：

   ```bash
   git clone https://github.com/<your-name>/rivermoon-local-upscaler.git
   cd rivermoon-local-upscaler
   npm install
   ```

3. 准备 ComfyUI 运行时（体积大，不随仓库提供，需本地准备）：

   ```powershell
   # 需要本机已有一份 ComfyUI（-SourceComfyUI 指向它）
   powershell -ExecutionPolicy Bypass -File scripts/prepare-comfyui-runtime.ps1 -SourceComfyUI "D:\ComfyUI"
   ```

   并把 `4x-UltraSharp.pth` 放到 `resources/comfyui-runtime/models/upscale_models/`。

4. 启动开发模式（本机若设了 `ELECTRON_RUN_AS_NODE=1` 必须用这个命令）：

   ```bash
   npm run dev:electron
   ```

5. 改完代码务必跑通构建：

   ```bash
   npm run build
   ```

## 提交 Issue

- 先搜索是否已有相同 Issue，避免重复。
- 用仓库提供的 **Bug 报告** / **功能建议** 模板。
- Bug 请附：复现步骤、期望结果、实际结果、系统/显卡信息、`关于 → 导出诊断日志` 的内容
  （**导出前请删掉里面的本机绝对路径等隐私**）。

## 提交 Pull Request

1. Fork 仓库并基于 `main` 新建分支：`git checkout -b fix/xxx` 或 `feat/xxx`。
2. 保持改动聚焦，一个 PR 只做一件事。
3. 改动前后都要 `npm run build` 通过，UI 改动请手动验证主流程（拖图 → 出图 → 关闭重开任务记录仍在）。
4. 更新相关文档与 `CHANGELOG.md` 的 `[Unreleased]` 段。
5. 按 PR 模板填写说明，关联相关 Issue（`Closes #123`）。

## 代码规范

- **语言**：主进程/渲染层均为 TypeScript，开启 `strict`。
- **命名**：变量/函数 `camelCase`，类型/组件 `PascalCase`，常量 `UPPER_SNAKE_CASE`。
- **缩进**：2 空格；字符串优先双引号；语句结尾带分号（与现有代码一致）。
- **注释**：公共函数写一句中文用途说明；只解释「为什么」，不复述「做了什么」。
- **不要**：硬编码本机绝对路径、密钥、个人信息；提交 `dist/`、`release/`、`resources/comfyui-runtime/` 等大体积或隐私产物（已被 `.gitignore` 屏蔽）。
- **架构边界**：当前产品只保留「网站同款 AI」链路（ComfyUI + 4x-UltraSharp）。除非产品决策变更，不要重新接回 `upscaler-engine.ts` 等旧 NCNN 链路。

## 提交信息规范

推荐 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat: 新增 WebP 输出质量选项
fix: 修复取消任务后输入文件未清理的问题
docs: 补充 CUDA 安装说明
chore: 升级 electron 到 34.x
```

类型：`feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `chore`。
