# git-skill

Git 分支溯源、合并冲突预演，以及 Cursor/VS Code 扩展内的一键解决冲突与申请 MR。

安装 **Git Insight** 扩展后，还可在任意仓库用 Agent Skill：`/git-branch-insight` + 需求（扩展启动时会同步到 `~/.cursor/skills/`）。

## 文档

→ **[docs/guide.md](docs/guide.md)**（主流程 · 各模块 git/gh/glab 指令 · 核心实现 · Skill · **§五 指令一览**）

扩展约定摘要：目标分支仅远程；我的分支可本地；同名分支（如 `master` ↔ `origin/master`）请自行 push / pull，不走本工具 MR。

## 快速命令

```bash
pnpm install
pnpm --filter @git-insight/core build
pnpm package:vsix
cursor --install-extension git-insight.vsix --force
```

扩展 ID：`jinshaohui.git-insight`。装完 Reload，Agent 输入 `/git-branch-insight` 再说需求即可。
