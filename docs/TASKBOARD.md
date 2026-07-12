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
| GPT 对话端点 | `POST https://img.rivermoon7.com/v1/responses`，Responses SSE；默认模型 `gpt-5.5`，默认 `reasoning_effort=medium` |
| 生图端点 | `POST /v1/images/generations`，返回 `data[0].b64_json`（须兼容 `url` 模式） |
| 余额/用量 | `GET /v1/dashboard/billing/subscription`(.hard_limit_usd) + `/usage`(.total_usage，0.01USD 单位) |
| 4x-UltraSharp.pth SHA256 | `A5812231FC936B42AF08A5EDBA784195495D303D5B3248C24489EF0C4021FE01`（67MB，下载校验用） |
| 模型下载源 | 主 hf-mirror.com，备 huggingface.co（`lokCX/4x-Ultrasharp`），未来可换自有 CDN |
| 充值页 URL | **待产品方提供**（暂跳 https://rivermoon7.com/ 首页，代码留 TODO） |
| Electron 42.5.2 | 主进程有全局 WebSocket/fetch；electron 二进制装不上时手动 `node node_modules/electron/install.js` |

## 任务表

状态：⬜ 未开始 · 🟦 进行中 · ✅ 完成 · ⛔ 阻塞

### M1 基建 ✅（2026-07-05，commit 见日志）
| # | 任务 | 状态 | 验收标准 |
|---|---|---|---|
| 1.1 | 侧栏导航壳：超分/AI 生图/资产库/设置 四模块路由，现有超分工作区平移进模块 | ✅ | 超分功能与重构前完全一致；导航切换无状态丢失（状态全在 App 层） |
| 1.2 | Key 管理：safeStorage 加密存储 + 设置页输入/校验/清除 + `/v1/models` 校验 | ✅ | safeStorage 加解密回路已实机验证；渲染层只见掩码；**完整 UI 流验收合并到 M2 端到端出图** |
| 1.3 | 账户卡（侧栏底部）：余额/用量展示 + 充值按钮（openExternal 白名单仅 rivermoon7.com） | ✅ | totalUsd≥1e6 显示「不限额」；余额刷新接到 M2 任务完成钩子 |
| 1.4 | relay-client：Key 注入、超时、错误中文化映射（401/429/quota/网络） | ✅ | relay-protocol 纯函数 10 项单测覆盖 |
| 1.5 | 资产库模块 v1：基于任务记录列出超分成功输出（网格+预览+打开位置） | ✅ | 缺失文件由预览通道自然显示灰占位 |

### M2 AI 生图 ✅（2026-07-05）
| # | 任务 | 状态 | 验收标准 |
|---|---|---|---|
| 2.1 | 云任务队列：ImageTaskQueue（并行度 2）+ image-tasks.json 原子写持久化 + 崩溃恢复标记 | ✅ | normalizeImageTask 单测覆盖中断标记；will-quit flushSync 接入 |
| 2.2 | openai-image adapter：/v1/images/generations，b64/url 双模式，产物落资产库 `images/YYYY-MM/` | ✅ | **真实 Key E2E 通过**（40.7s 出图落盘 57.5KB）；解析纯函数 7 项单测 |
| 2.3 | 生图工作区 UI：模型动态列表、提示词、尺寸/数量、结果卡流、失败重试 + quota 充值引导 | ✅ | adapter 层 E2E 已验；**UI 点击链路请人工点一次生成**（低风险，IPC 全程有类型契约） |
| 2.4 | 「超分到 4K」联动：生成图/资产库一键进本地超分队列并切换模块 | ✅ | 产物终态即入路径白名单，jobs:start 直接放行 |

### M3 模型按需下载 ✅（2026-07-05）
| # | 任务 | 状态 | 验收标准 |
|---|---|---|---|
| 3.1 | model-downloader：流式下载+进度+SHA256 校验+原子落位；目录不可写回退 userData + extra_model_paths.yaml（comfy-engine 启动自动携带 --extra-model-paths-config） | ✅ | **真实下载 E2E 通过**（hf-mirror 40.9s/67MB，哈希校验后落位）；多源顺序重试；取消即清理 tmp |
| 3.2 | 超分模块首次引导卡：模型缺失时显示下载卡（大小/授权/真实进度/取消/失败重试），无模型时隐藏拖放区 | ✅ | findComfyModel 双目录探测；下载完成自动刷新资源状态恢复可用 |
| 3.3 | 打包过滤全部 .pth + About 页授权说明更新 | ✅ | filter 改为 !models/upscale_models/*.pth；**产物无 .pth 的实包检查放 M4 全量回归** |

### M4 打磨发版 ✅（2026-07-06，充值 URL 除外）
| # | 任务 | 状态 | 验收标准 |
|---|---|---|---|
| 4.1 | 自查项清理：.download 启动清理、生图实时秒数、outputSizes 元数据、硬件检测分离引擎/模型判断 | ✅ | 模型未下载时提示「点击下载模型」而非「未找到 Runtime」（实包日志验证） |
| 4.2 | CLAUDE.md 全量重写 v2（ARCHITECTURE 保留 v1 引擎细节，v2 总览在 CLAUDE.md + APP_V2_DESIGN） | ✅ | 新会话读 CLAUDE.md + 本表即可冷启动 |
| 4.3 | 全量回归 + dist:dir 实包验证 | ✅ | models/upscale_models 无 .pth；实包启动正常；探测文案正确；lint/build/48 测试全绿 |
| 4.4 | 充值 URL 换正式地址（TOPUP_URL in cloud/account.ts） | ⛔ 待产品方提供 URL | 一行替换 + 重打包 |
| 4.5 | 用户人工验收：实包「下载模型→超分」全流程、设置页填 Key、生图 UI 点击出图、深浅色切换 | ⛔ 待用户 | 见 CLAUDE.md 验证命令节 |

### M5 AI 视频首版 🟦（2026-07-08，商业验收未闭环）
| # | 任务 | 状态 | 验收标准 |
|---|---|---|---|
| 5.1 | 生产视频合同协议：解析 HTTPS contract、模型、endpoint、价格、参考图类型、`multi_reference` 别名 | ✅ | `npm run release:online-smoke` 通过；生产合同 `2026-07-06.pro666-video-models-v1` 可解析 |
| 5.2 | AI 视频工作区 UI：文生/图生/多参考图/首尾帧模式、模型参数、参考图选择、禁用原因 | ✅ | 合同支持才允许提交；当前生产 `first_last_frame=0`，必须继续门控 |
| 5.3 | 视频任务队列：持久化、远端 job 恢复、停止同步、recent 合并、下载失败恢复 | ✅ | mock E2E 覆盖恢复不重复提交、不重复扣费、远端取消/过期清理旧错误 |
| 5.4 | 视频下载安全：认证请求只走 HTTPS 网关、外部 CDN 不带 Key、签名 URL 不进持久化诊断、错误响应不落盘 | ✅ | `tests/video-url.test.ts`、`tests/video-gen-e2e.test.ts` 覆盖 |
| 5.5 | 非付费发布门禁：打包结构 smoke、启动 smoke、视频合同 smoke | ✅ | `npm run release:verify` 通过；release smoke 88 pass / 3 warning；launch smoke 通过 |
| 5.6 | 真实付费 E2E 手动门禁脚本 | ✅ | `npm run video:paid-e2e:dry-run` 通过；`npm run video:paid-e2e` 必须设置真实 Key 和确认短语才会计费提交 |
| 5.7 | 真实文生视频付费 E2E | ⛔ 待真实 Key/用户确认 | 成功提交、轮询、下载、可播放；保存远端 job_id、模型、模式、输出文件，不保存签名 URL query |
| 5.8 | 真实图生视频和多参考图视频付费 E2E | ⛔ 待真实 Key/参考图/用户确认 | source-cache 上传、顺序和类型保持、远端任务成功、视频下载落盘 |
| 5.9 | 打包版 GUI 视频人工回归 | ⛔ 待用户/人工 | 从 `release\win-unpacked\RiverMoon AI 创作台.exe` 点击完成合同同步、提交限制、任务记录、下载预览、资产库 |

### M6 AI 生图站点对齐 🟦（2026-07-08，真实 Key GUI 验收未闭环）
| # | 任务 | 状态 | 验收标准 |
|---|---|---|---|
| 6.1 | 读取线上图片能力合同 | ✅ | `https://img.rivermoon7.com/v1/image/contract` 可解析；当前版本 `2026-06-07.phase1`，4 个模型 |
| 6.2 | 桌面端生图参数对齐站点 | ✅ | 支持合同模型标签、4K 尺寸、质量、输出格式、fit_mode、原生直出、自定义尺寸 |
| 6.3 | 参考图编辑链路 | ✅ | 参考图为空走 `/v1/images/generations` JSON；有参考图走 `/v1/images/edits` FormData，支持 `@图1` 顺序绑定 |
| 6.4 | 分镜模板入口 | ✅ | 六宫格、九宫格、故事板模板可填充提示词 |
| 6.5 | 非计费请求级测试 | ✅ | `tests/image-gen-e2e.test.ts` 覆盖图片合同、文生图 JSON、参考图 edits FormData |
| 6.6 | 真实 Key GUI 生图回归 | ⛔ 待用户/人工 | 打包版中用真实 Key 完成 4K PNG、参考图编辑、自定义尺寸、模板提示词流程 |

### M7 GPT 对话站点接入 🟦（2026-07-08，真实 Key GUI 验收未闭环）
| # | 任务 | 状态 | 验收标准 |
|---|---|---|---|
| 7.1 | 读取线上 agent 链路 | ✅ | `img.rivermoon7.com/agent` 前端确认使用 `/v1/responses`、`gpt-5.5`、`reasoning_effort`、图片 `input_image` |
| 7.2 | 桌面端 GPT 对话 UI | ✅ | 侧栏新增 `GPT 对话`，支持历史对话、模型选择、推理强度、文本输入、图片粘贴/拖入/选择 |
| 7.3 | 主进程 Responses SSE | ✅ | Key 只在主进程读取；`agent-chat:*` IPC 流式返回 delta，支持取消 |
| 7.4 | 非计费请求级测试 | ✅ | `tests/agent-protocol.test.ts` 和 `tests/agent-gen-e2e.test.ts` 覆盖请求体、SSE、错误映射；`agent:responses-smoke` 验证生产 endpoint 要求认证 |
| 7.5 | 真实 Key GUI GPT 回归 | ⛔ 待用户/人工 | 打包版中完成文本对话、图片分析、模型切换、推理强度、取消输出 |

### M8 版本更新按钮 ✅（2026-07-08，手动下载更新）
| # | 任务 | 状态 | 验收标准 |
|---|---|---|---|
| 8.1 | 主进程 GitHub 更新检查 | ✅ | 优先读取 `releases/latest`；404 时回退 `tags?per_page=1`；网络/私有仓库/无 Release 均返回中文结果，不让 UI 崩溃 |
| 8.2 | 设置页版本更新卡片 | ✅ | 显示当前版本；按钮可检查更新；有新版本时可打开下载页；没有 Release 时提示发布到 GitHub Releases |
| 8.3 | 安全打开下载页 | ✅ | `openExternal` 只允许当前 GitHub 仓库的 releases/tags 页面 |
| 8.4 | 自动化和打包 smoke | ✅ | `tests/update-checker.test.ts` 覆盖版本比较/Release/Tag/错误；`release-smoke` 检查 IPC、preload、renderer、asar 文件 |

### M9 GitHub 发布准备 ✅（2026-07-08，分卷上传）
| # | 任务 | 状态 | 验收标准 |
|---|---|---|---|
| 9.1 | GitHub Release 预检脚本 | ✅ | `npm run release:github:preflight` 检查 gh 登录、工作区干净、tag 可用、交付目录存在、asset 小于 2GiB |
| 9.2 | GitHub 分卷资产脚本 | ✅ | `npm run release:github:assets` 使用 7-Zip 生成 1900MB 分卷、SHA256、manifest、下载说明和 Release notes |
| 9.3 | 发布文档更新 | ✅ | `docs/BUILD_AND_RELEASE.md` 记录 GitHub 发版步骤、7-Zip 要求、分卷下载说明、gh release create 示例 |

### v2 远期（不在本期）
- Midjourney（当前 Key 分组无渠道）。
- 静默自动更新、代码签名。

## 发现的问题（自查追加，带日期）

- 2026-07-05：测试 Key 已在开发聊天中暴露 → 上线前必须作废换新。
- 2026-07-05：充值页 URL 未定 → 1.3 用首页占位，M4 换正式地址。
- 2026-07-05（M1 自查）：`account:set-key` 失败时返回 `maskedKey: null`，若用户原本已连接、换 Key 失败，账户卡会短暂显示「未连接」——应保留旧 Key 状态。M2 顺手修（改为失败时回读 getAccountStatus）。
- 2026-07-05（M1 自查）：dev 注入的测试 Key 会加密写进 `.local-user-data/relay-key.json`，该目录已 gitignore，但清库测试时记得删。
- 2026-07-05（M1 自查）：余额展示对 NewAPI「无限额度」账户显示「不限额」（阈值 1e6 USD），真实客户 Key 的小额度展示尚未用真实数据验证过 → M4 用真实客户 Key 确认。
- 2026-07-05（M2 自查）：M1 问题 #1（换 Key 失败丢旧连接状态）已修——失败时回读现有连接并附加错误说明。
- 2026-07-05（M2 自查）：生图任务 running 时不显示实时已用秒数（本地超分有）→ M4 打磨项。
- 2026-07-05（M2 自查）：pickImageModels 靠命名启发式（/image|dall|flux|…/），分组里没有匹配时会全量展示（含聊天模型），用户误选聊天模型会得到中文报错但体验一般 → M4 考虑维护已知生图模型清单。
- 2026-07-05（M2 自查）：资产库里生图产物没有尺寸/文件大小元数据（未 stat）→ M4 顺手补。
- 2026-07-05（M3 自查）：Program Files 回退路径（userData + extra_model_paths.yaml）逻辑已写但未实测 → M4 用只读目录模拟验证。
- 2026-07-05（M3 自查）：下载中途强退 app 会残留 67MB 的 .download 临时文件（重新下载会覆盖，无正确性问题）→ M4 启动时清理 *.download。【已修】
- 2026-07-06（M4 回归发现）：模型缺失曾被误报为「未找到 ComfyUI Runtime」→ 已分离引擎/模型判断，CUDA 自检不再被模型缺失阻断。【已修】
- 2026-07-06（M4 回归结论）：实包残留的 4 个 .pth 均为 python 库内部文件（distutils-precedence、torchmetrics lpips alex/squeeze/vgg），与超分模型授权无关；models/upscale_models 已干净。
- 2026-07-06（遗留）：pickImageModels 命名启发式在无生图模型的分组下会全量展示 → v2 考虑已知模型清单。
- 2026-07-06（遗留）：上线前必须作废开发测试 Key；充值 URL 待正式地址（4.4）。
- 2026-07-06（线上事件）：12:11-12:12 生图 503 集中报错——上游 codex 渠道瞬时过载约 1 分钟自愈，
  多用户中招、失败未计费。app 侧已加瞬时错误自动重试（2s/5s 退避，仅 server/rate/network）。
  **服务端待办（产品方）**：给 gpt-image-2 加备用渠道 + 失败重试次数设 2-3；单渠道期间慎开
  「失败自动禁用」；排查 codex 渠道上游并发配额。
- 2026-07-08（M5 自查）：任务板曾仍把 AI 视频写成远期能力，已更正为首版已接入但商业验收未闭环。
  当前不能宣布商业消费级完成；阻断项是真实付费文生/图生/多参考图 E2E、打包 GUI 人工回归、网站同图差分、
  模型授权和代码签名。
- 2026-07-08（M6 自查）：桌面端 AI 生图曾只暴露模型/三尺寸/张数，和线上生图工作台不一致。已改为读取
  `img.rivermoon7.com/v1/image/contract`，并接入质量、格式、4K、自定义尺寸、原生直出、参考图编辑和分镜模板。
  真实 Key GUI 回归仍待人工点击。
- 2026-07-08（M7 自查）：GPT 对话已按线上 `/agent` 链路接入 `img.rivermoon7.com/v1/responses`，但尚未用真实 Key 在打包 GUI 中完成文本/图片对话计费验收。
- 2026-07-08（M8 自查）：已新增手动版本更新按钮。当前功能只检查 GitHub Release/Tag 并打开下载页，不做运行中自动覆盖安装；后续正式商用仍需要代码签名和更完整的自动更新策略。
- 2026-07-08（M9 自查）：交付目录约 6GB，无法作为单个 GitHub Release asset 上传；已新增 7-Zip 分卷资产脚本和发布预检脚本。当前机器未登录 gh，且未安装 7-Zip，真正发版前必须补齐。

## 变更日志

- 2026-07-05 创建本表（M1-M4 规划，视频/MJ 移出本期）。
- 2026-07-05 M1 完成：新增 src/main/cloud/{relay-protocol,relay-client,key-store,account}.ts、
  渲染层侧栏壳（NAV_ITEMS/AccountCard/SettingsModule/ImageGenModule 占位/AssetsModule）、
  account:* IPC 四件套、dev 环境 RIVERMOON_TEST_KEY 自动注入。测试 32→41。
- 2026-07-05 M2 完成：新增 cloud/{image-protocol,image-gen,image-queue}.ts、image-gen:* IPC、
  生图工作区（模型派生选择/提示词/尺寸/数量/结果卡/重试/充值引导/取消）、资产库合并生图产物、
  「超分到 4K」联动、生图终态自动刷新余额。测试 41→48。真实 Key adapter E2E 通过。
- 2026-07-05 M3 完成：model-downloader（流式+SHA256+多源+回退）、首次引导卡、打包去 .pth。
  真实下载 E2E 通过（hf-mirror 40.9s/67MB）。
- 2026-07-06 M4 完成（除 4.4 充值 URL / 4.5 用户验收）：自查项清理、CLAUDE.md v2 重写、
  硬件检测引擎/模型分离（回归发现并修复）、实包验证（无超分 .pth、启动正常、文案正确）。
- 2026-07-08 M5 首版接入：新增 AI 视频模块、生产视频合同解析、source-cache 上传、任务提交/轮询/下载、
  远端任务恢复、视频安全下载策略、诊断脱敏、release smoke、launch smoke、online contract smoke、付费 E2E 手动门禁。
  当前自动化 16 个测试文件 / 185 tests 通过；`release:verify` 通过。真实付费 E2E 与 GUI 人工回归仍待验收。
- 2026-07-08 M6 生图站点对齐：新增图片合同解析、图片网关提交、参考图 edits FormData、自定义尺寸/质量/格式/原生直出 UI、
  分镜模板、图片请求级非计费 E2E。当前自动化 17 个测试文件 / 192 tests 通过。
- 2026-07-08 M7 GPT 对话接入：新增 agent protocol/gen、Responses SSE、GPT 对话 UI、本机历史、图片输入压缩、请求级非计费 E2E。
  当前自动化 20 个测试文件 / 200 tests 通过。
- 2026-07-08 M8 版本更新按钮：新增 update-checker、updates:* IPC、preload 方法、设置页检查更新卡片、Release/Tag 回退、
  GitHub 下载页白名单和 release smoke 覆盖。该能力是手动下载更新，不是静默自动更新。
  当前自动化 21 个测试文件 / 206 tests 通过；`release:smoke` 149 pass / 3 warning；`release:launch-smoke` 通过。
- 2026-07-08 M9 GitHub 发布准备：新增 `scripts/create-github-release-assets.mjs` 和
  `scripts/release-github-preflight.mjs`，接入 `release:github:*` npm 命令；GitHub Release 采用 multipart 7z 分卷，
  避免单个 asset 超过 2GiB。
