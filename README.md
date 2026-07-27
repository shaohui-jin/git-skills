# git-skill

Git 分支溯源、合并冲突预演，以及 Cursor/VS Code 扩展内的一键解决冲突与申请 MR。

## 文档

**所有说明均在 [`docs/`](docs/) 目录：**

| 文档 | 说明 |
|------|------|
| [docs/README.md](docs/README.md) | 文档索引 |
| [docs/user-guide.md](docs/user-guide.md) | 使用说明（含 Fetch 鉴权路径） |
| [docs/project-design.md](docs/project-design.md) | 整体设计与指令表 |
| [docs/extension.md](docs/extension.md) | 扩展安装 / 预览 / 打包 |
| [docs/core.md](docs/core.md) | core CLI / API |
| [docs/skill.md](docs/skill.md) | Agent Skill 说明 |

## 快速命令

```bash
pnpm install
pnpm --filter @git-insight/core build
pnpm package:vsix
cursor --install-extension git-insight.vsix --force
```

详见 [docs/user-guide.md](docs/user-guide.md)。
