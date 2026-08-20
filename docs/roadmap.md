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

### C. resolver 用户级配置

**状态**：📋 规划中

现在 resolver 只能由调用方在代码里传，内置只启用无副作用的 `union`。要让用户自己配 `regenerate`（如 pnpm lockfile 重算），需要：

1. 在 `~/.git-insight/` 下加 `resolvers.json`（**用户级，不是仓库级** —— 原因见 `core/src/merge/resolvers.ts` 文件头安全边界）
2. 配置页加只读展示 + 「打开配置文件」按钮，别做成表单（能执行命令的配置项，走一趟文件编辑反而让人更清醒）
3. 首次命中某个 `regenerate` resolver 时弹一次确认，记住选择

---

### D. 冲突预警接入矩阵

**状态**：📋 规划中

预警现在只看「当前分支 → 目标」一对（或用户显式配的几条）。接上矩阵后可以直接盯一组分支，并在通知里说清楚是哪几条变糟了——目前通知只报总数。

---

### E. MCP 结构化输出（outputSchema）

**状态**：📋 规划中

现在所有 MCP 工具都返回 markdown 报告文本。MCP v2 支持 `outputSchema` + `structuredContent`，对 `merge_survey` / `merge_order` 这种结构性强的结果，给模型结构化数据比让它解析表格更可靠。代价是响应变大，需要权衡。

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
