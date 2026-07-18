import type { BranchGraph, ConflictBlameResult, HostMessage } from "./types";

const T0 = 1_720_000_000_000;

/** 演示用分支 tip 图（静态，不连真实 Git） */
export const DEMO_GRAPH: BranchGraph = {
  repoRoot: "(演示仓库)",
  truncated: false,
  maxNodes: 200,
  tips: [
    { name: "main", sha: "a111111111111111111111111111111111111111", remote: false },
    { name: "feature/login", sha: "b222222222222222222222222222222222222222", remote: false },
    {
      name: "origin/main",
      sha: "a111111111111111111111111111111111111111",
      remote: true,
      upstream: "main",
    },
    {
      name: "origin/feature/login",
      sha: "b222222222222222222222222222222222222222",
      remote: true,
    },
  ],
  nodes: [
    {
      sha: "c000000000000000000000000000000000000000",
      parents: [],
      message: "chore: init",
      author: "Alice",
      time: T0,
    },
    {
      sha: "d111111111111111111111111111111111111111",
      parents: ["c000000000000000000000000000000000000000"],
      message: "feat: add auth stub",
      author: "Alice",
      time: T0 + 86_400_000,
    },
    {
      sha: "a111111111111111111111111111111111111111",
      parents: ["d111111111111111111111111111111111111111"],
      message: "fix: tighten session check",
      author: "Bob",
      time: T0 + 172_800_000,
    },
    {
      sha: "e333333333333333333333333333333333333333",
      parents: ["d111111111111111111111111111111111111111"],
      message: "feat: login form",
      author: "Carol",
      time: T0 + 129_600_000,
    },
    {
      sha: "b222222222222222222222222222222222222222",
      parents: ["e333333333333333333333333333333333333333"],
      message: "feat: remember-me cookie",
      author: "Carol",
      time: T0 + 216_000_000,
    },
  ],
  edges: [
    ["d111111111111111111111111111111111111111", "c000000000000000000000000000000000000000"],
    ["a111111111111111111111111111111111111111", "d111111111111111111111111111111111111111"],
    ["e333333333333333333333333333333333333333", "d111111111111111111111111111111111111111"],
    ["b222222222222222222222222222222222222222", "e333333333333333333333333333333333333333"],
  ],
  lineage: {
    mergeBase: "d111111111111111111111111111111111111111",
    fromOnlyCount: 2,
    intoOnlyCount: 1,
    branchedFrom: {
      sha: "d111111111111111111111111111111111111111",
      author: "Alice",
      message: "feat: add auth stub",
      time: T0 + 86_400_000,
    },
  },
};

export const DEMO_BRANCHES = [
  "main",
  "feature/login",
  "origin/main",
  "origin/feature/login",
];

const CONFLICT_BODY = `<<<<<<< ours (main)
export function createSession(userId: string) {
  return { userId, ttl: 3600 };
}
||||||| base
export function createSession(userId: string) {
  return { userId };
}
=======
export function createSession(userId: string, remember: boolean) {
  return { userId, ttl: remember ? 86400 : 1800 };
}
>>>>>>> theirs (feature/login)
`;

export const DEMO_PREVIEW: ConflictBlameResult = {
  repoRoot: "(演示仓库)",
  into: "main",
  from: "feature/login",
  intoSha: "a111111111111111111111111111111111111111",
  fromSha: "b222222222222222222222222222222222222222",
  mergeBase: "d111111111111111111111111111111111111111",
  clean: false,
  fetched: false,
  outcome: "conflicts",
  messages: ["演示数据：模拟 merge-tree 冲突预演（非真实仓库）"],
  conflictFiles: [
    {
      path: "src/auth/session.ts",
      contentConflict: true,
      conflictContent: CONFLICT_BODY,
      hunks: [
        {
          path: "src/auth/session.ts",
          oursRange: [1, 3],
          theirsRange: [1, 3],
          oursCommits: [
            {
              sha: "a111111111111111111111111111111111111111",
              author: "Bob",
              message: "fix: tighten session check",
            },
          ],
          theirsCommits: [
            {
              sha: "b222222222222222222222222222222222222222",
              author: "Carol",
              message: "feat: remember-me cookie",
            },
          ],
        },
      ],
    },
  ],
  blamed: [
    {
      path: "src/auth/session.ts",
      oursRange: [1, 3],
      theirsRange: [1, 3],
      oursCommits: [
        {
          sha: "a111111111111111111111111111111111111111",
          author: "Bob",
          message: "fix: tighten session check",
        },
      ],
      theirsCommits: [
        {
          sha: "b222222222222222222222222222222222222222",
          author: "Carol",
          message: "feat: remember-me cookie",
        },
      ],
    },
  ],
};

export const DEMO_GRAPH_REPORT = `# 分支图（演示）

> GitHub Pages **演示模式**：数据为内置样例，未连接真实 Git。

- 仓库：\`(演示仓库)\`
- tips：\`main\`、\`feature/login\` 及对应 \`origin/*\`
- 节点：5 · 边：4

本地完整预演：

\`\`\`bash
pnpm preview
# 或
pnpm preview:repo -- --cwd /path/to/your/repo
\`\`\`
`;

export const DEMO_PREVIEW_REPORT = `# 合并预演（演示）

将 \`feature/login\` 合入 \`main\` 时，检测到 **1** 个内容冲突文件。

## 冲突文件

- \`src/auth/session.ts\`

## 说明

此报告来自 GitHub Pages 静态演示数据，用于展示 UI。真实冲突预演请在本地运行 \`pnpm preview\` 或 Cursor 扩展。
`;

export function demoWorkspaceMessage(): HostMessage {
  return {
    type: "workspace",
    cwd: "(演示仓库)",
    branches: DEMO_BRANCHES,
    previewMode: true,
  };
}
