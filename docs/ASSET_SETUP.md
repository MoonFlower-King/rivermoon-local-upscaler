# 本地运行时与模型准备

## Git 仓库不包含什么

以下内容体积大或受第三方许可约束，不进入 Git：

```text
resources/comfyui-runtime/
resources/models/
*.pth
*.safetensors
*.onnx
```

## 准备 ComfyUI/PyTorch/CUDA runtime

开发者需要先在本机准备一份可运行的 ComfyUI，然后执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/prepare-comfyui-runtime.ps1 `
  -SourceComfyUI "D:\ComfyUI"
```

脚本只复制 ComfyUI 代码和可用的 Python runtime，不复制模型权重。

最低结构：

```text
resources/comfyui-runtime/main.py
resources/comfyui-runtime/python_embeded/python.exe
resources/comfyui-runtime/models/upscale_models/
```

## 模型下载

`4x-UltraSharp.pth` 不随源码或安装包分发。用户在图片超分模块中主动下载，`model-downloader.ts` 会执行：

```text
download to temporary file
-> SHA256 verification
-> atomic move to writable model directory
-> ComfyUI extra_model_paths configuration when required
```

模型记录许可为 CC BY-NC-SA 4.0，商业使用前必须重新核对上游授权。

## 打包

`electron-builder` 从本机 `resources/comfyui-runtime/` 复制运行时，但过滤：

- 所有 `.pth` 权重。
- DiffBIR/SUPIR custom nodes。
- checkpoints 和旧模型目录。

运行 `npm run release:smoke` 可验证安装包没有意外包含模型或旧资源。
