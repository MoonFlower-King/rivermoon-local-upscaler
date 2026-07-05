# RiverMoon AI 工作台 · 全局任务表

> **接手必读**：本文件是唯一的任务真相源，任何模型/会话接手前先读完本文件 + [APP_V2_DESIGN.md](APP_V2_DESIGN.md)。
> 每完成一个阶段：更新状态列 → 追加「发现的问题」→ 提交本文件。

## 工作约定（门禁）

- 分支：`overhaul/engine-ui-vibrancy`（v2 工作台继续在此分支，发版前合回 main）。
- 每阶段独立 commit；提交前 `npm run lint && npm run build && npm test` 必须全绿。
- 测试 Key 从环境变量 `RIVERMOON_TEST_KEY` 读取，**绝不写入任何仓库文件**（该 Key 已在开发聊天中暴露，上线前作废）。
- 云调用只在主进程；渲染层保持零网络、CSP 不放开；Key 密文存储（safeStorage），渲染层只能拿到掩码。
- UI 沿用现有 vibrancy 双主题 token（styles.css），新组件不得硬编码颜色。

## 已验证的关键事实（勿重复踩坑）

| 事实 | 值/位置 |
|---|---|
| 中转站 | https://rivermoon7.com/ ，NewAPI 部署 |
| 测试 Key 可用模型 | gpt-5.4 / gpt-5.4-mini / gpt-5.5 / gpt-image-2（生图模型列表必须由 `/v1/models` 动态驱动） |
| 生图端点 | `POST /v1/images/generations`，返回 `data[0].b64_json`（须兼容 `url` 模式） |
| 余额/用量 | `GET /v1/dashboard/billing/subscription`(.hard_limit_usd) + `/usage`(.total_usage，0.01USD 单位) |
| 4x-UltraSharp.pth SHA256 | `A5812231FC936B42AF08A5EDBA784195495D303D5B3248C24489EF0C4021FE01`（67MB，下载校验用） |
| 模型下载源 | 主 hf-mirror.com，备 huggingface.co（`lokCX/4x-Ultrasharp`），未来可换自有 CDN |
| 充值页 URL | **待产品方提供**（暂跳 https://rivermoon7.com/ 首页，代码留 TODO） |
| Electron 42.5.2 | 主进程有全局 WebSocket/fetch；electron 二进制装不上时手动 `node node_modules/electron/install.js` |

## 任务表

状态：⬜ 未开始 · 🟦 进行中 · ✅ 完成 · ⛔ 阻塞

### M1 基建
| # | 任务 | 状态 | 验收标准 |
|---|---|---|---|
| 1.1 | 侧栏导航壳：超分/AI 生图/资产库/设置 四模块路由，现有超分工作区平移进模块 | ⬜ | 超分功能与重构前完全一致；导航切换无状态丢失 |
| 1.2 | Key 管理：safeStorage 加密存储 + 设置页输入/校验/清除 + `/v1/models` 校验 | ⬜ | 填 Key → 显示「已连接 · 模型 N 个」；重启后仍连接；渲染层只见掩码 |
| 1.3 | 账户卡（侧栏底部）：余额/用量展示 + 充值按钮（openExternal 白名单仅 rivermoon7.com） | ⬜ | 有 Key 显示余额；无 Key 显示引导；任务完成后余额刷新 |
| 1.4 | relay-client：Key 注入、超时、错误中文化映射（401/429/quota/网络） | ⬜ | 单测覆盖错误映射纯函数 |
| 1.5 | 资产库模块 v1：基于任务记录列出超分成功输出（网格+预览+打开位置） | ⬜ | 历史输出可浏览、缺失文件有占位提示 |

### M2 AI 生图
| # | 任务 | 状态 | 验收标准 |
|---|---|---|---|
| 2.1 | 云任务队列：CloudTaskQueue（并行度 2）+ cloud-tasks.json 原子写持久化 + 崩溃恢复标记 | ⬜ | 关闭重开任务记录仍在；进行中任务标记中断 |
| 2.2 | openai-image adapter：/v1/images/generations，b64/url 双模式，产物落资产库 `images/YYYY-MM/` | ⬜ | 真实 Key 出图落盘；vitest 覆盖响应解析纯函数 |
| 2.3 | 生图工作区 UI：模型动态列表、提示词、尺寸/数量、结果卡流、失败重试 | ⬜ | 端到端出图；quota 错误显示充值引导 |
| 2.4 | 「超分到 4K」联动：生成图一键进本地超分队列 | ⬜ | 云端产物直接超分成功 |

### M3 模型按需下载
| # | 任务 | 状态 | 验收标准 |
|---|---|---|---|
| 3.1 | model-downloader：流式下载+进度+SHA256 校验+原子落位；目录不可写回退 userData + extra_model_paths.yaml | ⬜ | 校验失败自动重试/报错；进度条真实 |
| 3.2 | 超分模块首次引导卡：模型缺失时显示下载卡（大小/授权/按钮） | ⬜ | 删除模型文件后重开 app 出现引导卡，下载后恢复可用 |
| 3.3 | 打包过滤全部 .pth + About 页授权说明更新 | ⬜ | dist:dir 产物不含 .pth；全新目录跑通「下载→超分」 |

### M4 打磨发版
| # | 任务 | 状态 | 验收标准 |
|---|---|---|---|
| 4.1 | 文案与充值漏斗打磨；充值 URL 换正式地址 | ⬜ | 所有云错误中文、无裸 JSON |
| 4.2 | CLAUDE.md / ARCHITECTURE 文档同步 v2 架构 | ⬜ | 新会话冷启动可依文档工作 |
| 4.3 | 全量回归 + dist:dir 发版验证（含真实 Key 端到端出图 + 全新机器模拟：无模型→下载→超分） | ⬜ | CLAUDE.md 验收清单 + 本表全部验收标准通过 |

### v2 远期（不在本期）
- AI 视频（国产 Kling/即梦 + Sora/Runway，异步 adapter）——等渠道 Key。
- Midjourney（当前 Key 分组无渠道）。
- 自动更新、代码签名。

## 发现的问题（自查追加，带日期）

- 2026-07-05：测试 Key 已在开发聊天中暴露 → 上线前必须作废换新。
- 2026-07-05：充值页 URL 未定 → 1.3 用首页占位，M4 换正式地址。

## 变更日志

- 2026-07-05 创建本表（M1-M4 规划，视频/MJ 移出本期）。
