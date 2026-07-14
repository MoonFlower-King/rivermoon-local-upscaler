# M11 生图会话式工作台 · Codex 实施方案（2026-07-14 定稿）

## 0. Context（商业动机）

现状生图模块是「单表单 + 全局记录流」，用户实测反馈三个流失点：① 提交后没有并行创作的心智入口（引擎并行度=2 早已支持，纯 UI 呈现问题）；② 生成结果无法继续编辑（edits 链路已在，缺 UI 闭环）；③ 无独立创作上下文。目标形态 = 网页版 img.rivermoon7.com 图片工作台：左侧会话列表、右侧结果流 + 底部参数条。商业意义：编辑闭环提升单会话消耗次数，并行感提升整体用量，会话留存提升复购。

执行者注意：先读 `AGENTS.md`（产品守则）与 `docs/TASKBOARD.md` M11 节。工作分支 `overhaul/engine-ui-vibrancy`。

## 1. 硬性约束（禁区）

1. **主进程/preload/IPC/持久化格式零改动**——`image-queue.ts`、`image-gen.ts`、`image-protocol.ts`、`types.ts` 的 ImageGenTask/ImageGenParams 一律不碰。
2. 纯渲染层工程：`src/renderer/main.tsx` + `styles.css`（若芯片 task_e0d890d3 已拆分文件，则在 `renderer/modules/imagegen.tsx` 内做）。
3. 不删除任何现有能力：模型/比例/尺寸/质量/格式/张数/原生直出/参考图/分镜模板全部保留在底部参数条。
4. 样式只用现有 token 与 `.agent-shell` 体系类，禁止硬编码色值、字重限 400/500/600。
5. 每阶段 `npm run check` 全绿才可进下一阶段；完成后 `npm run release:launch-smoke`。

## 2. 数据模型（渲染层新增，localStorage）

```ts
type ImageConversation = {
  id: string;                 // randomId()
  title: string;              // 首条 prompt 截 80 字；用户可重命名（renamed: true 后不再自动改）
  renamed: boolean;
  taskIds: string[];          // 关联 ImageGenTask.id，按提交顺序
  lastParams: ImageGenParams | null; // 会话参数快照（新任务预填）
  createdAt: number;
  updatedAt: number;
};
const IMAGE_CONV_KEY = "rivermoon-image-conversations-v1";
```

实现**完全照搬 GPT 模块既有模式**（同文件内可直接参考）：`loadAgentConversations`/`normalizeAgentConversation`/80 会话上限/损坏 JSON 回退空数组/`slice(-120)` 式截断（taskIds 截 60）。写 `loadImageConversations`/`normalizeImageConversation`/`saveImageConversations`（存储防抖 400ms，参考 settings 持久化 effect）。

**旧数据迁移**：首次加载若 storage 为空且存在历史 imageTasks，创建一个 `title: "历史生成"` 的会话收纳全部旧 taskIds——升级用户不丢记录。

## 3. 布局规格（复用 .agent-shell 双栏体系）

```text
┌─────────────┬──────────────────────────────────────┐
│ 会话列表      │ 会话内容流（滚动区）                     │
│ [+ 新建]     │   任务卡1（既有 ImageTaskCard 复用）      │
│ ┌─────────┐ │   任务卡2 …（新卡插入顶部，倒序）          │
│ │缩略图 标题│ │                                      │
│ │时间 张数  │ ├──────────────────────────────────────┤
│ └─────────┘ │ 参数条（模型/比例/尺寸/质量/格式/张数/       │
│  …          │  原生直出/参考图/分镜模板 —— 全部现有控件平移）│
│             │ prompt 输入框 + [生成] （Enter 提交）      │
└─────────────┴──────────────────────────────────────┘
```

- 容器类新增 `.imagegen-shell`，规则复制 `.agent-shell`（grid 280px + 1fr、圆角/边框/阴影同款）；左列复用 `.agent-history`/`.agent-conversation` 系列类（选中态已是浅蓝胶囊，勿改）。
- 会话列表项：首任务首图缩略图（`Thumb` 组件，无图显示占位）+ 标题 + 更新时间 + 任务数徽章（`.count-badge`）。
- 右侧内容流：`conversation.taskIds.map(id => tasksById.get(id))` 渲染现有 `ImageTaskCard`（卡片组件本体不改），倒序、`.empty` 空态文案「描述画面开始创作」。
- **并行不互等**：点「生成」即 `startImageTask` 并把返回 task.id push 进当前会话 `taskIds`，输入框立即可再次提交（不 disable，队列并行度 2 自行调度；排队任务卡显示「排队中」现有状态）。

## 4. 编辑闭环（11.3，核心商业功能）

`ImageGenParams.referencePaths` 非空时主进程自动走 `/v1/images/edits`（已实现）。因此：

- `ImageTaskCard` 每张输出图新增「编辑此图」按钮（与现有「超分到 4K」「打开位置」并排）：回调 `onEditImage(outputPath)` → 把该路径写入当前参数条的参考图列表（若已满 20 张则替换首张并 toast 提示）+ 聚焦 prompt 输入框。
- 成功卡保留「再来一张」（同参数重跑，已实现）。
- 「编辑」tab 与「生成」tab 现有切换逻辑保留；onEditImage 自动切到编辑态。

## 5. 交互细节与边界

- 新建会话：清空参数为 `lastParams ?? 合同默认`；删除会话：任务记录本体不删（ImageGenTask 仍在队列持久化里），仅解除关联；删除最后一个会话时自动建空会话（照搬 GPT `deleteConversation`）。
- 任务事件：现有 `onImageTasksUpdated` 订阅不变；会话内容流按 id 映射自然更新，无需新事件。
- 会话切换/重启期间有 running 任务：完全允许（任务归属由 taskIds 决定，与当前选中会话无关）。
- 标题自动生成：首条 prompt 截断；参考 `agentTitleFromMessage`。
- 清空已结束：改为**当前会话内**清空（从 taskIds 移除已终态 id），全局清空入口移除。

## 6. 分阶段提交（每步独立 commit + check 全绿）

1. **C1 数据层**：ImageConversation 模型 + load/normalize/save + 迁移逻辑 + vitest（normalize 容错/迁移/上限截断——纯函数放可测位置，若 main.tsx 未拆分则导出至 `src/renderer/image-conversations.ts` 新纯模块以便 tests/ 直测）。
2. **C2 布局**：双栏壳 + 会话列表 CRUD + 内容流渲染（旧记录视图移除、迁移会话可见）。
3. **C3 编辑闭环**：onEditImage + 参考图回填 + tab 联动 + 「再来一张」回归确认。
4. **C4 打磨**：空态/加载态/低余额时发送前拦截提示（复用 needsTopup 文案）、TASKBOARD M11 状态更新 + 变更日志。

## 7. 验收（全部满足才算完成）

- [ ] 同一会话连发 3 个任务：3 张卡立即出现，前 2 个并行跑、第 3 个排队，互不阻塞输入。
- [ ] 生成 → 点「编辑此图」→ 输出图进参考图 → 改 prompt 再生成 → edits 链路出图（NewAPI 日志可见 /v1/images/edits）。
- [ ] 关闭重开：会话列表、标题、任务关联完好；升级场景旧任务进「历史生成」会话。
- [ ] 删除会话不影响其他会话任务；删光自动建新会话。
- [ ] `npm run check` 全绿（214+ 测试，新增 C1 测试）；`release:launch-smoke` 通过；深浅色双主题目检。
- [ ] 真实 Key GUI 验收：会话内文生图 + 编辑图各一次成功。

## 8. 明确不做（防scope蔓延）

视频模块会话化（另立任务）；会话云端同步；无限画布（AGENTS.md 已预留边界，本期不碰）；prompt 历史搜索。
