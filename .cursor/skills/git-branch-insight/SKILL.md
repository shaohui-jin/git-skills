---
name: git-branch-insight
description: >-
  Git branch graph, merge rehearsal, conflict resolve, and MR/PR creation
  (cli / token / extension UI). Invoke with /git-branch-insight then state
  into/from or intent. Defaults to git fetch.
disable-model-invocation: true
---

# Git Branch Insight

## 怎么用（用户侧）

1. Agent 聊天输入 `/git-branch-insight`（斜杠菜单选本 Skill）
2. **同一条消息或下一条**写清需求，例如：
   - `把 feature/x 合进 origin/develop，有冲突列出内容`
   - `预演后能开 MR 再问我用 cli / token / ui`
   - `只看分支图`

不要让用户自己拼 CLI；由本 Skill 编排。

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

## CLI

先：`pnpm --filter @shaohui_jin/git-insight-core build`

```bash
pnpm --filter @shaohui_jin/git-insight-core exec node dist/cli.js <command> …
```

| 阶段 | 命令 |
|------|------|
| 同步 | `fetch`（未传 `--remote` 时读扩展配置 `defaultRemote`，见 `~/.git-insight/user-config.json`） |
| 图 | `graph` |
| 预演 | `preview-merge --into <远程> --from <我的>` |
| 落盘 | `apply-resolve --into … --from … --stash stash.json` |
| 准备 MR | `prepare-mr --into … --from …` |
| 创建 MR | `create-mr --source … --target … --method cli\|token` |

干净：`stash` 可用 `{ "files": [] }`。

## 申请 MR（先问）

| 选项 | 做法 |
|------|------|
| cli | `create-mr --method cli` |
| token | `create-mr --method token` 或 `GIT_INSIGHT_*_TOKEN` |

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
- 不把流程拆成让用户自己点 CLI

详情：[`docs/guide.md`](../../../docs/guide.md) §四。
