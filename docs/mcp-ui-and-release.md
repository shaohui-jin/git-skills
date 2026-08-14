# MCP 浏览器面板 + npm 发版 · 实施方案

> **状态：待实施（已确认决策）**  
> 已发布行为仍以 [`guide.md`](./guide.md) 为准。本文是下一批落地的设计稿与操作说明；落地后相应章节迁入 `guide.md`，并从 [`design-next.md`](./design-next.md) 删去重复项。

---

## 1. 背景与目标

### 1.1 现状

| 能力 | 扩展面板 | MCP 工具 | 浏览器预览 |
|------|----------|----------|------------|
| 分支图 / 矩阵 / 预演 / 冲突三栏 / MR | ✅ | 仅文本报告 | ✅（`pnpm preview`） |
| Agent 调完直接「动手」 | URI 唤起 | `open_ui` → 仅 URI | 需手动 `pnpm preview` |
| 任意 MCP 宿主可用 UI | ❌ 须装扩展 | ❌ | ✅ 但未接 MCP |

Webview **已是同一套**（`packages/extension/webview` + `coreBridge.handleWebviewRequest`）。浏览器侧通过 `vscode.ts` 的 WebSocket 桥接，不是第二套 UI。

### 1.2 目标

1. **MCP `open_ui`（auto）**：优先唤起 Cursor/VS Code 扩展面板；失败或未装扩展时，自动拉起**本地浏览器面板**（同一 Webview）。
2. **npm 发包 `@git-insight/mcp-server`**：对齐 [`why-css-skills`](https://github.com/shaohui-jin/why-css-skills) 的 GitHub Actions → npm 流程；用户侧 `npx -y @git-insight/mcp-server` 即可接入。
3. **与扩展发版解耦**：扩展继续 Open VSX + tag `v{version}`；MCP 单独 tag `mcp-server-v{version}`。

---

## 2. 已确认决策

| 项 | 决策 |
|----|------|
| UI 唤起模式 | **auto**（扩展 URI → 浏览器 fallback） |
| UI 与扩展关系 | **同一 Webview + 同一 coreBridge**，不做第二套界面 |
| 浏览器服务端口 | **固定 `17341`**（`127.0.0.1:17341`，单例复用） |
| npm 包名 | **`@git-insight/mcp-server`**（原 `@git-insight/mcp` 改名） |
| MCP 发版 tag | **`mcp-server-v{version}`**（如 `mcp-server-v0.1.0`） |
| 实施顺序 | **并行**：浏览器面板 + npm CI + 改名 **一起做** |
| lockfile | 改动依赖后 **必须提交 `pnpm-lock.yaml`** |
| 静态资源 | npm 包内 **打入 webview 构建产物**（`dist/webview`），`npx` 装完即可开浏览器面板 |

---

## 3. npm scope 检查（发版前必做）

包名 `@git-insight/mcp-server` 需要 npm 上 **`@git-insight` 这个 scope 有发布权限**。

### 3.1 一键检查（复制执行）

在仓库根目录或任意目录：

```bash
npm whoami && npm access ls packages @git-insight 2>&1; npm publish --dry-run --access public --workspace-root=false --prefix "D:/_myproject/git-skill/packages/mcp" 2>&1
```

> Windows PowerShell 若 `--prefix` 路径不同，改成你的 `packages/mcp` 绝对路径。  
> 改名实施完成后，`packages/mcp/package.json` 的 `name` 应为 `@git-insight/mcp-server`，上述 dry-run 会以新包名为准。

### 3.2 结果怎么读

| 输出 | 含义 |
|------|------|
| `npm whoami` 报未登录 | 先 `npm login` |
| `access ls packages @git-insight` 列出包或空数组 | scope 可用 |
| `403 / 404` on scope | 需在 [npmjs.com](https://www.npmjs.com/) 创建 org **`git-insight`** 并加入账号，或改用 `@你的npm用户名/mcp-server` |
| `dry-run` 成功、无 `402` | 可以发 public 包 |

### 3.3 scope 不可用时的备选

仅改 `packages/mcp/package.json` 的 `name`（如 `@shaohui-jin/mcp-server`），CI 与 bin 逻辑不变。发版前在本文 §2 表里更新包名即可。

---

## 4. 架构：auto 唤起面板

```text
open_ui(into, from, cwd?, mode=auto)
        │
        ├─ mode=extension ──► vscode://jinshaohui.git-insight/preview?…
        │
        ├─ mode=browser ────► http://127.0.0.1:17341/?into=…&from=…&cwd=…&tab=preview
        │
        └─ mode=auto（默认）
              ├─ ① cursor --open-url / start 打开 vscode://…
              │      └─ 成功 → 扩展面板（现有行为）
              └─ ② 失败 → startUiServer(17341) + 打开浏览器 URL
                     └─ Webview 读 query，等价 seedPreview + 自动预演
```

### 4.1 新增 / 改动模块

| 模块 | 动作 |
|------|------|
| `packages/core/src/ui/uiServer.ts` | **新建**：从 `preview-prod.ts` 抽出 HTTP + WebSocket 服务；固定端口单例 |
| `packages/core/src/ui/openPanel.ts` | **扩展**：`openInsightUi({ mode: auto \| extension \| browser })` |
| `packages/extension/scripts/preview-prod.ts` | **变薄**：调用 `startUiServer` |
| `packages/extension/webview/src/App.vue` | **小改**：浏览器模式读 URL query（into/from/cwd/tab/autoPreview） |
| `packages/mcp/src/index.ts` | `open_ui` 接新 API；可选参数 `mode` |
| `packages/mcp/scripts/bundle.mjs` | 构建时复制 `dist/webview` 进 MCP 包 |
| `packages/mcp/package.json` | 改名 `@git-insight/mcp-server`；`files` 含 webview 静态资源 |
| `.github/workflows/release-mcp-server.yml` | **新建**：npm 自动发版 |
| `~/.cursor/mcp.json` 文档示例 | `npx -y @git-insight/mcp-server` |

### 4.2 浏览器 vs 扩展：能力边界（第一版）

| 能力 | 扩展 | 浏览器（MCP 拉起） |
|------|------|---------------------|
| 配置 / 分支图 / 矩阵 / 预演 / 三栏 / 一键解决 / MR | ✅ | ✅ |
| Git 配置持久化 | globalState | 内存（Phase 2 可 localStorage） |
| AI 选边 | ✅ | 暂不支持（preview 已有拦截文案） |
| 冲突预警状态栏 | ✅ 见 §5.1 | ❌ 无 IDE 宿主 |
| 选本地目录 | VS Code 对话框 | 路径输入 / GitHub URL |

---

## 5. 术语说明

### 5.1 「冲突预警状态栏」是什么

**扩展专属**，不是面板 Tab，也不是 MCP 工具。

- **位置**：Cursor 窗口**右下角状态栏**（`mergeWatcher.ts` → `createStatusBarItem`）
- **行为**：后台定时（默认 10 分钟）用 `merge-tree` 检查「我的分支能否干净合进目标」；**只在变糟时**弹通知；点击状态栏或命令「Git Insight: 立即检查合并冲突」可手动跑
- **配置**：设置 `gitInsight.conflictWatcher.*`，**默认关闭**
- **为何浏览器没有**：依赖 VS Code 状态栏、通知、配置 API；MCP / 浏览器进程无等价宿主

详见 [`guide.md` §2.3.2](./guide.md#232-冲突预警常驻默认关闭)。

---

## 6. npm 发版流程（对齐 why-css-skills）

### 6.1 与扩展发版对照

| | 扩展 `git-insight` | MCP `@git-insight/mcp-server` |
|--|-------------------|-------------------------------|
| 版本文件 | `packages/extension/package.json` | `packages/mcp/package.json` |
| 发布目标 | Open VSX | npm |
| Git tag | `v0.3.0` | **`mcp-server-v0.1.0`** |
| CI 文件 | `.github/workflows/release-on-version.yml` | **`.github/workflows/release-mcp-server.yml`（待建）** |
| Secret | `OVSX_PAT` | **`NPM_TOKEN`** |

两流水线**互不抢 tag**；version 数字不必同步。

### 6.2 CI 触发条件（建议）

```yaml
on:
  workflow_dispatch:
  push:
    branches: [master, main]
    paths:
      - "packages/mcp/package.json"
      - "packages/mcp/**"
      - "packages/core/**"   # core 内联进 MCP
      - "pnpm-lock.yaml"
```

**是否发布**：远程是否已有 tag `mcp-server-v{version}`（与扩展「tag 代表已发布」一致，失败可重试）。

**步骤概要**：

1. `pnpm install --frozen-lockfile`
2. `pnpm --filter @git-insight/core build`
3. `pnpm --filter git-insight build:webview`（产出静态 UI）
4. `pnpm --filter @git-insight/mcp-server run check && build`（改名后 filter 名随 package name）
5. `npm publish --access public`（在 `packages/mcp`，`NODE_AUTH_TOKEN`）
6. 打 tag `mcp-server-v{version}` 并 push

### 6.3 用户接入（发布后）

```json
{
  "mcpServers": {
    "git-insight": {
      "command": "npx",
      "args": ["-y", "@git-insight/mcp-server@latest"],
      "env": {
        "GIT_INSIGHT_MCP_CWD": "D:/你的/仓库"
      }
    }
  }
}
```

`GIT_INSIGHT_MCP_CWD` 必须是**本地路径**，不能填 GitHub URL。

---

## 7. 首次发版操作说明（workflow_dispatch）

实施 CI 后，第一次（或 npm 上尚无该版本时）建议：

1. **确认 scope**：执行本文 §3.1 的 dry-run
2. **在 GitHub 仓库 Settings → Secrets** 添加 `NPM_TOKEN`（npm Automation token，可绕过 2FA）
3. 改 `packages/mcp/package.json` 的 `version`（如 `0.1.0`）
4. 提交并 push 到 `master`；或打开 **Actions → Release MCP server → Run workflow**
5. 看 CI 日志：build → publish → tag `mcp-server-v0.1.0`
6. 验证：`npm view @git-insight/mcp-server version` 与 [npmjs.com](https://www.npmjs.com/) 页面
7. 本地 Cursor 改 `mcp.json` 为 `npx` 写法，重启后确认 6 个工具含 `open_ui`

若 publish 失败但 tag 已存在：修问题后**不要改 version**，直接重跑 workflow（tag 已存在则跳过打 tag，npm 会拦重复版本）。

---

## 8. 实施清单（开发自检）

### 8.1 浏览器面板 + open_ui

- [ ] `startUiServer({ port: 17341 })` 单例；二次 `open_ui` 不重复 listen
- [ ] Webview URL：`?into=&from=&cwd=&tab=preview&autoPreview=1`
- [ ] `openInsightUi({ mode: 'auto' })` 返回 `{ mode, url?, uri?, opened, openedWith? }`
- [ ] MCP / CLI 共用 `openInsightUi`
- [ ] bundle 打入 `dist/webview`；`npx` 安装后无源码也能开浏览器

### 8.2 npm 发包

- [ ] 包名 `@git-insight/mcp-server`；bin 可保留 `git-insight-mcp` 或改为 `git-insight-mcp-server`
- [ ] `release-mcp-server.yml` + tag `mcp-server-v*`
- [ ] 更新 `guide.md` §3.4.1、§3.6；`packages/mcp/README.md`
- [ ] 根 `package.json` 的 `publish:mcp` 脚本与 filter 名同步

### 8.3 文档与 lockfile

- [ ] 依赖变更后 `pnpm install` 并提交 `pnpm-lock.yaml`
- [ ] 实施完成后从 `design-next.md` 删去已收录条目

---

## 9. 后续 backlog（原 design-next + 延伸）

以下**不在本批并行实施范围内**，但一并收录便于排期。

### 9.1 A. 矩阵结果的持久化与对比

- 存扩展 `globalState`（按 `repoRoot` 分桶）
- 重开面板展示上次结果 + 时间戳；对比标「新增冲突」
- 与冲突预警共用快照；sha 过期须标明

### 9.2 B. 全排列顺序搜索

- 现 `suggestMergeOrder` 为贪心；N ≤ 6 可穷举 720 链
- 前提：新目标函数可量化（如冲突集中同一负责人）

### 9.3 C. resolver 的用户级配置

- `~/.git-insight/resolvers.json`（**用户级，非仓库级**）
- 配置页只读展示 + 「打开配置文件」；`regenerate` 首次确认

### 9.4 D. 冲突预警接入矩阵

- 预警从「单对 / 少数分支」扩展到矩阵多分支
- 通知标明**哪几条**变糟（非仅总数）

### 9.5 E. MCP 结构化输出

- `merge_survey` / `merge_order` 等增加 `outputSchema` + `structuredContent`
- 权衡响应体积 vs 模型解析可靠性

### 9.6 F. 浏览器面板 Phase 2（本批之后）

- Git 配置写 `localStorage`
- `open_ui` 支持 `tab=matrix` / `tab=graph`
- 浏览器 AI 选边（HTTP 桥，非 Chat）

---

## 10. 相关文件索引

| 用途 | 路径 |
|------|------|
| 浏览器预览（现成） | `packages/extension/scripts/preview.ts`、`preview-prod.ts` |
| Webview 浏览器桥 | `packages/extension/webview/src/vscode.ts` |
| 扩展 URI 唤起 | `packages/extension/src/extension.ts` |
| open_ui（现） | `packages/core/src/ui/openPanel.ts`、`packages/mcp/src/index.ts` |
| 冲突预警 | `packages/extension/src/mergeWatcher.ts` |
| 扩展发版 CI | `.github/workflows/release-on-version.yml` |
| why-css 参考 CI | `why-css-skills/.github/workflows/release-on-version.yml` |

---

## 11. 变更记录

| 日期 | 说明 |
|------|------|
| 2026-08-14 | 初稿：确认 auto UI、端口 17341、包名 `@git-insight/mcp-server`、tag `mcp-server-v*`、并行实施；合并 design-next 未完成项 |
