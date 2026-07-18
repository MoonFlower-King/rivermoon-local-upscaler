# RiverMoon AI 创作台 · v2 设计定稿

> 历史设计记录：本文描述 2026-07-05 时的阶段性范围。AI 视频和 GPT 现已实现；当前产品定义以根目录 `AGENTS.md`、`PRODUCT_DOCUMENT.md` 和 `PRODUCT_REPORT_BILINGUAL.md` 为准。

> 状态：已与产品负责人确认方向（2026-07-05）。视频模块延后至 v2 后期；生图已用真实 Key 联调打通。

## 1. 定位与商业逻辑

桌面 app 从「本地超分工具」升级为「RiverMoon 中转站客户的 AI 创作台」：

```text
免费用户下载 app → 本地超分（无 Key、离线、无限量）
→ 看到 AI 生图入口 → 注册 rivermoon7.com 买 Key
→ 用量消耗 → 余额不足时 app 内引导充值 → 复购
```

- **超分永远免费离线**：差异化钩子与留存理由；「图片不上传」隐私承诺只对超分模块保留。
- **Key 即账号**：不做独立注册体系。Key 用 Electron `safeStorage`（DPAPI）加密落盘，永不明文、永不进渲染层。
- **余额常驻**：侧栏账户卡显示余额/用量，低额度变橙；配额类错误直接弹充值引导。

## 2. v1 范围（本期交付）

| 模块 | 内容 | 状态 |
|---|---|---|
| 图片超分 | 现有工作区平移进侧栏导航；**模型改为按需下载**（见 §4） | 链路已稳定 |
| AI 生图 | OpenAI 兼容 `/v1/images/generations`，模型列表由 `/v1/models` 动态驱动 | 已联调打通 |
| 资产库 | 超分输出 + 生成图统一浏览（本地目录为真相源） | 新建 |
| 账户 | Key 校验、余额/用量卡、充值跳转 | 接口已验证 |

**延后到 v2**：AI 视频（国产 + Sora/Runway，异步任务 adapter 接口已在架构中预留）；Midjourney（当前测试 Key 分组无 MJ 渠道，无法联调——渠道就绪后按任务式 adapter 接入）。

## 3. 联调实录（2026-07-05，测试 Key）

| 接口 | 结果 |
|---|---|
| `GET /v1/models` | ✅ 返回 4 模型：gpt-5.4 / gpt-5.4-mini / gpt-5.5 / **gpt-image-2** |
| `GET /v1/dashboard/billing/subscription` | ✅ `hard_limit_usd` 可作余额展示 |
| `GET /v1/dashboard/billing/usage` | ✅ `total_usage`（0.01 USD 单位） |
| `POST /v1/images/generations`（gpt-image-2, 1024×1024, n=1） | ✅ 返回 `data[0].b64_json`，解码落盘成功 |

实现须同时兼容 `b64_json` 与 `url` 两种返回（不同渠道行为不同）。测试 Key 不入库，开发时从环境变量 `RIVERMOON_TEST_KEY` 读取；**该 Key 已在聊天中暴露，上线前必须作废换新**。

## 4. 超分模型按需下载（本期新增，解授权阻断）

产品决策：**安装包不再内置 4x-UltraSharp.pth**（CC-BY-NC-SA 非商业授权）。app 只分发引擎，权重由用户在界面里自主下载自用——分发法律责任与 app 解耦。

- 首次进入超分模块显示模型卡：名称 / 约 67MB / 授权说明 / 「下载模型」按钮 + 进度条。
- 主进程 `model-downloader`：流式下载 → 临时文件 → **SHA256 校验**（正确值 `A5812231FC936B42AF08A5EDBA784195495D303D5B3248C24489EF0C4021FE01`）→ 原子移入 `comfyui-runtime/models/upscale_models/`；该目录写探针失败（Program Files 安装）时落到 userData 并用 `extra_model_paths.yaml` 挂给 ComfyUI。
- 模型注册表（代码内 JSON）：主源 `hf-mirror.com`（国内可达），备源 `huggingface.co`，未来可换 RiverMoon 自有 CDN；支持后续追加 RealESRGAN 等可商用备选模型。
- `package.json` extraResources 过滤全部 `models/upscale_models/*.pth`；About 页写明模型授权与用户自下载性质。

## 5. 技术架构

```text
渲染层（零网络，CSP connect-src 'self' 不变）
  └─ IPC 契约（UpscalerApi 扩展为 WorkbenchApi）
主进程
  ├─ TaskQueue：统一任务模型 Task{kind: upscale|image|(video)}，
  │   复用现有原子写持久化/节流广播/崩溃恢复；本地串行、云端并行度 2-3
  ├─ comfy-engine（本地超分，现状不动）
  ├─ relay-client（rivermoon7.com 网关：Key 注入、超时、错误中文化映射）
  │   ├─ openai-image adapter（同步，v1）
  │   └─ video/mj adapter（异步 submit/poll，v2 预留接口）
  ├─ model-downloader（§4）
  ├─ safeStorage Key 保管（settings.json 只存密文）
  └─ 资产库目录：资产库/{upscale|images}/YYYY-MM/
```

错误映射即商业逻辑：401→「Key 无效」；429→「排队中稍后重试」；quota→「余额不足」+ 充值按钮（`shell.openExternal`）。云错误一律中文化，不裸抛 JSON。

## 6. 实施顺序

1. **M1 基建**：侧栏导航壳、Key 管理（safeStorage+校验+账户卡）、Task 模型泛化、资产库。
2. **M2 生图**：relay-client + openai-image adapter、生图工作区（模型动态列表、尺寸/数量、结果卡、失败重试）、「超分到 4K」联动。
3. **M3 模型按需下载**：model-downloader + 超分模块首次引导卡 + 打包过滤 .pth。
4. **M4 打磨**：充值漏斗文案、CLAUDE.md 产品决策更新、全量回归、dist 发版。

每阶段独立提交，`npm run lint/build/test` 全绿为门禁；M2 结束用真实 Key 做一次端到端出图验收。

## 7. 待产品方提供

- 充值页/注册页准确 URL（账户卡按钮跳转目标）。
- MJ / 视频渠道就绪时的测试 Key（届时启动 v2 接入）。
