# Git Insight 扩展（次交付）

在 Cursor / VS Code 中打开 **网页版可视化**（Webview），能力全部来自 `@git-insight/core`。

## 功能

| 能力 | 说明 |
|------|------|
| 分支图 | G6 可视化 + 中文报告 |
| **合并预演** | 任意两分支：是否可合并、冲突文件、冲突正文、来源溯源 |
| **Fetch 按钮** | 手动 `git fetch --prune origin`（网页端默认不自动 fetch） |

## 命令（命令面板 `Ctrl+Shift+P`）

- `Git Insight: Open Web Visualization` — 打开面板（默认分支图）
- `Git Insight: 合并预演` — 打开面板并切到合并预演
- `Git Insight: 合并预演（兼容）` — 同上

## 本地浏览器预览（不装扩展）

前端为 **Vue 3 + AntV G6**（分支图可视化）。在仓库根目录：

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
4. **「浏览…」** → 本机系统对话框（本地预览 / 扩展）

> 请用本地 `pnpm preview` 或 Cursor 扩展；无需、也不适合部署到 GitHub Pages（无法操作本机 git）。

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

## 在 Cursor 中使用（推荐，无需上架）

功能**可以**在 Cursor 里用：扩展走 VS Code API + Webview，用本机 `git`（与 `pnpm preview` 同一引擎）。

```bash
# 仓库根目录
pnpm install
pnpm build
```

**方式 A — 从目录安装（日常自用）**

1. Cursor 命令面板：`Developer: Install Extension from Location…`  
   （中文界面可能是「开发人员: 从位置安装扩展…」）
2. 选中本仓库的 `packages/extension` 目录
3. 用 Cursor **打开任意 Git 仓库**作为工作区（或面板里「浏览…」选目录）
4. 命令面板执行：`Git Insight: Open Web Visualization` 或 `Git Insight: 合并预演`

**方式 B — F5 调试**

1. 用 Cursor / VS Code 打开本 monorepo（`git-skill`）
2. 运行与调试 → **Run Git Insight Extension**（或按 F5）
3. 会开一个新的 Extension Development Host 窗口，再在里边执行上述命令

面板内：选分支 → 「加载分支图」/「开始预演」；需要本机已安装 `git`。

## 打包成 .vsix（给人安装）

在仓库根目录：

```bash
pnpm install
pnpm package:vsix
```

完成后根目录生成 **`git-insight.vsix`**（已用 esbuild 打进 `@git-insight/core`，对方无需本 monorepo）。

对方在 Cursor / VS Code：

1. 命令面板 → **`Extensions: Install from VSIX…`**
2. 选中 `git-insight.vsix`
3. 打开任意 Git 仓库 → 命令面板执行 `Git Insight: Open Web Visualization`

> 对方机器需已安装 `git`。尚未配置商店上架；分发 `.vsix` 文件即可。

## 与 Skill 的差异

| | Skill | 本扩展网页 |
|--|-------|------------|
| Fetch | 默认自动 | 加载图 / 预演默认 fetch；也可点 Fetch |
| 交互 | 对话 + 报告 | 可视化面板 |
| 引擎 | 同一 `@git-insight/core` | 同一 |
