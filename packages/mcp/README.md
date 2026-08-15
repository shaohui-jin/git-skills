# @git-insight/mcp-server

把 git-insight 的「不落地合并预演」开放成 MCP server，任何 MCP 宿主（Cursor、Claude Code、VS Code…）都能直接调用。

所有预演都基于 `git merge-tree`：**不改工作区、不建分支、不产生提交**，在别人的仓库上跑也是安全的。

## 工具

| 工具 | 作用 |
|------|------|
| `git_branch_graph` | 分支 tip 与链路，可选给出两分支的 merge-base 和各自独有提交数 |
| `merge_preview` | 单对预演。`detail: true` 时附冲突正文与逐块溯源（慢） |
| `merge_survey` | 批量矩阵：`froms × intos` 每种组合各预演一次，整批只 fetch 一次 |
| `merge_order` | 多分支合进同一目标时，推演最省事的合入顺序 |
| `mr_prepare` | 识别平台 / CLI / 默认标题 / 可选审核人，只读 |
| `open_ui` | 打开预演 UI：**auto** 优先扩展，失败则浏览器（`127.0.0.1:17341`） |

前面五个都标了 `readOnlyHint`，宿主可以免确认直接调。

`open_ui` 不碰仓库，但会弹窗口，所以没标只读。它是「Agent 查完之后我要动手」的交接口：人直接在面板里选边、一键解决、申请 MR。

写操作默认**不注册**。需要时启动前设 `GIT_INSIGHT_MCP_ALLOW_WRITE=1`，此时多出 `apply_resolve` 与 `create_mr`，且每次调用还必须显式传 `confirm: true`。

## 接入（npm）

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

`GIT_INSIGHT_MCP_CWD` 必须是**本地路径**（不能填 GitHub URL）。改完重启 MCP 宿主。

## 从源码构建

```bash
pnpm install
pnpm build:mcp   # core + webview + 打包 dist/index.js 与 dist/webview
```

本地调试可改用绝对路径：

```json
{ "command": "node", "args": ["…/packages/mcp/dist/index.js"] }
```

```bash
npx @modelcontextprotocol/inspector node packages/mcp/dist/index.js
```

需要 Node ≥ 20 和系统 Git ≥ 2.38。

## 发版

- npm 包名：`@git-insight/mcp-server`
- Git tag：`mcp-server-v{version}`（与扩展 `v*` tag 独立）
- CI：`.github/workflows/release-mcp-server.yml`（Secret：`NPM_TOKEN`）

```bash
pnpm publish:mcp
```

构建时用 esbuild 内联 `@git-insight/core` 与 extension `coreBridge`；`@modelcontextprotocol/server`、`zod`、`ws` 为外部依赖。Webview 静态资源在 `dist/webview/`。

功能进度见仓库 [`docs/features.md`](../../docs/features.md)。

## 注意

- stdout 是协议流，日志走 stderr。
- 默认每次调用会 `fetch`；批量扫描可传 `noFetch: true`。
- 浏览器面板不支持 AI 选边与冲突预警状态栏（扩展专属）。
