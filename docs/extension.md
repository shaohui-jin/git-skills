# Git Insight 扩展

在 Cursor / VS Code 中打开 Webview 面板，能力来自 `@git-insight/core`。

日常操作请先看 [user-guide.md](./user-guide.md)。

---

## 功能概览

| 能力 | 说明 |
|------|------|
| Git / MR 配置 | A 本机 CLI / B 下载 CLI / C Token / D 浏览器 |
| 分支图 | 默认先 fetch，再 G6 可视化 + 中文报告 |
| 合并预演 | 冲突选边、暂存、一键解决并推送、申请 MR |
| Fetch | `git fetch --prune origin`；鉴权见 [user-guide.md §4](./user-guide.md) |

---

## 命令（命令面板）

- `Git Insight: Open Web Visualization` — 打开面板（默认 **Git 配置**）
- `Git Insight: 合并预演` — 打开并切到合并预演
- `Git Insight: 合并预演（兼容）` — 同上

---

## 安装到 Cursor

### 打包 vsix（推荐分发）

```bash
# 仓库根目录
pnpm install
pnpm package:vsix
cursor --install-extension git-insight.vsix --force
```

根目录生成 `git-insight.vsix`（已打进 core）。对方机器需已安装 `git`。

也可在 Cursor：`Extensions: Install from VSIX…`。

### 从目录安装（开发自用）

1. 命令面板：`Developer: Install Extension from Location…`
2. 选中 `packages/extension`
3. 打开任意 Git 仓库，执行 `Git Insight: Open Web Visualization`

### F5 调试

1. 用 Cursor / VS Code 打开 monorepo `git-skill`
2. 运行与调试 → **Run Git Insight Extension**（或 F5）
3. 在 Extension Development Host 中执行上述命令

---

## 本地浏览器预览（不装扩展）

```bash
pnpm install
pnpm preview
```

打开 http://127.0.0.1:5173/ 。

**预览模式只读**：不能推送 / 申请 MR / 写扩展配置。

### 指定仓库

1. `pnpm preview:repo -- --cwd D:\path\to\your\repo`
2. 网页输入本机路径 →「打开」
3. 网页输入 GitHub：`owner/repo` 或完整 URL（服务端 `git clone`）
4. 「浏览…」→ 系统对话框

> 请用本地 `pnpm preview` 或 Cursor 扩展；不适合部署到 GitHub Pages。

### 关于 HTTPS

浏览器 `showDirectoryPicker` 等需要安全上下文；**本项目不用那套 API**，目录选择走宿主：

| 场景 | 能否选目录 |
|------|------------|
| `pnpm preview`（http://127.0.0.1） | 能（WebSocket → 系统对话框） |
| 扩展 Webview | 能（`showOpenDialog`） |

---

## 开发构建

```bash
pnpm install
pnpm --filter @git-insight/core build
pnpm --filter git-insight build
```

---

## 与 Skill 的差异

| | Skill | 扩展 |
|--|-------|------|
| Fetch | 默认自动 | 加载图 / 预演默认 fetch；也可手动 Fetch |
| 交互 | 对话 + 报告 | 可视化面板 + 一键解决 / MR |
| 引擎 | 同一 `@git-insight/core` | 同一 |

Skill 说明：[skill.md](./skill.md)
