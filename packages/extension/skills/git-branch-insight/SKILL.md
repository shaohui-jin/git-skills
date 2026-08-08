---
name: git-branch-insight
description: >-
  Git branch graph, merge rehearsal, conflict resolve, and MR/PR creation
  (cli / token / extension UI). Invoke with /git-branch-insight then state
  into/from or intent. Defaults to git fetch. Bundled with Git Insight extension.
disable-model-invocation: true
---

# Git Branch Insight

随 **Git Insight** 扩展安装后可用。用户侧：`/git-branch-insight` + 需求。

## 怎么用

```text
/git-branch-insight
把 feature/x 合进 origin/develop；能开 MR 再问我
```

## 闭环

```text
fetch/graph → preview-merge →（冲突：确认选边 + apply-resolve）→ 询问 MR 方式 → 执行
```

## 硬性规则

1. `--into` = **远程**（如 `origin/develop`）
2. 同名（`master` ↔ `origin/master`）→ 停止，自行 push/pull
3. `apply-resolve` / `create-mr` 前必须用户确认
4. 冲突必须展示 `conflictContent`
5. 左=线上 into，右=我的 from

## CLI（扩展自带）

扩展安装后 CLI 路径（由扩展激活时写入，勿改占位逻辑外的约定）：

```bash
node "__GIT_INSIGHT_CLI__" <command> …
```

| 阶段 | 命令 |
|------|------|
| 同步 | `fetch`（未传 `--remote` 时读扩展配置 `defaultRemote`，见 `~/.git-insight/user-config.json`） |
| 图 | `graph` |
| 预演 | `preview-merge --into <远程> --from <我的>` |
| 落盘 | `apply-resolve --into … --from … --stash stash.json` |
| 准备 MR | `prepare-mr --into … --from …` |
| 创建 MR | `create-mr --source … --target … --method cli\|token` |
| 唤起 UI | `open-ui --into … --from …` |

若 `__GIT_INSIGHT_CLI__` 仍是占位符或文件不存在：用命令面板 `Git Insight: 打开预演`，或 `vscode://jinshaohui.git-insight/preview?into=…&from=…&autoPreview=1`。

干净合并：`stash` 可用 `{ "files": [] }`。

## 申请 MR（先问）

| 选项 | 做法 |
|------|------|
| cli | `create-mr --method cli` |
| token | `create-mr --method token` 或 `GIT_INSIGHT_*_TOKEN` |
| ui | `open-ui`（扩展面板） |

## 输出

```markdown
## 结论
## 冲突详情
## 图
## 建议动作（含 MR：cli|token|ui 待选）
## 结果
```

## 不要做

- 预演不用真实 merge/checkout
- 未确认不写仓、不开 MR
- 不同名强行建 MR
