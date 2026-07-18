# @git-insight/core 参考

## 合并预演 JSON

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
    ],
    "blamed": []
  },
  "report": "# 合并预演\n...",
  "mermaid": "flowchart TB\n..."
}
```

冲突时 Agent / UI **必须**展示 `conflictFiles[].conflictContent`，不能只报有冲突。

## 库入口

```ts
import {
  buildBranchGraph,
  rehearseMerge,
  fetchRemote,
} from "@git-insight/core";
```

`conflict-blame` CLI 为 `preview-merge` 的兼容别名。
