# Git Insight 扩展（次交付）

在 Cursor / VS Code 中打开 **网页版可视化**（Webview），能力全部来自 `@git-insight/core`。

## 功能

| 能力 | 说明 |
|------|------|
| 分支图 | G6 可视化 + 中文报告 |
| **合并预演** | 任意两分支：是否可合并、冲突文件、冲突正文、来源溯源 |
| **Fetch 按钮** | 手动 `git fetch --prune origin`（网页端默认不自动 fetch） |

## 命令

- `Git Insight: Open Web Visualization`
- `Git Insight: Preview Merge Conflicts`
- `Git Insight: Trace Conflict Sources`

## 本地浏览器预览（不装扩展）

前端为 **Vue 3 + AntV G6**（分支图可视化；选型见 [docs/graph-engine.md](../../docs/graph-engine.md)）。在仓库根目录：

```bash
pnpm install
pnpm preview
```

浏览器打开 http://127.0.0.1:5173/ 。

### 指定仓库的方式

1. **启动参数**
   ```bash
   pnpm preview:repo -- --cwd D:\path\to\your\repo
   ```
2. **网页输入本机路径** → 「打开」
3. **网页输入 GitHub** → `owner/repo` 或 `https://github.com/owner/repo`（服务端真实 `git clone`）
4. **「浏览…」** → 本机系统对话框（仅本地预览 / 扩展）

云端部署（Docker / GHCR / Codespaces）见 [docs/github-deploy.md](../../docs/github-deploy.md)。

### 关于 HTTPS（常见误解）

浏览器自带的 `showDirectoryPicker` / 部分目录 API **确实要求安全上下文（HTTPS 或 localhost）**。  
**本项目没有用那套 API**，因此：

| 场景 | 协议 | 能否选目录 |
|------|------|------------|
| `pnpm preview`（http://127.0.0.1） | HTTP | 能：WebSocket → Node → 系统对话框；或手输路径 |
| Cursor / VS Code 扩展 Webview | `vscode-webview://`（不是浏览器 HTTP 页） | 能：`vscode.window.showOpenDialog` |

`http://127.0.0.1` 本身也是浏览器认定的安全上下文；即便如此，我们仍走宿主选目录，避免拿不到绝对路径。

页面内还可：**Fetch**、分支图、冲突预演、冲突溯源（均走 `@git-insight/core`）。

## 开发构建

```bash
pnpm install
pnpm --filter @git-insight/core build
pnpm --filter git-insight build
```

## 在 Cursor / VS Code 中加载

1. 打开本仓库或任意 Git 仓库作为工作区
2. 运行「Developer: Install Extension from Location…」选中 `packages/extension`
   - 或用 F5 调试（需 `.vscode/launch.json`）
3. 命令面板执行 `Git Insight: Open Web Visualization`

## 与 Skill 的差异

| | Skill | 本扩展网页 |
|--|-------|------------|
| Fetch | 默认自动 | 工具栏手动（可选「操作前先 Fetch」） |
| 交互 | 对话 + 报告 | 可视化面板 |
| 引擎 | 同一 `@git-insight/core` | 同一 |
