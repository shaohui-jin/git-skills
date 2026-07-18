---
name: git-branch-insight
description: >-
  Analyzes Git branch lineage and runs merge rehearsal between any two branches
  (conflict files, conflict content with markers, and authorship provenance)
  via merge-tree without touching the worktree. Defaults to git fetch before
  analysis. Use when the user asks about branch graphs, merge preview, merge
  conflicts, conflict sources, or comparing local/remote branches.
---

# Git Branch Insight

用 `@git-insight/core`（CLI：`git-insight`）分析当前仓库。不要手写脆弱的 git 解析；优先跑 CLI，再把 `report` / `mermaid` 用中文转述给用户。

## 前置条件

- 系统已安装 Git >= 2.38
- 在目标仓库根目录执行，或传 `--cwd <repo>`
- 本 monorepo 内先构建：`pnpm --filter @git-insight/core build`
- 调用：`pnpm --filter @git-insight/core exec node dist/cli.js <command> ...`

## 默认行为

- **默认 fetch**：`graph` / `preview-merge` 都会先 `git fetch --prune origin`（失败则继续用本地 refs）
- 仅当用户明确要求「不要拉远端 / 离线」时加 `--no-fetch`
- **不修改工作区**：合并预演只用 `merge-tree` + `merge-file -p`

## 命令

### 1. 分支图（可零参）

```bash
git-insight graph
git-insight graph --into main --from feature/x
```

### 2. 合并预演（任意两分支；含冲突正文与溯源）

```bash
git-insight preview-merge --into <目标分支> --from <待合并分支>
```

兼容旧名（行为相同）：

```bash
git-insight conflict-blame --into <目标> --from <待合并>
```

结果必须完整转述：

- 可干净合并 **或** 冲突文件列表
- **每个冲突文件的冲突内容**（含 `<<<<<<<` 标记文本，来自 `data.conflictFiles[].conflictContent`）
- 两侧写入来源（作者 / commit，来自 hunks / blamed）
- 优先展示 `report` 字段（已含上述内容）

### 3. 仅 fetch

```bash
git-insight fetch
```

## Agent 工作流

1. 确认仓库路径
2. 映射意图 → `graph` 或 `preview-merge`
3. 执行 CLI，解析 JSON
4. `ok: false` → 解释 `error`
5. `ok: true`：
   - 展示 `report`（中文）
   - 若有冲突，**不得只说「有冲突」**，必须列出文件并展示冲突内容 / 溯源要点
   - 需要图时附上 `mermaid`

## 输出约定

```markdown
## 结论
（干净合并 / 冲突 N 个文件）

## 冲突详情
（每个文件：路径、溯源、冲突内容代码块）

## 图
```mermaid
…
```
```

## 不要做的事

- 不要为了预演执行真实 `git merge` / `checkout`
- 不要把 PR 号当作核心参数
- 不要跳过默认 fetch（除非用户要求离线）
- 冲突时不要只汇报「失败/有冲突」而省略冲突正文

## 更多

- [examples.md](examples.md)
- [reference.md](reference.md)
