# 部署与在线查看

## 在线怎么打开？（gh-pages 分支，和其他项目一样）

本仓库 workflow **Deploy gh-pages** 会在推送 `main` 后：

1. 构建静态预览页  
2. **强制推送到 `gh-pages` 分支**（orphan，只含站点文件）

### 你需要做的（只需一次）

1. 把代码推到 GitHub（`main` / `master`）
2. 打开仓库 **Settings → Pages**
3. **Build and deployment → Source** 选 **Deploy from a branch**
4. Branch 选 **`gh-pages`**，目录选 **`/ (root)`**，保存
5. 等 1～3 分钟（Actions 里 `Deploy gh-pages` 变绿，且 Pages 显示 Active）

### 访问地址

```text
https://<你的用户名或组织>.github.io/<仓库名>/
```

例如仓库是 `https://github.com/alice/git-skill`，则：

```text
https://alice.github.io/git-skill/
```

也可在仓库首页右侧 **Environments / Pages**，或 Settings → Pages 顶部的访问链接进入。

手动触发：Actions → **Deploy gh-pages** → Run workflow。

---

## 静态站 vs 真实 git

| 方式 | 在线地址 | 能否执行系统 git |
|------|----------|------------------|
| **`gh-pages`（本流程）** | `*.github.io/<repo>/` | ❌ 只能看 UI / 样例数据 |
| **本地 `pnpm preview`** | `http://127.0.0.1:5173` | ✅ |
| **Docker / GHCR** | 你自己的服务器域名 | ✅ |
| **Codespaces** | Codespaces 转发端口 | ✅ |

Pages / `gh-pages` **不能**替代带 Node + git 的预览服务。

---

## 本地真实 git

```bash
pnpm install
pnpm preview
# 输入本机路径，或 owner/repo
```

## Docker / GHCR（真实 git）

推送 `main` 后另有 workflow **Publish Preview Image (GHCR)**。

```bash
docker run --rm -p 8080:8080 \
  -e GIT_INSIGHT_MODE=remote \
  ghcr.io/<owner>/<repo>:latest
```

## Codespaces

仓库含 `.devcontainer`：Code → Codespaces → Create，打开转发的 5173。

## 环境变量（容器）

| 变量 | 含义 |
|------|------|
| `GIT_INSIGHT_MODE=remote` | 只允许 GitHub URL |
| `GITHUB_TOKEN` | 私有库 / 提高限额 |
| `GIT_INSIGHT_DATA_DIR` | clone 缓存目录 |

## 若仓库是 `username.github.io` 根站点

把 workflow 里 `VITE_BASE` 改成 `/`，否则资源路径会多一层仓库名。
