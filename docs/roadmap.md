# Git Insight · 开发进度

> 面向协作者与用户：一眼看清「做到哪一步、后面还要做什么」。  
> 操作与技术细节见 [`guide.md`](./guide.md)。

**当前版本（2026-08-15）**

| 组件 | 版本 | 发布渠道 |
|------|------|----------|
| 扩展 `git-insight` | 0.3.0 | Open VSX / Cursor 市场 |
| 引擎 `@shaohui_jin/git-insight-core` | 0.1.0 | monorepo 内 / CLI |
| MCP `@shaohui_jin/git-insight-mcp-server` | 0.1.0 | npm（CI 发版） |

---

## 图例

| 状态 | 含义 |
|------|------|
| ✅ | 已发布（扩展 / CLI / MCP 均可使用，文档已覆盖） |
| 🔶 | 部分交付（部分交付面可用，或能力有已知边界） |
| 📋 | 规划中（设计稿已有，尚未开发） |

---

## 已完成

### 只读预演

| 功能 | 扩展面板 | CLI | MCP | Agent Skill | 状态 |
|------|:--------:|:---:|:---:|:-----------:|------|
| 分支图（G6 可视化） | ✅ | ✅ | ✅ | ✅ | ✅ |
| 单对合并预演（`merge-tree` 只读） | ✅ | ✅ | ✅ | ✅ | ✅ |
| 冲突正文 + 逐块 blame 溯源 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 合并矩阵（多分支 × 多目标） | ✅ | ✅ | ✅ | ✅ | ✅ |
| 合入顺序建议（贪心 cleanPrefix） | ✅ | ✅ | ✅ | ✅ | ✅ |
| 三档预演代价分级（survey / preview / rehearse） | ✅ | ✅ | ✅ | ✅ | ✅ |

### 写操作与协作

| 功能 | 扩展面板 | CLI | MCP | Agent Skill | 状态 |
|------|:--------:|:---:|:---:|:-----------:|------|
| 冲突三栏手动选边 | ✅ | — | — | — | ✅ |
| AI 选边（Cursor Chat 桥） | ✅ | — | — | ✅ | ✅ |
| 机械冲突自动解（`.gitignore` 并集） | ✅ | ✅ | — | ✅ | ✅ |
| 一键解决并推送（独立 worktree） | ✅ | ✅ | 🔶 | ✅ | 🔶 |
| 一键申请 MR/PR（GitHub / GitLab） | ✅ | ✅ | 🔶 | ✅ | 🔶 |
| Git 配置（MR 方式 / Token / 默认 remote） | ✅ | ✅ | — | ✅ | ✅ |

### 常驻与 IDE 集成

| 功能 | 扩展面板 | CLI | MCP | Agent Skill | 状态 |
|------|:--------:|:---:|:---:|:-----------:|------|
| 冲突预警常驻（默认关闭） | ✅ | — | — | — | ✅ |
| Agent Skill `/git-branch-insight` | ✅ | — | — | ✅ | ✅ |
| 扩展深链 `vscode://…/preview?…` | ✅ | — | — | ✅ | ✅ |
| `open_ui` / `open-ui`（含浏览器 fallback） | — | — | — | — | 🗑 0.2.0 移除（github proxy 拦截频发，维护成本高） |
| MCP `npx @shaohui_jin/git-insight-mcp-server` 接入 | — | — | ✅ | — | ✅ |

### 本期新完成（v0.3.1 候选）

| 功能 | 说明 | 状态 |
|------|------|------|
| MR 候选人 5 分钟缓存 | 同仓库+同 channel 复用，skipCandidates 开关跳过 | ✅ |
| BranchTreeSelect 多选模式 | checkbox + 确认/取消，同面板批量选 + 加入 | ✅ |
| 矩阵 fillSuggested 覆盖式 | 去掉 slice(0,6) 上限；二次点击不累加 | ✅ |
| into/from 选择隔离 | pickValue 无法跨模式污染 | ✅ |
| 顶部 toolbar 瘦身 | 移除打开/浏览，Fetch 文字按钮，分支图/矩阵主按钮下放 | ✅ |
| 候选人按 platform 精准匹配 | 修复 `git.xxx` 自定义域名误判 | ✅ |
| stopUiServer 真实关闭 HTTP | 释放端口（随 0.2.0 UI 下线成为历史条目） | ✅ |
| MCP cwd fallback 链 | 请求 > GIT_INSIGHT_MCP_CWD > 启动目录 > 向上找 .git，零配置可用 | ✅ |
| MCP open_ui 浏览器修复 | Windows 改用 PowerShell Start-Process + detached（随 0.2.0 移除） | ✅ |

> MCP 写工具 (`apply_resolve` / `create_mr`) 默认不注册；需 `GIT_INSIGHT_MCP_ALLOW_WRITE=1` + `confirm: true`。

---

## 未完成（功能规划）

### A. 矩阵结果的持久化与对比

**状态**：📋 规划中

现在每次「跑矩阵」都是一次性的，关掉面板就没了——连同丢掉「已处理 / 已提 MR」的进度标记。值得存一份到扩展 `globalState`（按 `repoRoot` 分桶），这样能：

- 面板重开时先展示上次结果 + 时间戳，再后台刷新
- 和上次对比，标出「这次新增的冲突」——比一张纯当前态的表更有信息量
- 和冲突预警共用同一份快照，省掉一次重复扫描

**风险**：sha 变了旧结果就没意义，展示时必须标明「基于 X 分钟前的 tip」。

---

### B. 全排列顺序搜索（N ≤ 6）

**状态**：📋 规划中

现在的 `suggestMergeOrder` 用贪心。贪心在「最大化 cleanPrefix」这个目标下不会错（干净合入不会让后续更难），但如果目标函数换成：

- 「让冲突集中在同一个人负责的文件里」
- 「优先合入即将发版的分支」

贪心就不再最优。那时可以对 N ≤ 6 上穷举（720 条链，每条最多 6 次 merge-tree，可接受），N 更大仍用贪心。前提是先想清楚新的目标函数怎么量化。

---

### C. resolver 用户级配置（方案 1：纯预设模板）

**状态**：📋 规划中

**目标**：让用户能启用"机械冲突自动重算"（如 `pnpm-lock.yaml` 重算），替代 manual 选边。

**已确定方向（方案 1，纯预设模板）**：不做自由 JSON 配置，改为配置页内置一组预设模板，用户在 UI 里勾选启用，`cmd`/`args` 全部写死在代码里。理由：`regenerate` 类 resolver 会执行命令，自由配置即 RCE 风险（见 `core/src/merge/resolvers.ts` 文件头安全边界）；预设模板让代码侧完全可控、配置侧不可能注入，也贴合"配置页不做复杂表单"的现有取向。

**交互设计**：配置页新增折叠档「冲突自动解决（resolver）」，沿袭现有 `ai-section-toggle` 折叠交互：

- 总开关（默认关）：勾选才加载预设模板；不勾选 = 现状（仅内置 `union`，`.gitignore` 类文件自动取并集），`resolvers.json` 完全被忽略。这是"配置有问题时不走"的逃生通道。
- 勾选后列出预设模板，每条一个复选框单独开关。
- 所有模板的 `cmd`/`args` 固定，用户只能选，不能写。
- 配置加载失败/含非法项时亮出错误，且**静默回落内置 `union`**，绝不崩掉 `applyResolve` 流程。

**内置模板初始覆盖**（占位，落地时按真实场景补充）：`pnpm-lock`（`pnpm-lock.yaml` → `pnpm install --lockfile-only`）、`npm-lock`（`package-lock.json` → `npm install --package-lock-only`）、`yarn-lock`（`yarn.lock` → `yarn install`）等。

**落地步骤**：
1. `core` 侧：白名单内建模板 `cmd` 集合（`pnpm/npm/yarn/bun/node/git` 起步）；用 `execFile` 执行，不经 shell；`args` 为固定字面量。
2. `extension` 侧：配置页 UI（总开关 + 单条勾选）；加载/解析失败回落内置 union。
3. 用户级开关的持久化：放入现有 `user-config.json`（结构扩展，不影响现有键）。

---

### C-2. resolver 级联参数（方案 2，后续演进）

**状态**：📋 规划中（方案 1 落地并稳定后再评估）

**上下文 / 为什么会有这个需求**：方案 1（纯预设模板）覆盖当前真实痛点（lockfile 重算），但模板是写死的，用户若有特殊文件类型想对接某个命令，必须等开发者加模板。方案 2 让用户在 UI 里"新建一条 resolver"，通过预设 + 级联选择表达更灵活的规则，仍保持代码侧可控。

**目标形态**：配置页允许用户创建 resolver：
- 第 1 级下拉：选择命令（限白名单，如 `pnpm/npm/yarn/bun/node/git`）。
- 第 2 级级联：根据所选命令，展开**该命令逻辑中已预设好的参数枚举**，只能从枚举里选，不能自由输入。
- `match`（路径匹配）也从预设 glob/pattern 里选，或限定的匹配规则。

**前置条件**：
1. 方案 1 的模板机制、白名单、`execFile` 执行链路、UI 开关早已落地并稳定，方案 2 在其上扩展，**不另起炉灶**。
2. 需要为每个白名单命令盘出"合法可用的参数枚举集"，并明确各参数组合的语义——这是方案 1 没有的额外工程量（方案 1 只需固定模板）。
3. 持久化结构：user-config 中 extension 现有的开关键之上，新增一个"自定义 resolver 数组"字段；仍走 `execFile` 不过 shell。

**风险 / 取舍**：
- **复杂度显著升高**：为每个命令维护参数枚举，工作量与维护成本远超方案 1；枚举覆盖不到用户想要的参数时，用户仍会被卡住 → 可能诱发"放开输入"的冲动，从而回落 RCE 风险，需在 UI/文档上明确边界。
- **与"配置页不做复杂表单"取向的冲突**：级联表单比方案 1 的纯勾选复杂，可能违背现有的极简设计；落地前要评估是否值得为少量自定义场景牺牲模板的简洁性。
- **新增突破面**：级联枚举若实现有漏洞（如某参数被拼接进 shell），会把用户勾选的配置变成注入点。安全校验必须最强（`execFile` + 参数字面量），并回归测试多命令组合。
- **验收标准参考**：方案 2 的价值 = 能否在"不开 shell、不动白名单、不写自由文本"的前提下，覆盖方案 1 之外的真实高频场景。若覆盖面改善有限，则不做的理由充分。

---

### D. 冲突预警接入矩阵

**状态**：📋 规划中

预警现在只看「当前分支 → 目标」一对（或用户显式配的几条）。接上矩阵后可以直接盯一组分支，并在通知里说清楚是哪几条变糟了——目前通知只报总数。

---

### E. MCP 结构化输出（outputSchema）

**状态**：📋 规划中

现在所有 MCP 工具都返回 markdown 报告文本。MCP v2 支持 `outputSchema` + `structuredContent`，对 `merge_survey` / `merge_order` 这种结构性强的结果，给模型结构化数据比让它解析表格更可靠。代价是响应变大，需要权衡。

---

### G. 原生确认弹窗改自绘（WebView 内嵌确认框）

**状态**：📋 已定方案甲（可开发）

**上下文 / 为什么有这个需求**：一键解决并推送、一键申请 MR 等写操作目前走扩展侧的 `vscode.window.showWarningMessage(..., { modal: true }, "继续")`（见 `GitInsightPanel.ts` 第 452 / 482 行），弹的是 Cursor/VS Code 原生白底模态框，与 WebView 的深/浅自定义主题割裂，视觉突兀。这两个确认都是"用户在面板内操作才触发"，确认后关窗继续、取消关窗不执行，均为非阻塞语义，**不需要系统级后台触达**，适合改自绘。

**已定方向（方案甲）**：拆掉宿主白框，改由 WebView 自绘确认承载。核心差异在 createMr：

- `applyResolve`（一键解决并推送）：目前**无**前置弹窗，白框是唯一一次确认。改用一个自绘确认框替代它。
- `createMr`（一键申请 MR）：目前已是"自绘表单 `CreateMrDialog` → 宿主白框二次确认"两级。白框是冗余确认，**直接移除**，由表单里的「创建」按钮承载确认意图（按钮用危险强调色，文案注明"将立即创建"）。

**任务清单**：

1. **新增通用确认框组件 `ConfirmDialog.vue`**（注意：**不能命名为 MrDialog 这类写死 MR 的名字**，因为 applyResolve 与 createMr 共用）：
   - 复用现有自绘弹窗样式基座：`.mr-dialog-mask`（遮罩）+ `.mr-dialog.card`（主体）+ `.mr-dialog-head`（标题栏）+ `.mr-dialog-actions`（按钮区），见 `styles.css` 第 1850-1895 / 2299 行。亮/暗两套色走现有 CSS 变量，不写死色值。
   - Props：`open: boolean`、`title: string`、`message: string`、`confirmLabel?: string`（默认「确认」）、`cancelLabel?: string`（默认「取消」）、`danger?: boolean`（true 时确认按钮用危险色）、`busy?: boolean`。
   - Emits：`confirm`、`cancel`。
   - 交互与现成 Dialog 保持一致：`v-if="open"` 条件渲染、遮罩 `@click.self="emit('cancel')"`（防误触点遮罩关窗）、确认按钮 `@click="emit('confirm')"`。**不做任何定时/延时/自增逻辑**。
   - 不做额外封装：只做大白话的 props/emit 传递，不引入状态机、不预判调用方。

2. **App.vue 接线**：
   - `applyResolve`：新增 `ref<{payload}` 存待确认请求；在 `onApplyResolve`（现状第 135 行）**postMessage 之前**先置该 ref 并打开 `ConfirmDialog`；用户点『继续』再真正 postMessage，点『取消』清空 ref 并置错误「已取消一键解决」。
   - `createMr`：在 `submitCreateMr`（现状第 348 行）直接 postMessage，**不新增确认框**；仅把表单「创建」按钮置危险强调色 + 提示 "将立即创建 MR，确认后不可撤销"。确认语义由表单承载。
   - 在模板 CreateMrDialog 附近挂载 `<ConfirmDialog>`。

3. **GitInsightPanel.ts**：
   - 删除 `applyResolve` 分支的 `showWarningMessage`（第 452-466 行）及其 `pick !== "继续"` 取消回包（第 467-474 行）。
   - 删除 `createMr` 分支的 `showWarningMessage`（第 482-487 行）及其取消回包（第 488-491 行）。
   - 确认后请求照常往下走 `handleWebviewRequest`，不再有宿主拦截。

4. **取消语义**：自绘确认框取消时，WebView 复用现有通用 error 分支（App.vue 654-672），message 沿用现状文案（约 `已取消一键解决` / `已取消创建 MR`），不再依赖宿主 `CANCELLED` 回包。

**验收标准**：
- 一键解决并推送：点按钮 → 自绘确认框（主题统一）→ 确认执行 / 取消不执行。
- 一键申请 MR：表单点「创建」→ 直接创建，不再弹二级确认。
- 通知类弹窗（`mergeWatcher.ts` 第 352 行）**保留原生**，不改。

**风险 / 取舍**：
- **applyResolve 确认拦截必须在 postMessage 前**：自绘框未确认时绝不能发出写请求；取消路径必须清空待确认 ref。
- createMr 少一层防误触：以表单本身（选分支/填标题/点创建）承载确认意图，误触概率极低，可接受。
- 不写"特殊的定时操作 / 猜测性逻辑"：确认框关闭与请求发送严格由用户点击事件驱动，无自动触发。

---

### F. 浏览器面板体验补齐（Phase 2）

**状态**：🗑 已废弃（随 v0.2.0 移除浏览器面板：github proxy 拦截频发，MCP/UI 耦合维护成本高）

- Git 配置持久化（localStorage）
- `open_ui` 深链到矩阵 / 分支图 Tab
- 浏览器内 AI 选边（HTTP 桥）

---

## 发版

| 产物 | Tag 规则 | CI |
|------|----------|-----|
| 扩展 VSIX | `v{version}` | `release-on-version.yml` → Open VSX |
| MCP npm 包 | `mcp-server-v{version}` | `release-mcp-server.yml` → npm |

两流水线互不抢 tag；version 数字不必同步。

---

## 变更记录

| 日期 | 说明 |
|------|------|
| 2026-08-15 | **v0.3.1 候选**：矩阵多选、into/from 选择隔离、MR 候选人 5 分钟缓存、toolbar 瘦身至仅保留 Fetch、多个稳定性修复 |
| 2026-08-14 | 初版：合并矩阵 / 顺序 / MCP / 预警等 v0.3.0 能力；MCP 浏览器 auto UI + npm 发版 |
