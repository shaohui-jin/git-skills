#!/usr/bin/env node
/**
 * git-insight MCP server —— 把「不落地的合并预演」这套能力开放给任意 MCP 宿主。
 *
 * 默认只读：图、单对预演、批量矩阵、合并顺序、MR 准备信息。
 * 写操作（建临时分支 / push / 建 MR）默认不注册，需要同时满足两个条件：
 *   1. 启动时 GIT_INSIGHT_MCP_ALLOW_WRITE=1
 *   2. 调用时显式传 confirm: true
 * 两道门是有意的：模型自己编不出环境变量，人也不会不小心被一次工具调用推了分支。
 *
 * 注意：stdout 是协议流，日志一律走 console.error。
 */
import {
  applyStashedResolve,
  buildBranchGraph,
  createMergeRequest,
  crossPairs,
  openInsightPanel,
  prepareCreateMr,
  previewMerge,
  rehearseMerge,
  reportGraph,
  reportMergeOrder,
  reportMergeRehearsal,
  reportMergeSurvey,
  resolveRemoteName,
  suggestMergeOrder,
  surveyMerges,
} from "@git-insight/core";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";

/** 构建时由 scripts/bundle.mjs 从 package.json 注入；tsx 直跑时没有这个值 */
declare const __MCP_VERSION__: string;
const VERSION = typeof __MCP_VERSION__ === "string" ? __MCP_VERSION__ : "0.0.0-dev";

/** 宿主一般在仓库根启动本进程；显式配了 GIT_INSIGHT_MCP_CWD 就以它为准 */
const DEFAULT_CWD = process.env.GIT_INSIGHT_MCP_CWD?.trim() || process.cwd();

const writeEnabled = process.env.GIT_INSIGHT_MCP_ALLOW_WRITE === "1";

const cwdArg = z
  .string()
  .optional()
  .describe("仓库路径；省略时用服务启动目录（或 GIT_INSIGHT_MCP_CWD）");

const noFetchArg = z
  .boolean()
  .optional()
  .describe("true 则跳过 fetch，只用本地已有的 remote-tracking refs（快，但可能落后）");

/**
 * 宿主用它决定要不要拦一道人工确认。本服务的读工具是真只读
 * （只跑 merge-tree / for-each-ref 这类查询），标出来宿主就能免确认直接调。
 */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false } as const;
const WRITES = { readOnlyHint: false, destructiveHint: true } as const;
/** 不碰仓库，但会在用户桌面上弹窗口，所以不能标 readOnly */
const OPENS_WINDOW = { readOnlyHint: false, destructiveHint: false } as const;

function repo(cwd?: string): string {
  return cwd?.trim() || DEFAULT_CWD;
}

function text(body: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: body }] };
}

function failed(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
    isError: true,
  };
}

async function remoteFor(cwd: string, explicit?: string): Promise<string> {
  const { remote } = await resolveRemoteName(cwd, explicit);
  return remote;
}

function createServer(): McpServer {
  const server = new McpServer({ name: "git-insight", version: VERSION });

  server.registerTool(
    "git_branch_graph",
    {
      title: "分支图",
      description:
        "列出仓库的本地 / 远程分支 tip 与它们的链路关系。可选给定 into/from 得到两者的 merge-base 与各自独有提交数。",
      annotations: READ_ONLY,
      inputSchema: z.object({
        cwd: cwdArg,
        into: z.string().optional().describe("线上目标分支，如 origin/master"),
        from: z.string().optional().describe("我的分支"),
        noFetch: noFetchArg,
      }),
    },
    async ({ cwd, into, from, noFetch }) => {
      try {
        const root = repo(cwd);
        const graph = await buildBranchGraph({
          cwd: root,
          into,
          from,
          fetch: !noFetch,
          remote: await remoteFor(root),
        });
        return text(reportGraph(graph));
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "merge_preview",
    {
      title: "合并预演（单对）",
      description:
        "预演把 from 合入 into 会不会冲突。全程用 git merge-tree，不改工作区、不建分支、不产生任何提交。detail=true 时额外给出冲突正文与逐块溯源（谁在哪个 commit 改的），代价是慢很多。",
      annotations: READ_ONLY,
      inputSchema: z.object({
        cwd: cwdArg,
        into: z.string().describe("线上目标分支，如 origin/master"),
        from: z.string().describe("我的分支"),
        noFetch: noFetchArg,
        detail: z
          .boolean()
          .optional()
          .describe("true 则输出冲突正文 + blame 溯源；默认只给冲突文件列表"),
      }),
    },
    async ({ cwd, into, from, noFetch, detail }) => {
      try {
        const root = repo(cwd);
        const remote = await remoteFor(root);
        if (detail) {
          const data = await rehearseMerge({
            cwd: root,
            into,
            from,
            fetch: !noFetch,
            remote,
          });
          return text(reportMergeRehearsal(data));
        }
        const data = await previewMerge({
          cwd: root,
          into,
          from,
          fetch: !noFetch,
          remote,
        });
        const head = data.clean
          ? `\`${from}\` → \`${into}\` 可干净合并。`
          : `\`${from}\` → \`${into}\` 有 ${data.conflictFiles.length} 个冲突文件：`;
        const list = data.conflictFiles.map((f) => `- \`${f.path}\``);
        return text([head, ...list].join("\n"));
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "merge_survey",
    {
      title: "合并矩阵（批量）",
      description:
        "批量预演：froms × intos 的每一种组合各跑一次 merge-tree，一次看清哪些分支合得进去、哪些会撞。整批只 fetch 一次，只报冲突文件路径不生成正文，适合发布前扫一遍。",
      annotations: READ_ONLY,
      inputSchema: z.object({
        cwd: cwdArg,
        intos: z.array(z.string()).min(1).describe("线上目标分支列表"),
        froms: z.array(z.string()).min(1).describe("待合入的分支列表"),
        noFetch: noFetchArg,
      }),
    },
    async ({ cwd, intos, froms, noFetch }) => {
      try {
        const root = repo(cwd);
        const data = await surveyMerges({
          cwd: root,
          pairs: crossPairs(intos, froms),
          fetch: !noFetch,
          remote: await remoteFor(root),
        });
        return text(reportMergeSurvey(data));
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "merge_order",
    {
      title: "合入顺序建议",
      description:
        "多个分支都要合进同一个目标时，推演按什么顺序合最省事。串行模拟全程在 git 对象库内完成（merge-tree 的结果树 + commit-tree），不改工作区、不建分支。返回建议顺序、能连续干净合入几个、从哪一个开始需要人工。",
      annotations: READ_ONLY,
      inputSchema: z.object({
        cwd: cwdArg,
        into: z.string().describe("线上目标分支"),
        branches: z.array(z.string()).min(2).describe("待依次合入的分支"),
        noFetch: noFetchArg,
      }),
    },
    async ({ cwd, into, branches, noFetch }) => {
      try {
        const root = repo(cwd);
        const data = await suggestMergeOrder({
          cwd: root,
          into,
          branches,
          fetch: !noFetch,
          remote: await remoteFor(root),
        });
        return text(reportMergeOrder(data));
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "mr_prepare",
    {
      title: "MR 准备信息",
      description:
        "识别远程平台（GitHub / GitLab）、可用 CLI、默认标题与可选审核人，并给出网页版创建地址。只读，不创建任何东西。",
      annotations: READ_ONLY,
      inputSchema: z.object({
        cwd: cwdArg,
        into: z.string().describe("目标分支"),
        from: z.string().describe("源分支"),
        sourceBranch: z.string().optional().describe("实际用于 MR 的源分支，默认同 from"),
      }),
    },
    async ({ cwd, into, from, sourceBranch }) => {
      try {
        const root = repo(cwd);
        const data = await prepareCreateMr({
          cwd: root,
          into,
          from,
          sourceBranch,
          remote: await remoteFor(root),
          method: "cli",
        });
        const lines = [
          `平台：${data.platform}${data.cli ? `（CLI：${data.cli}）` : "（无可用 CLI）"}`,
          `源 → 目标：\`${data.sourceBranch}\` → \`${data.targetBranch}\``,
          `默认标题：${data.title}`,
          data.createMrUrl ? `网页创建：${data.createMrUrl}` : "",
          data.candidates.length > 0
            ? `可选审核人：${data.candidates.map((c) => c.username).join(", ")}`
            : "",
          ...data.messages,
        ].filter(Boolean);
        return text(lines.join("\n"));
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "open_ui",
    {
      title: "在编辑器里打开预演面板",
      description:
        "把 into/from 种进 Git Insight 扩展的预演面板并拉起窗口，让人接手选边、一键解决、申请 MR。分析完发现要动手时用它交接。需要本机装了扩展；没装则返回 URI 让用户自己打开。",
      annotations: OPENS_WINDOW,
      inputSchema: z.object({
        cwd: cwdArg,
        into: z.string().describe("线上目标分支，如 origin/master"),
        from: z.string().describe("我的分支"),
        autoPreview: z
          .boolean()
          .optional()
          .describe("默认 true：打开后立刻跑一次预演"),
      }),
    },
    async ({ cwd, into, from, autoPreview }) => {
      try {
        const data = await openInsightPanel({
          cwd: repo(cwd),
          into,
          from,
          autoPreview,
        });
        return text(
          data.opened
            ? `已唤起预演面板：${into} ← ${from}（${data.openedWith}）`
            : [
                "没能自动打开窗口，可能本机没装扩展或 cursor 命令不在 PATH。",
                "请手动打开这个链接：",
                data.uri,
                "",
                ...data.messages,
              ].join("\n"),
        );
      } catch (err) {
        return failed(err);
      }
    },
  );

  if (!writeEnabled) {
    return server;
  }

  console.error(
    "[git-insight-mcp] GIT_INSIGHT_MCP_ALLOW_WRITE=1：已注册写操作工具（apply_resolve / create_mr）",
  );

  server.registerTool(
    "apply_resolve",
    {
      title: "落盘并推送（写）",
      description:
        "把裁决好的冲突内容落到一个临时分支上并可选推送。会写仓库，必须显式传 confirm=true。files 为空数组表示这次合并本来就干净，只建临时分支并推送。",
      annotations: WRITES,
      inputSchema: z.object({
        cwd: cwdArg,
        into: z.string().describe("线上目标分支"),
        from: z.string().describe("我的分支"),
        files: z
          .array(
            z.object({
              path: z.string(),
              resolvedContent: z.string(),
            }),
          )
          .describe("每个冲突文件解决后的完整内容"),
        push: z.boolean().optional().describe("默认 true"),
        tempBranch: z.string().optional(),
        confirm: z.literal(true).describe("确认执行写操作"),
      }),
    },
    async ({ cwd, into, from, files, push, tempBranch }) => {
      try {
        const root = repo(cwd);
        const data = await applyStashedResolve({
          cwd: root,
          into,
          from,
          files,
          remote: await remoteFor(root),
          push,
          tempBranch,
        });
        return text(
          [
            `临时分支 ${data.tempBranch}`,
            `commit ${data.commitSha.slice(0, 7)}`,
            data.pushed ? "已推送" : "未推送",
            data.createMrUrl ? `创建页：${data.createMrUrl}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        );
      } catch (err) {
        return failed(err);
      }
    },
  );

  server.registerTool(
    "create_mr",
    {
      title: "创建 MR / PR（写）",
      description: "创建 MR / PR。会调用远程平台 API 或本机 CLI，必须显式传 confirm=true。",
      annotations: WRITES,
      inputSchema: z.object({
        cwd: cwdArg,
        sourceBranch: z.string(),
        targetBranch: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        reviewers: z.array(z.string()).optional(),
        confirm: z.literal(true).describe("确认执行写操作"),
      }),
    },
    async ({ cwd, sourceBranch, targetBranch, title, body, reviewers }) => {
      try {
        const root = repo(cwd);
        const data = await createMergeRequest({
          cwd: root,
          sourceBranch,
          targetBranch,
          title,
          body,
          reviewers: reviewers ?? [],
          remote: await remoteFor(root),
          method: "cli",
        });
        return text(
          data.url
            ? `MR 已创建：${data.sourceBranch} → ${data.targetBranch}\n${data.url}`
            : `已提交创建（via ${data.via}），未返回 URL`,
        );
      } catch (err) {
        return failed(err);
      }
    },
  );

  return server;
}

const handle = serveStdio(createServer);

console.error(
  `[git-insight-mcp] v${VERSION} 已就绪（stdio）；仓库根 ${DEFAULT_CWD}${
    writeEnabled ? "" : "；只读模式"
  }`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void handle.close();
  });
}
