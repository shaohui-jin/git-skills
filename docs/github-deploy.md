# GitHub 部署说明（真实 git）

## 结论

| 方式 | 能否执行系统 git | 说明 |
|------|------------------|------|
| **GitHub Pages** | ❌ | 只托管静态文件，不能 `clone` / `merge-tree` |
| **本地 `pnpm preview`** | ✅ | 本机路径或输入 `owner/repo` 触发真实 clone |
| **Docker / GHCR 镜像** | ✅ | 云端服务，`GIT_INSIGHT_MODE=remote` 只开 GitHub 仓库 |
| **GitHub Codespaces** | ✅ | 打开仓库 → 自动起预览端口 |

写死样例（`build:demo`）仅供离线看 UI，**不是**部署目标。

## 1. 本地真实 git

```bash
pnpm install
pnpm preview
```

浏览器输入：

- 本机：`D:\path\to\repo`
- 远程：`vuejs/core` 或 `https://github.com/vuejs/core`

服务端会执行 `git clone` / `git fetch`，再跑现有 `@git-insight/core`（`merge-tree` 等）。

## 2. 发布预览镜像到 GHCR

推送到 `main` 或手动跑 workflow：**Publish Preview Image (GHCR)**。

镜像名：`ghcr.io/<owner>/<repo>:latest`

运行：

```bash
docker run --rm -p 8080:8080 \
  -e GIT_INSIGHT_MODE=remote \
  -e GITHUB_TOKEN=<可选，提高限额/拉私有库> \
  -v git-insight-data:/data/repos \
  ghcr.io/<owner>/<repo>:latest
```

打开 `http://127.0.0.1:8080/`，输入 GitHub 仓库地址即可。

环境变量：

| 变量 | 含义 |
|------|------|
| `GIT_INSIGHT_MODE=remote` | 只允许 GitHub URL，禁止本机路径 |
| `GIT_INSIGHT_DATA_DIR` | clone 缓存目录（默认 `/data/repos`） |
| `GIT_INSIGHT_ALLOW_HOSTS` | 默认 `github.com` |
| `GITHUB_TOKEN` / `GH_TOKEN` | 私有库或提高 API/git 限额 |
| `HOST` / `PORT` | 默认 `0.0.0.0:8080` |

健康检查：`GET /healthz`

## 3. 挂到公网（任选）

GHCR 镜像可部署到任意容器平台，例如：

- [Fly.io](https://fly.io) / [Render](https://render.com) / 自有 VPS：`docker pull` + `docker run`
- 需公网 HTTPS 时在前面加反向代理（Caddy / Nginx）

GitHub **没有**内置的长期 Node 托管；Pages 不能替代该服务。

## 4. Codespaces（在 GitHub 上跑真实 git）

仓库已含 [`.devcontainer/devcontainer.json`](../.devcontainer/devcontainer.json)：

1. Code → Codespaces → Create
2. 等待 `postStart` 拉起预览
3. 打开转发的 **5173** 端口
4. 输入本机工作区路径或 `owner/repo`

## 5. Pages 文档站

Settings → Pages → Source = **GitHub Actions**。  
站点只说明如何跑真实预览，**不**提供写死的合并预演数据。

## 6. Release / npm

见原流程：标签 `v*` → GitHub Release；可选 `NPM_TOKEN` + `ENABLE_NPM_PUBLISH=true`。
