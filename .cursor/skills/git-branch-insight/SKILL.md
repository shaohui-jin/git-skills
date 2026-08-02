---
name: git-branch-insight
description: Analyzes Git branch lineage and runs merge rehearsal (conflicts + content + provenance). Defaults to git fetch. Use for branch graphs and merge preview.
---

# Git Branch Insight

完整说明见 [docs/guide.md](../../../docs/guide.md)（§四 Skill；§2 指令表）。

扩展约定：`--into` / 目标应为远程分支；同名（如 `master` ↔ `origin/master`）不走 MR，请用户自行 push / pull。

```bash
pnpm --filter @git-insight/core exec node dist/cli.js graph
pnpm --filter @git-insight/core exec node dist/cli.js preview-merge --into <远程目标> --from <待合并>
```

合并预演若有冲突，必须展示冲突文件列表与 `conflictContent` 正文，不能只报「有冲突」。
