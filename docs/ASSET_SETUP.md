# Asset Setup

当前版本只需要网站同款 AI 资源。

## Required Runtime

```text
resources/comfyui-runtime/python_embeded/python.exe
resources/comfyui-runtime/main.py
resources/comfyui-runtime/models/upscale_models/4x-UltraSharp.pth
```

## Packaging

`package.json` 通过 `extraResources` 复制 `resources/comfyui-runtime`，并过滤掉非当前链路资源，只保留 `4x-UltraSharp.pth`。

## Runtime Check

如果 Runtime、Python、CUDA 或模型缺失，应用仍会打开工作区，但右侧状态卡和任务失败信息会显示中文诊断。

## Licensing

商业交付前必须确认：

- `4x-UltraSharp.pth` 是否允许商业分发。
- 是否需要署名。
- 是否需要替换为可商用模型。
