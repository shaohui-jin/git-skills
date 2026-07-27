---
name: git-branch-insight
description: >-
  Analyzes Git branch lineage and runs merge rehearsal between any two branches
  (conflict files, conflict content with markers, and authorship provenance)
  via merge-tree without touching the worktree. Defaults to git fetch before
  analysis. Use for branch graphs, merge preview, merge conflicts, conflict
  sources, or comparing local/remote branches.
---

# Git Branch Insight（Skill）

**完整说明维护于仓库文档（以此为准）：**

→ [`docs/skill.md`](../../docs/skill.md)

请先用 Read 工具读取该文件，再严格按其「CLI / Agent 工作流 / 不要做的事」执行。

摘要：

- 引擎：`@git-insight/core` CLI（`git-insight graph` / `preview-merge` / `fetch`）
- 只读预演，禁止为预演执行真实 `merge` / `checkout` / `push`
- 默认先 fetch；用户要求离线时加 `--no-fetch`
- 冲突时必须转述冲突正文与溯源，不能只说「有冲突」
- 扩展一键解决 / MR 见 [`docs/user-guide.md`](../../docs/user-guide.md)
