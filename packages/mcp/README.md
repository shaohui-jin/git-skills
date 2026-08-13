# @git-insight/mcp

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

上面五个都标了 `readOnlyHint`，宿主可以免确认直接调。

写操作默认**不注册**。需要时启动前设 `GIT_INSIGHT_MCP_ALLOW_WRITE=1`，此时多出 `apply_resolve` 与 `create_mr`，且每次调用还必须显式传 `confirm: true`。两道门是有意的：模型编不出环境变量，人也不会被一次工具调用不小心推了分支。

## 配置

Cursor（`~/.cursor/mcp.json`）或其他宿主：

```json
{
  "mcpServers": {
    "git-insight": {
      "command": "npx",
      "args": ["-y", "@git-insight/mcp"],
      "env": {
        "GIT_INSIGHT_MCP_CWD": "/绝对路径/你的仓库"
      }
    }
  }
}
```

`GIT_INSIGHT_MCP_CWD` 可以不填，此时以进程启动目录为准；每个工具也都接受 `cwd` 参数覆盖。

需要 Node ≥ 20 和系统 Git ≥ 2.38（依赖 `merge-tree --write-tree`）。

## 从源码跑（开发用）

```bash
pnpm build:mcp
```

然后把上面的 `command` / `args` 换成绝对路径：

```json
{ "command": "node", "args": ["/绝对路径/packages/mcp/dist/index.js"] }
```

## 发布

`@git-insight/core` 是 workspace 包、没发过 npm，所以构建时用 esbuild **内联进 `dist/index.js`**；只有 `@modelcontextprotocol/server` 和 `zod` 留作外部依赖，交给 npm 去重和安全更新。见 `scripts/bundle.mjs`。

```bash
# 仓库根目录
pnpm publish:mcp
```

它会先构建 core（`check` 要靠它的 `dist` 做类型解析），再由 `prepublishOnly` 跑一遍类型检查和打包。发布走 pnpm 默认的分支 / 工作区干净校验，别绕过。

改动 core 之后 MCP 要重新发一次才生效 —— 内联的代价就在这里。握手里报的版本号由打包脚本从 `package.json` 注入，不用手动同步。

## 注意

- stdout 是协议流，本进程的日志一律走 stderr。
- 默认每次调用都会先 `fetch`。批量扫描时如果嫌慢，传 `noFetch: true` 用本地已有的 remote-tracking refs。
- 私有仓库的 fetch 走本机 git 凭据；本包不读也不存 Token。
