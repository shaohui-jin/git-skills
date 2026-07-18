---
name: git-branch-insight
description: >-
  Analyzes Git branch lineage and runs merge rehearsal (conflicts + content +
  provenance). Defaults to git fetch. Use for branch graphs and merge preview.
---

# Git Branch Insight

完整说明见仓库 [skills/git-branch-insight/SKILL.md](../../../skills/git-branch-insight/SKILL.md)。

```bash
pnpm --filter @git-insight/core exec node dist/cli.js graph
pnpm --filter @git-insight/core exec node dist/cli.js preview-merge --into <目标> --from <待合并>
```

合并预演结果若有冲突，必须展示冲突文件列表与 `conflictContent` 正文，不能只报「有冲突」。
