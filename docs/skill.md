# Git Branch Insight（Skill）

用 `@git-insight/core`（CLI：`git-insight`）分析当前仓库。不要手写脆弱的 git 解析；优先跑 CLI，再把 `report` / `mermaid` 用中文转述给用户。

> **范围**：本 Skill 只覆盖**只读分析**（分支图 + 合并预演）。一键解决冲突 / 推送 / 申请 MR 属于扩展能力，见 [user-guide.md](./user-guide.md) / [project-design.md](./project-design.md)。Agent **不要**为了预演去 `merge` / `checkout` / `push`。

Cursor 加载入口：[`skills/git-branch-insight/SKILL.md`](../skills/git-branch-insight/SKILL.md)（仅 frontmatter + 指向本文）。

---

## 前置条件

- 系统已安装 Git >= 2.38
- 在目标仓库根目录执行，或传 `--cwd <repo>`
- 本 monorepo 内先构建：`pnpm --filter @git-insight/core build`
- 调用：

```bash
pnpm --filter @git-insight/core exec node dist/cli.js <command> ...
```

---

## 默认行为

| 行为 | 说明 |
|------|------|
| 默认 fetch | `graph` / `preview-merge` 先执行 `git fetch --prune <remote>`（默认 `origin`；失败则继续用本地 refs） |
| 离线 | 仅当用户明确要求「不要拉远端」时加 `--no-fetch` |
| 不改工作区 | 只用 `merge-tree`、`merge-file -p`、`show` / `blame` 等只读命令 |

Fetch 在扩展中的三步鉴权见 [user-guide.md §4](./user-guide.md)；CLI 侧同样走 `fetchRemote`（可无 Token）。

---

## 可用 CLI 指令

### 1. 分支图（可零参）

```bash
git-insight graph
git-insight graph --into main --from feature/x
git-insight graph --max 0          # 不截断节点
git-insight graph --no-fetch       # 跳过 fetch
```

### 2. 合并预演（任意两分支；含冲突正文与溯源）

```bash
git-insight preview-merge --into <线上目标> --from <我的分支>
git-insight preview-merge --into develop --from origin/feature/x --no-fetch
```

兼容旧名（行为相同）：

```bash
git-insight conflict-blame --into <线上目标> --from <我的分支>
```

结果必须完整转述：

- 可干净合并 **或** 冲突文件列表
- **每个冲突文件的冲突内容**（含 `<<<<<<<`，来自 `data.conflictFiles[].conflictContent`）
- 两侧写入来源（作者 / commit）
- 优先展示 `report` 字段

### 3. 仅 fetch

```bash
git-insight fetch
git-insight fetch --remote origin
```

---

## 底层会用到的 git（供对照，勿手写替代 CLI）

| 场景 | 指令 |
|------|------|
| 定位仓库 | `git rev-parse --show-toplevel` |
| 刷新远端 | `git fetch --prune <remote>` |
| 枚举分支 tip | `git for-each-ref --format=… refs/heads refs/remotes` |
| 提交图 | `git rev-list --parents …` / `git show -s --format=…` |
| 合并预演 | `git merge-tree --write-tree -z … <into> <from>` |
| 冲突正文 | `git show <rev>:<path>` + `git merge-file -p --diff3 …` |
| 溯源 | `git diff -U0 <base>...<tip> -- <path>` + `git blame -l -w -L… --line-porcelain` |

（可选）若环境有 `gh`：blame 链路可能尝试 `gh pr list --search <sha7> …`，失败则忽略。

完整指令表：[project-design.md](./project-design.md)。

---

## Agent 工作流

1. 确认仓库路径
2. 映射意图 → `graph` 或 `preview-merge`
3. 执行 CLI，解析 JSON
4. `ok: false` → 解释 `error`
5. `ok: true`：展示 `report`；有冲突时必须列出文件与冲突正文 / 溯源；需要图时附 `mermaid`

---

## 输出约定

```markdown
## 结论
（干净合并 / 冲突 N 个文件）

## 冲突详情
（每个文件：路径、溯源、冲突内容代码块）

## 图
（mermaid）
```

---

## 示例

**画出当前仓库分支关系**

```bash
git-insight graph
```

**预演把 feature/x 合进 develop**

```bash
git-insight preview-merge --into develop --from feature/x
```

**远端 feature 与本地 develop 是否冲突**

```bash
git-insight preview-merge --into develop --from origin/feature/x
```

**离线、别 fetch**

```bash
git-insight preview-merge --into main --from topic --no-fetch
```

---

## 预演 JSON 要点

```json
{
  "ok": true,
  "command": "preview-merge",
  "data": {
    "clean": false,
    "conflictFiles": [
      {
        "path": "file.txt",
        "conflictContent": "<<<<<<< ours:file.txt\n...\n=======",
        "hunks": []
      }
    ]
  },
  "report": "# 合并预演\n...",
  "mermaid": "flowchart TB\n..."
}
```

库入口：

```ts
import { buildBranchGraph, rehearseMerge, fetchRemote } from "@git-insight/core";
```

---

## 不要做的事

- 不要为了预演执行真实 `git merge` / `checkout` / `push`
- 不要把 PR 号当作核心参数
- 不要跳过默认 fetch（除非用户要求离线）
- 冲突时不要只汇报「有冲突」而省略冲突正文

---

## 相关文档

- [user-guide.md](./user-guide.md) — 扩展使用与 Fetch 路径
- [project-design.md](./project-design.md) — 设计与指令表
- [core.md](./core.md) — CLI / API
- [extension.md](./extension.md) — 扩展安装与调试
