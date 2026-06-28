# Claude Desktop 交接文档

## 项目一句话

`RiverMoon 本地超分` 是一个 Windows 本地图片超分桌面工具。当前最新版只保留网站同款 AI 链路：

```text
ComfyUI + PyTorch/CUDA + 4x-UltraSharp.pth
```

应用不连接 RiverMoon 服务器，不使用 NewAPI Key，图片不上传云端。

## 工作目录

```text
D:\rivermoon-local-upscaler
```

请只在这个目录继续处理。历史的旧 Web 项目目录只作为网站链路参考，不参与当前桌面版开发。

## 当前交付产物

```text
D:\rivermoon-local-upscaler\release\win-unpacked\RiverMoon 本地超分.exe
```

交付时复制整个目录：

```text
D:\rivermoon-local-upscaler\release\win-unpacked\
```

不能只复制 exe。

## 当前产品决策

- 只保留 `网站同款 AI`。
- 移除/隐藏 Pro、SUPIR、轻量 Vulkan/NCNN 入口。
- 打开软件直接进入工作区。
- 资源与 CUDA 检查只作为右侧小卡片，不占首屏主流程。
- 任务记录必须持久化，最新任务在最前。
- 每个任务必须显示计时：运行中显示“已用”，结束后显示“耗时”，并保存到任务记录。
- 进度必须来自 ComfyUI 真实事件或 history 状态，不按时间伪造。
- 对比弹窗支持缩放和拖动画面。

## 网站同款链路

当前桌面版工作流：

```text
LoadImage
-> UpscaleModelLoader(4x-UltraSharp.pth)
-> ImageUpscaleWithModel
-> ImageScale(Lanczos, target width/height)
-> SaveImage
```

默认最大长边是 `4096`，贴近网页端历史输出。用户填 `0` 时按真实 4x 输出。

## 重要源码位置

```text
src/main/main.ts             Electron 主进程、IPC、资源状态、诊断导出
src/main/job-queue.ts        任务队列、任务持久化触发、网站同款任务执行
src/main/jobs-store.ts       user-data/jobs.json 持久化，关闭重开保留任务
src/main/comfy-engine.ts     内置 ComfyUI 启动、prompt 提交、真实进度监听、输出复制
src/main/hardware-probe.ts   ComfyUI Runtime / CUDA 检测
src/main/settings.ts         强制规整到网站同款 AI
src/main/settings-store.ts   user-data/settings.json 持久化
src/renderer/main.tsx        React UI
src/renderer/styles.css      macOS 浅色工具风格
resources/comfyui-runtime    内置 ComfyUI + Python/PyTorch/CUDA runtime
```

`src/main/upscaler-engine.ts`、`src/main/engine-errors.ts`、`resources/engines`、`resources/models` 属于旧轻量链路遗留，不是当前产品入口。不要重新接回，除非用户明确改变产品决策。

## 当前实现要点

- `sanitizeSettings()` 强制 `engineMode="comfyui"`、`qualityMode="standard"`、`model="4x-UltraSharp.pth"`。
- `JobQueue.getJobs()` 按 `createdAt` 倒序返回，最新任务在最前。
- `jobs-store.ts` 最多保存 300 条任务；上次关闭时仍在 running/queued 的任务会标成 `已取消 / 上次关闭软件时已停止`。
- `durationMs` 是每个任务的总耗时；旧任务没有该字段时会用 `startedAt/finishedAt` 自动补算。
- ComfyUI 进度优先监听 websocket `progress_state`，兼容老 `progress`，同时用 `/history/{prompt_id}` 判断完成，避免漏事件。
- websocket 不可用时回退轮询 history；轮询只判断完成，不按时间伪造百分比。
- `package.json` 打包过滤掉 DiffBIR/SUPIR 资源和其他 upscale 模型，只保留 `4x-UltraSharp.pth`。

## 验证命令

每次改代码至少执行：

```bash
npm run build
```

生成交付目录：

```bash
npm run dist:dir
```

发版前启动：

```text
release\win-unpacked\RiverMoon 本地超分.exe
```

确认窗口能打开、工作区在首屏、右侧检测卡可用、拖入图片能输出、关闭重开任务记录仍在。

## 已知限制

- 需要 NVIDIA/CUDA；当前没有 CPU、DirectML、AMD/Intel fallback。
- `4x-UltraSharp.pth` 有非商业授权风险，商业发版前必须解决授权或替换模型。
- 完整 ComfyUI/PyTorch/CUDA 目录体积较大。
- 安装包未代码签名时 Windows 可能提示未知发布者。
