# 合并矩阵 · 顺序内聚 + 批量合并推送 + 批量 MR 设计方案（定稿）

> 状态：方案已与用户确认，待实施。
> 背景：Git Insight 插件「合并矩阵」视图（单 into + 多 from）的迭代。
> 关联代码：`packages/extension/webview/src/MergeMatrix.vue`、`packages/extension/webview/src/BranchTreeSelect.vue`、`packages/extension/webview/src/App.vue`、`packages/core/src/merge/{chain.ts,survey.ts,applyResolve.ts,preview.ts,createMr.ts}`、`packages/extension/src/protocol.ts`、`packages/extension/src/GitInsightPanel.ts`。
> 本文档目的：完整记录已确认的设计决策与技术细节，作为跨会话实施的唯一依据。

---

## 0. 需求总览与已确认决策

四个需求：

1. 「算顺序」按钮移动到矩阵统计行「开始逐条处理」按钮右侧；
2. 排序结果不再在右侧 MERGE ORDER 面板展示，改为直接作用于左侧矩阵（行重排、序号、分隔线），MERGE ORDER 面板移除；
3. 新增「一键处理合并并推送」+「一键申请 MR」两步式批量能力（单总 MR）；
4. 修复下拉「确认加入」与 tag 标签的同步 bug（现状是并集增量，应全量对应）。

已确认决策（用户拍板）：

- 批量结果为**单个总 MR**（一个批量临时分支累积合并所有 from，最后一个 MR 合入 into）。
- 矩阵模式下，冲突解决**不再要求推送**：只做本地 worktree merge + commit 到本地临时分支 `merge/<from>-into-<into>`，推送与 MR 全部收敛到批量流程。单预演页（非矩阵入口）保持旧逻辑（解决即推送）不变。
- push 失败时**保留本地批量分支**并提供「重推」按钮（与现有单对逻辑「失败即删」不同，是有意为之的例外，因批量重算成本高）。
- 批量确认对话框内每行提供**上移/下移**微调按钮（作为后续拖拽的先导），调整后自动重跑干跑预演。
- 已提过 MR 的格子（stage 为 `mr`/`page`）默认排除出批量。

---

## 1. 需求 1+2：「算顺序」移位 & 排序内聚到矩阵

### 1.1 按钮位置

- 从顶部操作区（「跑矩阵」旁边）移到 `matrix-stats` 统计行内，位于「开始逐条处理 / 处理下一条 / 申请 MR」按钮**右侧**。
- 矩阵存在时常驻统计行（不随逐条处理按钮的出现/消失而隐藏）。
- 不可用条件不变：需 1 个线上目标（into）+ ≥2 个 from。disabled 时 tooltip 说明原因。

### 1.2 排序呈现（替代右侧 MERGE ORDER 面板）

点击「算顺序」后不再渲染右侧 aside 的 MERGE ORDER 模块，改为作用于矩阵：

- **行重排**：FROM 行按 `order.best.order`（`SuggestOrderResult`）重排，行首加序号徽标（1、2、3…）。
- **人工分隔线**：在最后一个 `outcome === "clean"` 的步骤之后插入分隔行「── 以下需要人工处理 ──」（对应原面板 blockedAt 语义）。
- **统计 pill**：统计行加 pill「建议顺序可连续干净合入 X / N（原顺序 Y）」。
- **顺序切换**：提供「按建议顺序 / 按原顺序」小切换，随时切回。
- **右侧 aside 退化为纯详情**：保留点格子看冲突文件、去预演、申请 MR 等现有交互；删除 MERGE ORDER 模块。

原 MERGE ORDER 三个交互的落点：点步骤看冲突 → 点格子（已有）；blockedAt 提示 → 分隔行 + pill；顺序对比 → pill 文案。

### 1.3 一致性约束

- `order` 是针对当时选的分支集合算的；行排序前必须校验 `order.into` 与当前矩阵唯一 into 一致、分支集合一致，不一致则忽略排序保持原序（防「改了选择没重跑」的张冠李戴）。
- `conflictQueue` / `pendingQueue` 从 rows 派生，行重排后逐条处理队列自动跟随建议顺序，无需额外改动。

---

## 2. 需求 4：下拉「确认加入」与 tag 全量同步修复

### 2.1 问题定位

`MergeMatrix.vue` 的 `onPickedConfirm` 现状是**并集**：`new Set([...bucket, ...values])`。而 `BranchTreeSelect.vue` 的 multi 面板打开时用 modelValue 初始化勾选、面板内可**取消勾选**，confirm 携带的是面板完整状态。两边语义不一致：取消勾选的分支被并集「复活」；只有增量没有减量。

### 2.2 修复方案

- 删除 `intoPickValue` / `fromPickValue` 中间 ref；`pickValue` 直接 computed 读写 `intos` / `froms`（单一数据源，chips 与下拉勾选天然同源）。
- `onPickedConfirm` 改为**全量赋值** `bucket.value = [...values]`；去掉 `values.length === 0` 的早退（允许确认后清空）。
- `drop()` 中手动同步 pickValue 的代码删除（数据源统一后不再需要）。
- 已确认 multi 模式仅 MergeMatrix 一个调用点（App.vue 两处为单选），不波及其他页面。

---

## 3. 需求 3：一键处理合并并推送 + 一键申请 MR（核心）

### 3.1 总体流程（两步式，永远保持两步）

```
矩阵内逐格解决冲突（本地记录，不推送）
  → 全部就绪后「一键处理合并并推送」
      干跑预演（merge-tree，零副作用，确认对话框内）
      → 用户在对话框内可：排除勾选 / 上移下移微调 / 取消
      → 执行：worktree 累积真合并 → 单次 push 批量分支
  → 「一键申请 MR」
      MR 前终检（merge-tree 预检批量分支 vs 最新 origin/into）
      → 批量分支 → into，单总 MR（复用现有 CreateMrDialog / 三通道）
```

不做一步式的原因：两步的风险边界完全不同——「处理合并并推送」是纯本地计算 + 一次 push，失败无副作用可无限重试；「申请 MR」是外部副作用（占审查队列、触发 CI）。中间留缝让人先看批量分支 diff。

### 3.2 语义变化：矩阵模式下「已解决」不要求推送

- 矩阵模式下冲突解决 = worktree 内 merge + 写入裁决 + commit 到本地分支 `merge/<from>-into-<into>`，**不 push**。推送分支、单分支 MR 都不在解决流程里。
- 单预演页（非矩阵入口）保持现状：解决即推送。
- 好处：远端不再被 N 个 `merge/xxx` 中间分支污染；网络/权限失败点从 N 个收敛到批量 1 个；与单总 MR 语义自洽。
- 解决记录载体 = 本地分支（共享对象库），worktree 移除 / VS Code 重启均持久；survey 已能探测本地临时分支（`local` 档来源），矩阵刷新不丢状态；重跑用 `worktree add -B` 强制重置，不冲突。

配套改动：

- `applyResolve` 新增 `keepLocal` 语义：矩阵模式 `push:false` 时**保留**本地分支（现 finally 里 `!pushSucceeded → removeTempBranch` 会删掉）。
- stage 体系重整：`local` 与 `resolved` 合并为「已解决」档，子标签区分「本地 / 已推送」，两者都具备批量资格。stage 序列调整为 `"open" | "ready" | "resolved"(含 local/resolved) | "page" | "mr"`（实现时可保留内部分档用于展示，但队列/批量资格判断合并）。
- 保留逃生门：格子详情保留单分支「申请 MR」入口，点击时自动先推该临时分支再走现有建单流程（补推送路径不断）。
- 批量成功后提供清理动作：确认后删除参与合并的本地 `merge/*` 临时分支（不静默删）。

### 3.3 批量源选择优先级（每格）

1. 本地分支 `merge/<from>-into-<into>` 存在且 sha 与记录的 commitSha 一致 → 用本地分支；
2. 本地无但远端有同名分支（历史推送的旧格子）→ 用远端 sha，UI 提示「该格子使用已推送版本」；
3. 都没有 → 该格子失效，要求重新解决，拒绝整批启动（同名解析失败同理）。

本地分支只有用户自己能移动（重新解决会 `-B` 重置），sha 护栏天然简单，无远端竞态。

### 3.4 执行引擎：干跑 merge-tree + 实跑 worktree 真合并

**干跑预演（零副作用）**：复用 `chain.ts` 的 merge-tree + commit-tree 串行模拟，关键差异：

- 参与合入的源是「实际会用的源」：干净格子用原分支；已解决格子用其本地临时分支的 sha（按 3.3 优先级解析）。
- 所有 ref 先 fetch 再解析成 sha 并**钉死**，整条链在钉死的 sha 上推演。
- 显式检测 ancestor（up-to-date）跳过，避免造冗余合并提交。
- **在点击时刻用真实源重算，不信任任何缓存/历史计算结果。**

核心动机（用户点名的主风险）：贪心顺序只保证「原始分支串行合入的前缀干净性」；批量流程合入的是「解决过冲突的分支」，它与前面已合入分支间可能产生矩阵完全没测过的新冲突（矩阵只测 from vs into，不测 from 之间；即使算顺序时模拟过 from 之间，解决冲突后的分支内容已变）。**因此预测必须在点击时刻基于真实源重跑。**

**实际执行**：`worktree add`（基于 into 的临时批量分支）→ 逐个 `merge --no-ff` + 每步带合并说明的 commit → 单次 push 批量分支。选真合并而非 merge-tree 纯对象库的原因：merge-tree 不跑 .gitattributes 自定义 merge driver、不应用 `merge.renormalize`、不跑 hooks，真合并保真度最高；且与 `applyResolve.ts`（方案 A）工程模式一致，留有批处理中途解冲突的扩展位。干跑干净的前提下两者结果树应一致（driver 只在冲突时介入），此等价性是技术预演第一条验证项。

**一致性护栏**：干跑钉死的 sha 在实跑开始时重新解析比对；任何 ref 移动 → 自动重跑干跑，不带过期预演往下走。执行中某步 merge 出现干跑未预测到的冲突 → 立即 `merge --abort` + 移除 worktree + 删本地批量分支 + 报告卡在第几步，主工作区全程不动。

### 3.5 交互设计

「一键处理合并并推送」按钮：统计行内、「算顺序」右侧。启用条件：单 into；所有冲突格 stage 为已解决（本地或已推送均可）；无 open/local pending 格子；排除 `mr`/`page` 档。

点击 → 确认对话框，**对话框内自动跑干跑**：

- 干跑干净 → 显示合入清单（序号、分支名、源类型「原分支 / 临时分支本地 / 临时分支远端」、批量分支名），每行带**排除勾选**与**上移/下移**按钮；确认后执行。
- 干跑冲突 → 报告「第 k 步：分支 X 与已合入的 a…k-1 冲突，文件：…」；可选：排除该分支重跑 / 上移下移调整后重跑 / 切「建议顺序/原始顺序」/ 取消回退逐条流程。
- 成功 → 矩阵顶部批量横幅（批量分支名 + 最终 sha）+「一键申请 MR」按钮；push 失败 → 保留本地分支 +「重推」按钮。
- 「一键申请 MR」：source=批量分支，target=into，复用现有 `CreateMrDialog`（cli/token/browser 三通道）。申请前终检：merge-tree 预检「批量分支 → 最新 origin/into」，into 被推进过则预警。

### 3.6 批量分支命名与提交身份

- 分支名含 into slug + 时间戳（如 `merge/batch-into-release-2.4.0-20260821-1530`）；远端已存在同名 → 弹确认后复用/换名，绝不静默覆盖。
- 每步合并 commit message：`merge: <from> into <into> via batch <批量分支名>`（沿用 applyResolve 风格）。
- commit 身份：仓库 user.name/email；未配置回退 git-insight 身份（注明是推送分支，与纯模拟游离 commit 区分）。

### 3.7 风险清单与控制

| 风险 | 控制 |
|---|---|
| 解决后分支与前序合入分支产生新冲突（主风险） | 点击时刻基于钉死 sha 的干跑重算，不信任缓存 |
| 干跑到实跑之间远程/本地 ref 移动 | sha 一致性护栏 + 自动重跑干跑 |
| up-to-date 分支造冗余合并提交 | 干跑显式 ancestor 检测跳过；实跑 `git merge` 天然跳过 |
| 同名/无共祖/解析失败格子 | 拒绝整批启动，明确报错 |
| push 失败 | 唯一远端动作且在最后、单次完成；失败保留本地分支 + 重推按钮 |
| 批量分支名冲突 | 时间戳命名 + 远端存在时弹确认 |
| commit 身份缺失 | 仓库身份 → git-insight 身份回退 |
| LFS/submodule 的 merge-tree 保真度、自定义 merge driver | 已知边界，文档化不阻塞；干跑保守报冲突（方向安全） |
| 单 MR 过大 | UI 给出涉及文件数预警 |
| 解决记录仅在本机（换机器丢失） | UI 引导（已解决格子持续可见、批量按钮就近）；可接受残余风险 |

### 3.8 技术预演（编码前先做，fixture 脚本 + core 层 vitest 用例）

1. merge-tree 干跑结果树 vs worktree 真合并结果树**逐字节 diff 为空**（等价性验证）；
2. 「d 冲突已解决，但 d-resolved 与已合入的 b 冲突」场景 → 干跑能拦住（用户担心的核心场景，不过则方案回炉）；
3. up-to-date 跳过验证；
4. 干跑后人为移动 ref → 护栏触发；
5. 批量分支 push 后 GitLab 正常建 MR。

---

## 4. 实施顺序（三批，每批独立可验收）

**第一批（纯前端低风险）**：需求 1、2、4 —— 只动 `MergeMatrix.vue` + `BranchTreeSelect.vue`。

**第二批（core 干跑 + 确认对话框，无远端副作用）**：需求 3 的干跑引擎 + `batchMergePlan` 协议消息 + 确认对话框 UI（排除/上移下移/重跑）+ 矩阵「已解决不推送」语义改造（applyResolve keepLocal、stage 重整）。

**第三批（执行引擎 + 推送 + 批量 MR）**：core 新增 `batchMerge.ts`（worktree 累积合并 + push + sha 护栏）+ `batchMergeRun` 协议消息 + 批量横幅 / 重推 / 一键申请 MR + MR 前终检 + 技术预演用例补全。

### 涉及文件清单

| 层 | 文件 | 改动 |
|---|---|---|
| webview | `MergeMatrix.vue` | 按钮/排序/分隔线/pill/切换/批量按钮/横幅/确认对话框 |
| webview | `BranchTreeSelect.vue` | （需求 4 如需组件侧配合） |
| extension | `protocol.ts` / `GitInsightPanel.ts` | 新增 `batchMergePlan` / `batchMergeRun` 消息与桥接 |
| core | `merge/batchMerge.ts`（新增） | 干跑 + 实跑 + 护栏 |
| core | `merge/applyResolve.ts` | `keepLocal` 语义 |
| core | `merge/chain.ts` | 复用其串行模拟（如需参数化源） |
| core tests | fixture + vitest | 技术预演 5 项 |

---

## 5. 会话续接要点（给下一个会话的我）

- 本文档即方案唯一依据；实施前重读第 3 节与第 4 节。
- 用户语言：中文。用户是 Git Insight 插件作者，熟悉 git 内部机制（merge-tree/commit-tree/worktree）。
- 关键既有机制：stageOf/tempBranchFor 在 `MergeMatrix.vue`；`SuggestOrderResult` 在 `chain.ts`；`applyStashedResolve` 的 finally 清理逻辑在 `applyResolve.ts:452-457`；multi 下拉确认在 `MergeMatrix.vue` 的 `onPickedConfirm`。
- 已确认不再讨论的决策见第 0 节，勿重复征询。
