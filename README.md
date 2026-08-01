# git-skill

Git 分支溯源、合并冲突预演，以及 Cursor/VS Code 扩展内的一键解决冲突与申请 MR。

## 文档

→ **[docs/guide.md](docs/guide.md)**（主流程 · 各模块 git/gh/glab 指令 · 核心实现 · Skill）

## 快速命令

```bash
pnpm install
pnpm --filter @git-insight/core build
pnpm package:vsix
cursor --install-extension git-insight.vsix --force
```

扩展 ID：`jinshaohui.git-insight`。发布到 Cursor 市场（Open VSX）：见 **[docs/guide.md §3.6](docs/guide.md#36-发布到-cursor-市场open-vsx)**。
