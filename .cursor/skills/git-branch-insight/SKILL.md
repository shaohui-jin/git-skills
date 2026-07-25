---
name: git-branch-insight
description: >-
  Analyzes Git branch lineage and runs merge rehearsal (conflicts + content +
  provenance). Defaults to git fetch. Use for branch graphs and merge preview.
---

# Git Branch Insight

完整 Skill 见 [skills/git-branch-insight/SKILL.md](../../../skills/git-branch-insight/SKILL.md)。  
项目整体设计（含扩展 / 指令表）见 [docs/project-design.md](../../../docs/project-design.md)。

```bash
pnpm --filter @git-insight/core exec node dist/cli.js graph
pnpm --filter @git-insight/core exec node dist/cli.js preview-merge --into <目标> --from <待合并>
```

合并预演若有冲突，必须展示冲突文件列表与 `conflictContent` 正文，不能只报「有冲突」。
