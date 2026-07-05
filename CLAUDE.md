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
src/main/main.ts             Electron 主进程、窗口/acrylic 材质、IPC + 路径白名单、CSP、单实例锁、诊断导出
src/main/job-queue.ts        任务队列、进度/落盘节流、取消打断、outputBytes 统计
src/main/jobs-store.ts       user-data/jobs.json 持久化（原子写），关闭重开保留任务
src/main/jobs-normalize.ts   任务落盘/读盘规整纯函数：300 条上限、中断任务标记、durationMs 补算
src/main/comfy-engine.ts     内置 ComfyUI 启动、prompt 提交、websocket 真实进度、/interrupt、输出复制
src/main/comfy-protocol.ts   ComfyUI 协议纯逻辑：assertHistoryHealthy、进度映射、prompt 构建（vitest 直测）
src/main/output-path.ts      输出路径防覆盖：目标已存在时追加 _2/_3 序号
src/main/hardware-probe.ts   ComfyUI Runtime / CUDA 检测
src/main/settings.ts         设置规整 + DEFAULT_MODEL/DEFAULT_SCALE 产品常量
src/main/settings-store.ts   user-data/settings.json 持久化
src/main/types.ts            共享类型（UpscaleJob/UpscaleSettings/UpscalerApi 契约）
src/preload/index.ts         contextBridge 暴露 window.upscaler
src/renderer/main.tsx        React UI
src/renderer/styles.css      苹果风 vibrancy 双主题（prefers-color-scheme 浅/深色设计 token）
tests/                       vitest 单测（comfy-protocol、output-path、jobs-normalize 等纯逻辑）
resources/comfyui-runtime    内置 ComfyUI + Python/PyTorch/CUDA runtime
```

`src/main/upscaler-engine.ts`、`src/main/engine-errors.ts` 已随旧轻量链路删除；`resources/engines`、`resources/models` 目录仍是旧遗留，不是当前产品入口。不要重新接回，除非用户明确改变产品决策。

## 当前实现要点

- Electron 已升级到 `42.5.2`（Node 24）：主进程有原生 `WebSocket`，真实进度监听不再依赖额外的 ws 库。
- `UpscaleSettings` 只剩 `outputFormat / outputDirectory / maxSide` 三个可变项；链路（ComfyUI）、模型（4x-UltraSharp.pth）、4x 倍数是 `settings.ts` 里的 `DEFAULT_MODEL / DEFAULT_SCALE` 产品常量，`sanitizeSettings()` 只规整这三项。
- 任务字段 `tileSize` 已删除（读旧 jobs.json 时静默丢弃）；新增 `outputBytes`，任务成功后 stat 输出文件大小供 UI 展示。
- `JobQueue.getJobs()` 按 `createdAt` 倒序返回，最新任务在最前。
- `jobs-normalize.ts` 落盘最多保存 300 条任务；上次关闭时仍在 running/queued 的任务会标成 `已取消 / 上次关闭软件时已停止`；`durationMs` 缺失时用 `startedAt/finishedAt` 自动补算。
- ComfyUI 进度优先监听 websocket `progress_state`，兼容老 `progress`，同时低频轮询 `/history/{prompt_id}` 作为完成信号双保险；协议判断（`assertHistoryHealthy`、进度映射、prompt 构建）拆在 `comfy-protocol.ts` 纯函数里，有 vitest 单测。
- websocket 不可用时回退轮询 history；轮询只判断完成，不按时间伪造百分比。
- 取消运行中的任务会调 ComfyUI `POST /interrupt` 并从 `/queue` 删除该 prompt，立即释放 GPU，不让废弃任务在后台算完（`interruptComfy()`）。
- 输出目标文件已存在时自动追加 `_2/_3…` 序号（`output-path.ts`），避免同名不同格式或重复处理时静默覆盖旧输出。
- UI 为苹果风 vibrancy 双主题：`styles.css` 用 `prefers-color-scheme` 切换浅/深色设计 token，窗口开 Win11 22H2+ `backgroundMaterial: "acrylic"` 系统毛玻璃；不支持 acrylic 的系统回退纯色底，底色跟随 `nativeTheme`。
- `package.json` 打包过滤掉 DiffBIR/SUPIR 资源和其他 upscale 模型，只保留 `4x-UltraSharp.pth`。

## 验证命令

每次改代码至少执行：

```bash
npm run build
npm run lint
npm test
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
