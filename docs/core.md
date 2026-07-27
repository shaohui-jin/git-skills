# @git-insight/core

Git 分支图、合并冲突预演（`merge-tree`）、冲突溯源、一键落盘与创建 MR 的引擎库。供 Cursor Skill 与扩展复用。

使用场景与 Fetch 鉴权见 [user-guide.md](./user-guide.md)；指令全表见 [project-design.md](./project-design.md)。

---

## 安装 / 构建

```bash
pnpm add @git-insight/core
# 或 monorepo
pnpm --filter @git-insight/core build
```

---

## CLI

```bash
# 分支图（默认 fetch）
git-insight graph

# 合并预演（默认 fetch；不改工作区）
git-insight preview-merge --into develop --from feature/x
git-insight preview-merge --into develop --from origin/feature/x

# 仅 fetch
git-insight fetch

# 跳过 fetch
git-insight preview-merge --into main --from topic --no-fetch
```

Monorepo 内调用：

```bash
pnpm --filter @git-insight/core exec node dist/cli.js graph
```

输出 JSON：`{ ok, command, data, report?, mermaid? }`。

**CLI 不包含**一键 resolve / create MR（仅扩展调用库函数）。

---

## 程序化 API

```ts
import {
  buildBranchGraph,
  rehearseMerge,
  fetchRemote,
  applyStashedResolve,
  createMergeRequest,
} from "@git-insight/core";

await fetchRemote("/path/to/repo");
const preview = await rehearseMerge({
  into: "main",
  from: "feature/x",
  cwd: "/path/to/repo",
});
```

Fetch 可传入 `authToken` / `authProvider`；扩展侧会注入方案 C Token。鉴权顺序见 [user-guide.md §4](./user-guide.md)。

---

## 约定

- `--into`：线上 / 合入目标；`--from`：我的分支（本地名或 `origin/xxx`）
- 远程场景：先 fetch，再本地 `merge-tree`，不依赖平台 PR
- 需要 Git >= 2.38
