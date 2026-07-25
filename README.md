# git-skill

Git 分支溯源、合并冲突预演，以及 Cursor/VS Code 扩展内的一键解决冲突与申请 MR。

## 文档（仅两份）

| 文档 | 说明 |
|------|------|
| [skills/git-branch-insight/SKILL.md](skills/git-branch-insight/SKILL.md) | **Skill**：Agent 用 CLI 做分支图 / 合并预演（只读） |
| [docs/project-design.md](docs/project-design.md) | **项目整体设计**：包结构、业务流、各模块与 git/gh/glab 指令表 |

## 结构

```text
packages/core                 @git-insight/core     — CLI + 库（引擎）
packages/extension            git-insight           — Cursor/VS Code 扩展
packages/extension/webview    @git-insight/webview  — Vue + G6 前端
skills/git-branch-insight                           — Agent Skill
docs/project-design.md                              — 整体设计
```

## 快速开始

```bash
pnpm install
pnpm --filter @git-insight/core build

# 任意 git 仓库：
pnpm --filter @git-insight/core exec node dist/cli.js graph
pnpm --filter @git-insight/core exec node dist/cli.js preview-merge --into main --from feature/x
```

默认会先 `git fetch`；加 `--no-fetch` 可跳过。

## 扩展

```bash
# 浏览器预览
pnpm preview

# 打包安装
pnpm package:vsix
cursor --install-extension git-insight.vsix --force
```

详见 [packages/extension/README.md](packages/extension/README.md)。
