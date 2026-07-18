# git-skill

Git 分支溯源与合并冲突预演：可发布的 npm 引擎 + Cursor Skill +（后续）网页可视化扩展。

## 结构

```text
packages/core                 @git-insight/core     — CLI + 库（主交付）
packages/extension            git-insight           — Cursor/VS Code 扩展 + Webview（次交付）
packages/extension/webview    @git-insight/webview  — 可视化前端
skills/git-branch-insight                           — Cursor Agent Skill
docs/plan-git-branch-insight.md                     — 计划保留稿
```

## 快速开始

```bash
pnpm install
pnpm --filter @git-insight/core build

# 在任意 git 仓库中：
pnpm --filter @git-insight/core exec node dist/cli.js graph
pnpm --filter @git-insight/core exec node dist/cli.js preview-merge --into main --from feature/x
pnpm --filter @git-insight/core exec node dist/cli.js conflict-blame --into main --from feature/x
```

默认会先 `git fetch`；加 `--no-fetch` 可跳过。

## Skill（主交付）

见 [skills/git-branch-insight/SKILL.md](skills/git-branch-insight/SKILL.md)。

## 扩展网页（次交付）

### 本地浏览器预览（Vue + G6，推荐先这样看）

```bash
pnpm install
pnpm preview
# 浏览器打开 http://127.0.0.1:5173/
# 指定仓库：
pnpm preview:repo -- --cwd D:\path\to\repo
```

也可在网页顶部输入路径「打开路径」，或点「浏览…」选目录（走系统对话框，**不需要 HTTPS**；扩展里同理用 Cursor 宿主选目录）。

### 装进 Cursor / VS Code

```bash
pnpm build
```

然后 F5 调试扩展，或「Install Extension from Location」选择 `packages/extension`，执行：

- `Git Insight: Open Web Visualization`

详见 [packages/extension/README.md](packages/extension/README.md)。

## 设计要点

- 冲突预演：任意两分支名（本地或 `origin/xxx`），`merge-tree`，不改工作区
- 远程：fetch 后本地算，不依赖平台 PR
- Skill / 网页加载图与合并预演默认 fetch

## 在线查看（gh-pages，和其他项目一样）

推送到 GitHub 的 `main` 后，Actions **Deploy gh-pages** 会把站点打进 **`gh-pages` 分支**。

1. **Settings → Pages → Source** 选 **Deploy from a branch**
2. Branch 选 **`gh-pages`**，目录 **`/ (root)`**，保存
3. 打开：

```text
https://<用户名>.github.io/<仓库名>/
```

（静态 UI / 文档；要真实 git 仍用下面本地或 Docker。）

## 真实 git 预览

| 方式 | 说明 |
|------|------|
| `pnpm preview` | 本机路径，或输入 `owner/repo` → 服务端 `git clone` |
| **Docker / GHCR** | `GIT_INSIGHT_MODE=remote` |
| **Codespaces** | 见 `.devcontainer` |

```bash
pnpm preview
# 或
docker run --rm -p 8080:8080 -e GIT_INSIGHT_MODE=remote \
  ghcr.io/<owner>/<repo>:latest
```

详见 [docs/github-deploy.md](docs/github-deploy.md)。

