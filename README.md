# git-skill

Git 分支溯源、合并冲突预演，以及 Cursor/VS Code 扩展内的一键解决冲突与申请 MR。

核心是一句话：**用 `git merge-tree` 在对象库里把合并算一遍，不碰工作区**。所以「合不合得进去」这个问题可以随便问、反复问，不用先切分支也不用怕留下烂摊子。

- **合并预演** —— 单对分支，给冲突文件、冲突正文和逐块溯源（谁在哪个 commit 改的）
- **合并矩阵** —— 多条分支 × 多个目标，一屏看清谁合得进去
- **合入顺序建议** —— 多条分支要进同一个目标时，推演最省事的次序
- **一键解决并推送** —— 在独立 worktree 里落盘，主工作区全程不动
- **冲突预警常驻**（默认关闭）—— 后台盯着，只在变糟时提醒
- **申请 MR / PR** —— GitHub / GitLab，走本机 CLI 或 Token

安装 **Git Insight** 扩展后，还可在任意仓库用 Agent Skill：`/git-branch-insight` + 需求（扩展启动时会同步到 `~/.cursor/skills/`）。

## 文档

→ **[docs/guide.md](docs/guide.md)**（主流程 · 各模块 git/gh/glab 指令 · 核心实现 · Skill · **§五 指令一览**）  
→ **[docs/roadmap.md](docs/roadmap.md)**（**功能清单与实现进度**，扩展市场说明用）

扩展约定摘要：目标分支仅远程；我的分支可本地；同名分支（如 `master` ↔ `origin/master`）请自行 push / pull，不走本工具 MR。

## 包

| 包 | 说明 |
|----|------|
| `packages/core` | 引擎 + CLI，不依赖 VS Code |
| `packages/extension` | Cursor / VS Code 扩展（含 webview） |
| `packages/mcp` | MCP server `@shaohui_jin/git-insight-mcp-server`（npm；含浏览器 UI fallback） |

功能与实现进度见 **[docs/roadmap.md](docs/roadmap.md)**。

## 快速命令

```bash
pnpm install
pnpm --filter @shaohui_jin/git-insight-core build
pnpm package:vsix
cursor --install-extension git-insight.vsix --force
```

扩展 ID：`jinshaohui.git-insight`。装完 Reload，Agent 输入 `/git-branch-insight` 再说需求即可。
