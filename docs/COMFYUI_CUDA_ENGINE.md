# 本地 ComfyUI CUDA 超分引擎

## 工作流

```text
LoadImage
-> UpscaleModelLoader(4x-UltraSharp.pth)
-> ImageUpscaleWithModel
-> ImageScale(lanczos, target width/height)
-> SaveImage
```

默认最大长边为 4096；设置为 `0` 时按模型真实 4x 输出。

## 运行时

本地运行时目录：

```text
resources/comfyui-runtime/
```

运行时不进入 Git。准备方式见 [ASSET_SETUP.md](ASSET_SETUP.md)。

## 真实进度

`src/main/comfy-engine.ts` 使用独立 `client_id` 提交 prompt，并监听：

```text
progress_state
progress
executing
execution_error
execution_success
```

同时低频轮询 `/history/{prompt_id}` 判断完成和补偿 websocket 漏事件。history 回退不伪造时间百分比。

## 取消与清理

- 运行中取消会调用 `/interrupt`。
- 排队任务会从 `/queue` 删除。
- 任务结束后清理复制到 ComfyUI input/output 的临时文件。
- ComfyUI 子进程在应用退出时关闭。

## 模型

模型权重不进入 Git，也不随安装包分发。用户在应用中主动下载并校验 `4x-UltraSharp.pth`。许可证与商业风险见仓库根目录 [NOTICE](../NOTICE)。

## 验证

```powershell
npm run build
npm run dist:dir
npm run release:smoke
npm run release:launch-smoke
```

打包版入口：

```text
release/win-unpacked/RiverMoon AI 创作台.exe
```

当前不支持 CPU、DirectML、AMD 或 Intel fallback。
