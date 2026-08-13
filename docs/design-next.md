# Git Insight · 拓展方向设计稿

> **本文只放尚未实现的东西。** 已发布行为以 [`guide.md`](./guide.md) 为唯一准确来源；落地后相应内容迁进 `guide.md` 并从这里删掉。

## 已落地（说明已迁至 guide.md）

| 方向 | 落点 | guide 章节 |
|------|------|-----------|
| 批量预演原语 | `core/src/merge/survey.ts`、`previewMergeBySha`、`MergePreviewResult.resultTree` | §3.2 |
| 矩阵与合入顺序 | `core/src/merge/chain.ts`、`webview/src/MergeMatrix.vue`、CLI `survey` / `merge-order` | §2.3.1、§3.2 |
| MCP server | `packages/mcp` | §3.4.1 |
| 冲突预警常驻 | `extension/src/mergeWatcher.ts` | §2.3.2 |
| 可插拔 resolver | `core/src/merge/resolvers.ts` | §2.6 |

---

## 还没做的

### A. 矩阵结果的持久化与对比

现在每次「跑矩阵」都是一次性的，关掉面板就没了——连带丢掉的还有「已处理 / 已提 MR」的进度标记。值得存一份到扩展 `globalState`（按 `repoRoot` 分桶），这样能：

- 面板重开时先展示上次结果 + 时间戳，再后台刷新
- 和上次对比，标出「这次新增的冲突」——比一张纯当前态的表更有信息量
- 和冲突预警共用同一份快照，省掉一次重复扫描

要注意的是过期问题：sha 变了旧结果就没意义，展示时必须标明「基于 X 分钟前的 tip」。

### B. 全排列顺序搜索

现在的 `suggestMergeOrder` 用贪心。贪心在「最大化 cleanPrefix」这个目标下不会错（干净合入不会让后续更难），但如果以后目标函数换成别的——比如「让冲突集中在同一个人负责的文件里」「优先合入即将发版的分支」——贪心就不再最优了。

那时候可以对 N ≤ 6 上穷举（720 条链，每条最多 6 次 merge-tree，可接受），N 更大仍用贪心。前提是先想清楚新的目标函数怎么量化。

### C. resolver 的用户级配置

现在 resolver 只能由调用方在代码里传，内置只启用无副作用的 `union`。要让用户自己配 `regenerate`（比如 pnpm lockfile 重算），需要：

1. 在 `~/.git-insight/` 下加一个 `resolvers.json`（**用户级，不是仓库级** —— 原因见 `core/src/merge/resolvers.ts` 文件头的安全边界）
2. 配置页加一个只读展示 + 「打开配置文件」按钮，别做成表单：能执行命令的配置项，走一趟文件编辑反而让人更清醒
3. 首次命中某个 `regenerate` resolver 时弹一次确认，记住选择

### D. 冲突预警接入矩阵

预警现在只看「当前分支 → 目标」一对（或用户显式配的几条）。接上矩阵后可以直接盯一组分支，并在通知里说清楚是哪几条变糟了——目前通知只报总数。

### E. MCP 的结构化输出

现在所有工具都返回 markdown 报告文本。MCP v2 支持 `outputSchema` + `structuredContent`，对 `merge_survey` / `merge_order` 这种结构性强的结果，给模型结构化数据比让它解析表格更可靠。代价是响应变大，需要权衡。
