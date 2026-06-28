# 网站同款 ComfyUI CUDA 引擎

## 目标

把旧网站 `AI` 高清按钮背后的本地 ComfyUI 链路放入桌面版：

```text
ComfyUI + PyTorch/CUDA + 4x-UltraSharp.pth
```

当前产品只保留这一条链路。

## 工作流

```text
LoadImage
-> UpscaleModelLoader(4x-UltraSharp.pth)
-> ImageUpscaleWithModel
-> ImageScale(lanczos, target width/height)
-> SaveImage
```

默认最大长边是 `4096`。用户填 `0` 时真实 4x 输出。

## Runtime 目录

```text
resources\comfyui-runtime
```

最低结构：

```text
resources\comfyui-runtime\
  main.py
  nodes.py
  server.py
  execution.py
  folder_paths.py
  comfy\
  comfy_extras\
  models\upscale_models\4x-UltraSharp.pth
  python_embeded\python.exe
```

## 进度同步

`src/main/comfy-engine.ts` 使用固定 `client_id` 提交 prompt，并连接：

```text
/ws?clientId=...
```

优先处理新版 ComfyUI 的：

```text
progress_state
```

兼容旧事件：

```text
progress
executing
execution_error
execution_success
```

同时轮询：

```text
/history/{prompt_id}
```

history 只用来判断完成和兜底漏事件，不按时间伪造进度。

## 打包

`package.json` 只把网站同款必需资源打入 release：

- `resources/comfyui-runtime`
- `models/upscale_models/4x-UltraSharp.pth`
- `docs`
- `build/icon.ico`

打包过滤掉 DiffBIR、SUPIR、其他 upscale 模型和旧轻量资源。

## 验收

```bash
npm run build
npm run dist:dir
```

启动：

```text
release\win-unpacked\RiverMoon 本地超分.exe
```

检查：

- 右侧检测卡能检测 CUDA。
- 只显示网站同款 AI。
- 处理小图能输出。
- 任务进度根据 ComfyUI 事件更新。

## 限制

- 需要 NVIDIA/CUDA。
- 没有 CPU、DirectML、AMD/Intel fallback。
- `4x-UltraSharp.pth` 商业授权需单独确认。
