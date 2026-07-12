# GitHub 开源发布检查表

## 1. 凭据与隐私

- 撤销并更换所有曾在聊天、日志、截图或测试终端中出现过的 API Key。
- 确认 `.env*`、`user-data/`、`.local-user-data/`、日志和资产目录未被 Git 跟踪。
- 检查 Issue、PR、README 截图和 Release Notes 中没有 Key、签名 URL、本机路径或私人内容。
- 运行：

  ```powershell
  npm run repo:preflight
  ```

## 2. Git 历史与大文件

- 确认 Git 历史不存在接近 100MB 的 blob。
- 不提交 ComfyUI/PyTorch/CUDA runtime、模型权重、release 目录或分卷压缩包。
- 大体积 Windows 交付物只上传到 GitHub Release，不进入源码分支。

## 3. 许可证

- 仓库源码使用 MIT，`LICENSE` 保持标准文本。
- `NOTICE` 列出 RiverMoon 托管服务、ComfyUI、PyTorch/CUDA、模型和 npm 依赖的独立条款。
- 商业分发前重新确认 `4x-UltraSharp.pth`、ComfyUI 和 CUDA runtime 的再分发条件。
- 模型权重不得进入源码或安装包。

## 4. GitHub 仓库设置

- 默认分支设为 `main`。
- 开启 Issues、Discussions 和 Security Advisories。
- 开启 Dependabot alerts、secret scanning 和 push protection（GitHub 账户支持时）。
- 为 `main` 添加分支保护：CI 和 CodeQL 通过后才能合并，禁止 force push。
- 检查仓库描述、主页和 Topics 与 `package.json` 一致。

推荐 Topics：

```text
electron ai-image-generation ai-video-generation image-upscaling comfyui cuda windows
```

## 5. 发布前验证

```powershell
npm ci
npm run check
npm run dist:dir
npm run release:smoke
npm run release:launch-smoke
```

真实付费生图、视频和 GPT E2E 不进入公共 CI。维护者在私有环境中使用已授权 Key 手动验收。

## 6. 版本与发布资产

- 更新 `package.json` 版本和 `CHANGELOG.md`。
- 确保目标 tag 尚不存在。
- 使用严格预检确认工作树干净：

  ```powershell
  npm run repo:preflight:strict
  ```

- 生成 GitHub 分卷资产：

  ```powershell
  npm run release:github:assets
  npm run release:github:preflight
  ```

- 上传所有 `.7z.001/.002/...`、校验和、manifest、下载说明和 Release Notes。
- 未代码签名时必须在 Release Notes 中明确 Windows 未知发布者提示。

## 7. 发布后

- 在一台没有开发环境的 Windows 机器上下载全部分卷并验证解压、启动、模型下载和更新检查。
- 验证 Issues/Discussions/Security Advisory 链接有效。
- 监控 CI、CodeQL 和 Dependabot 首次运行结果。
