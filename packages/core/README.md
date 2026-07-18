# @git-insight/core

Git 分支图、合并冲突预演（`merge-tree`）、冲突溯源引擎。可供 Cursor Skill 与后续网页端复用。

## 安装

```bash
pnpm add @git-insight/core
# 或本地 monorepo
pnpm --filter @git-insight/core build
```

## CLI

```bash
# 分支图（默认 fetch）
git-insight graph

# 合并预演（默认 fetch；不改工作区）
# 含：是否可合并、冲突文件、冲突正文、来源溯源
git-insight preview-merge --into develop --from feature/x
git-insight preview-merge --into develop --from origin/feature/x

# 仅 fetch
git-insight fetch

# 跳过 fetch
git-insight preview-merge --into main --from topic --no-fetch
```

输出为 JSON：`{ ok, command, data, report?, mermaid? }`。

## 程序化 API

```ts
import { buildBranchGraph, previewMerge, conflictBlame, fetchRemote } from "@git-insight/core";

await fetchRemote("/path/to/repo");
const preview = await previewMerge({ into: "main", from: "feature/x", cwd: "/path/to/repo" });
```

## 约定

- `--into`：目标分支；`--from`：待合并分支（本地名或 `origin/xxx`）
- 远程场景：先 fetch，再本地 `merge-tree`，不依赖平台 PR
- 需要 Git >= 2.38
