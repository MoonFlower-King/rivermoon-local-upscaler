# Claude Desktop 交接文档

## 项目一句话

`RiverMoon AI 工作台`：Windows 桌面应用，四模块侧栏——**图片超分**（本地 ComfyUI/CUDA，免费离线，图片不上传）、**AI 生图**（rivermoon7.com 中转站，消耗用户 API Key）、**资产库**、**设置**（Key 管理）。

商业逻辑：本地超分免费引流 → 生图消耗中转站 Key → 余额不足引导充值。

## 工作目录

```text
D:\rivermoon-local-upscaler
```

任务真相源：`docs/TASKBOARD.md`（接手先读）+ `docs/APP_V2_DESIGN.md`（设计定稿）。

## 当前交付产物

```text
D:\rivermoon-local-upscaler\release\win-unpacked\RiverMoon 本地超分.exe
```

交付时复制整个 `release\win-unpacked\` 目录，不能只复制 exe。

## 当前产品决策（v2）

- 四模块侧栏工作台；苹果风 vibrancy 双主题（prefers-color-scheme + Win11 acrylic）。
- 超分永远本地、免费、不上传（隐私承诺只对超分模块）。
- 生图走 rivermoon7.com（NewAPI），模型列表由 `/v1/models` 动态驱动；Key 用 safeStorage 加密，渲染层只见掩码。
- **安装包不含 .pth 模型权重**（4x-UltraSharp 为 CC-BY-NC-SA 非商业授权）：用户在超分模块引导卡里自主下载，SHA256 校验后落位。
- 渲染层零网络（CSP connect-src 'self'）；所有云调用在主进程；IPC 路径白名单。
- AI 视频与 Midjourney 延后 v2（当前渠道未开）；充值页 URL 暂跳首页（待正式地址）。

## 超分链路

```text
LoadImage -> UpscaleModelLoader(4x-UltraSharp.pth) -> ImageUpscaleWithModel
-> ImageScale(lanczos, target) -> SaveImage
```

目标尺寸与网页版 `compute_target_size` 完全一致：长边统一限制到 maxSide（大图会缩小，超采样即网页版锐度来源）；maxSide=0 为真实 4x。默认 4096。

## 重要源码位置

```text
src/main/main.ts             主进程：窗口/acrylic、IPC + 路径白名单、CSP、单实例锁、诊断导出
src/main/job-queue.ts        本地超分队列（串行）、节流广播、interrupt 取消
src/main/jobs-store.ts       jobs.json 原子写持久化
src/main/jobs-normalize.ts   任务落盘规整纯函数（300 条上限、中断标记）
src/main/comfy-engine.ts     内置 ComfyUI 生命周期、prompt 提交、ws 真实进度、/interrupt
src/main/comfy-protocol.ts   ComfyUI 协议纯逻辑（assertHistoryHealthy、进度映射、prompt 构建）
src/main/output-path.ts      输出路径防覆盖（_2/_3 序号）
src/main/model-downloader.ts 模型按需下载：流式 + SHA256 + 多源重试 + userData 回退
src/main/cloud/relay-protocol.ts  中转站协议纯逻辑（错误分类中文化、响应解析、maskKey）
src/main/cloud/relay-client.ts    统一请求入口（Key 注入/超时/错误映射）
src/main/cloud/key-store.ts       safeStorage 加密 Key 保管
src/main/cloud/account.ts         Key 校验（/v1/models）+ 余额用量 + 5 分钟缓存
src/main/cloud/image-protocol.ts  生图协议纯逻辑（b64/url 解析、参数规整、任务规整）
src/main/cloud/image-gen.ts       生图 adapter（提交 + 落盘资产库 assets/images/YYYY-MM/）
src/main/cloud/image-queue.ts     云任务队列（并行 2、原子写持久化、崩溃恢复）
src/main/hardware-probe.ts   CUDA 检测（带指纹缓存）
src/main/settings.ts         设置规整 + DEFAULT_MODEL/DEFAULT_SCALE 常量
src/main/types.ts            共享类型 + UpscalerApi IPC 契约（preload/renderer 共用）
src/preload/index.ts         contextBridge 暴露 window.upscaler
src/renderer/main.tsx        React UI（侧栏壳 + 四模块）
src/renderer/styles.css      vibrancy 双主题设计 token
tests/                       vitest 纯函数单测（48 项）
resources/comfyui-runtime    内置 ComfyUI + Python/PyTorch/CUDA runtime（打包时过滤 *.pth）
```

## 关键实现事实

- Electron 42.5.2（Node 24）：主进程原生 WebSocket/fetch；本机 npm 装 electron 可能不下二进制，需手动 `node node_modules/electron/install.js`。
- ComfyUI 失败任务 `completed=false`、只能靠 `status_str==="error"` 判败（comfy-protocol.assertHistoryHealthy）；websocket 错误分类后只有连接类错误才回退轮询。
- 取消任务调 `/interrupt` + `/queue delete` 立即释放 GPU；输出复制后回收 ComfyUI output 侧产物。
- 中转站已验证：`/v1/models`、`/v1/dashboard/billing/{subscription,usage}`、`/v1/images/generations`（b64_json 与 url 双模式都要兼容）。
- 模型 SHA256：`a5812231fc936b42af08a5edba784195495d303d5b3248c24489ef0c4021fe01`（67MB）；下载源 hf-mirror 主、huggingface 备。
- runtime 模型目录不可写时回退 `userData/models` + `extra_model_paths.yaml`（comfy-engine 启动自动携带 `--extra-model-paths-config`）。
- 开发测试 Key 从环境变量 `RIVERMOON_TEST_KEY` 注入（仅未打包时），绝不写入仓库。

## 验证命令

每次改代码至少执行：

```bash
npm run lint
npm run build
npm test
```

生成交付目录：`npm run dist:dir`

发版前启动 `release\win-unpacked\RiverMoon 本地超分.exe` 检查：窗口打开、四模块导航、超分模块（无模型时出下载引导卡→下载→拖图出结果）、设置页填 Key 连接、生图端到端出图、余额刷新、关闭重开任务记录仍在、深浅色跟随系统。

## 已知限制

- 超分需要 NVIDIA/CUDA；无 CPU/AMD fallback。
- 生图需要 rivermoon7.com API Key（用户购买）。
- 模型权重用户自下载（非商业授权自担）；充值页 URL 待正式地址。
- 安装包未签名，Windows 可能提示未知发布者。
