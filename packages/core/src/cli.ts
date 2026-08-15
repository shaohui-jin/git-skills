#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { rehearseMerge } from "./merge/rehearsal.js";
import { fetchRemote } from "./git/fetch.js";
import { buildBranchGraph } from "./graph/builder.js";
import { applyStashedResolve } from "./merge/applyResolve.js";
import {
  createMergeRequest,
  prepareCreateMr,
} from "./merge/createMr.js";
import { isSameBranchForMr } from "./merge/branchName.js";
import { crossPairs, surveyMerges } from "./merge/survey.js";
import { suggestMergeOrder } from "./merge/chain.js";
import type { MrMethod } from "./config/gitInsightConfig.js";
import { GitError } from "./git/runner.js";
import { listRemotes, resolveRemoteName } from "./git/remotes.js";
import {
  reportFetch,
  reportGraph,
  reportMergeOrder,
  reportMergeRehearsal,
  reportMergeSurvey,
} from "./report/chinese.js";
import { graphToMermaid, mergeToMermaid } from "./report/mermaid.js";
import { openInsightUi } from "./ui/openPanel.js";
import type { CliJsonError, CliJsonResult } from "./types.js";
import type { StashFilePayload } from "./merge/applyResolve.js";

function printJson(payload: CliJsonResult<unknown> | CliJsonError): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usage(): string {
  return `git-insight — branch graph, merge rehearsal, resolve & MR

Usage (read-only):
  git-insight graph [--cwd <path>] [--max <n>] [--into <branch>] [--from <branch>] [--no-fetch]
  git-insight fetch [--cwd <path>] [--remote <name>]
  git-insight preview-merge --into <线上目标> --from <我的分支> [--cwd <path>] [--no-fetch] [--pr]
  git-insight survey --into <a,b> --from <x,y,z> [--cwd] [--no-fetch] [--concurrency <n>]
  git-insight merge-order --into <线上目标> --branches <a,b,c> [--cwd] [--no-fetch]

Usage (write / MR — 需确认后由 Agent 调用):
  git-insight apply-resolve --into <线上> --from <我的> --stash <file.json> [--cwd] [--no-push]
  git-insight prepare-mr --into <线上> --from <我的> [--source <分支>] [--method cli|token] [--token <pat>] [--cwd]
  git-insight create-mr --source <源> --target <目标> [--method cli|token] [--token <pat>] [--title] [--body] [--reviewers a,b] [--cwd]
  git-insight open-ui --into <线上> --from <我的> [--cwd] [--no-open] [--mode auto|extension|browser]

Notes:
  - preview-merge: --into=线上合入目标（建议远程），--from=我的分支
  - preview-merge --pr: 额外为溯源 commit 关联 PR 号（每个 commit 一次 gh 调用，慢，默认关闭）
  - survey: 批量预演 from × into 笛卡尔积，只报冲突文件路径、不生成正文，整批只 fetch 一次
  - merge-order: 推演把多个分支依次合入 --into 的最佳顺序，全程在对象库内模拟，不改工作区
  - apply-resolve: stash JSON 为 { files: [{ path, resolvedContent }] }；干净合并可用 { "files": [] }
  - create-mr --method: cli（本机 gh/glab）| token（--token 或环境 GIT_INSIGHT_GITHUB_TOKEN / GIT_INSIGHT_GITLAB_TOKEN）
  - open-ui: 打开预演 UI；--mode auto（默认）优先扩展，失败时无浏览器 fallback 除非通过 MCP
  - open-ui --mode extension: 仅 vscode:// URI；browser: 需 MCP 环境
  - 同名分支（master ↔ origin/master）不要走 MR，请自行 push/pull
  - --remote 未传时：读 ~/.git-insight/user-config.json 的 defaultRemote，再按仓库 remotes 兜底
`;
}

async function remoteNames(cwd?: string): Promise<string[]> {
  return (await listRemotes(cwd)).map((r) => r.name);
}

async function resolvedRemote(
  args: string[],
  cwd?: string,
): Promise<string> {
  const { remote } = await resolveRemoteName(cwd, getFlag(args, "--remote"));
  return remote;
}

function getFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) {
    return undefined;
  }
  return args[idx + 1];
}

function hasSwitch(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseMethod(raw: string | undefined): MrMethod | null {
  if (!raw) {
    return null;
  }
  if (raw === "cli" || raw === "token" || raw === "browser" || raw === "download-cli") {
    return raw;
  }
  throw new GitError(`未知 --method：${raw}（支持 cli|token|browser|download-cli）`, {
    code: "USAGE",
  });
}

function resolveToken(explicit: string | undefined, platformHint?: string): string | undefined {
  const t = explicit?.trim();
  if (t) {
    return t;
  }
  const gh = process.env.GIT_INSIGHT_GITHUB_TOKEN?.trim();
  const gl = process.env.GIT_INSIGHT_GITLAB_TOKEN?.trim();
  if (platformHint === "gitlab") {
    return gl || gh;
  }
  if (platformHint === "github") {
    return gh || gl;
  }
  return gh || gl;
}

async function runMergeRehearsal(command: string, args: string[]): Promise<void> {
  const into = getFlag(args, "--into");
  const from = getFlag(args, "--from");
  if (!into || !from) {
    throw new GitError(`${command} 需要 --into <线上目标> 与 --from <我的分支>`, {
      code: "USAGE",
    });
  }
  const cwd = getFlag(args, "--cwd");
  const remotes = await remoteNames(cwd);
  if (isSameBranchForMr(into, from, remotes)) {
    printJson({
      ok: false,
      command: "preview-merge",
      error: `源/目标是同一分支（${into} ↔ ${from}），请自行 git push / pull，此处不处理`,
      code: "SAME_BRANCH_MR",
    });
    process.exitCode = 1;
    return;
  }
  const data = await rehearseMerge({
    cwd,
    into,
    from,
    fetch: !hasSwitch(args, "--no-fetch"),
    remote: await resolvedRemote(args, cwd),
    lookupPr: hasSwitch(args, "--pr"),
  });
  printJson({
    ok: true,
    command: "preview-merge",
    data,
    mermaid: mergeToMermaid(data),
    report: reportMergeRehearsal(data),
  });
}

/** `--into a,b` / `--into a --into b` 都接受 */
function getList(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) {
      continue;
    }
    const raw = args[i + 1];
    if (!raw || raw.startsWith("--")) {
      continue;
    }
    out.push(...raw.split(/[,，]/).map((s) => s.trim()).filter(Boolean));
  }
  return [...new Set(out)];
}

async function runSurvey(args: string[]): Promise<void> {
  const intos = getList(args, "--into");
  const froms = getList(args, "--from");
  if (intos.length === 0 || froms.length === 0) {
    throw new GitError(
      "survey 需要 --into <目标,可多个> 与 --from <来源,可多个>",
      { code: "USAGE" },
    );
  }
  const cwd = getFlag(args, "--cwd");
  const concurrency = Number(getFlag(args, "--concurrency"));
  const data = await surveyMerges({
    cwd,
    pairs: crossPairs(intos, froms),
    fetch: !hasSwitch(args, "--no-fetch"),
    remote: await resolvedRemote(args, cwd),
    // 非法值（NaN、0、负数）一律当没传，别把并发上限算成 0
    concurrency: Number.isFinite(concurrency) && concurrency >= 1 ? concurrency : undefined,
  });
  printJson({
    ok: true,
    command: "survey",
    data,
    report: reportMergeSurvey(data),
  });
}

async function runMergeOrder(args: string[]): Promise<void> {
  const into = getFlag(args, "--into");
  const branches = getList(args, "--branches");
  if (!into || branches.length === 0) {
    throw new GitError(
      "merge-order 需要 --into <线上目标> 与 --branches <a,b,c>",
      { code: "USAGE" },
    );
  }
  const cwd = getFlag(args, "--cwd");
  const data = await suggestMergeOrder({
    cwd,
    into,
    branches,
    fetch: !hasSwitch(args, "--no-fetch"),
    remote: await resolvedRemote(args, cwd),
  });
  printJson({
    ok: true,
    command: "merge-order",
    data,
    report: reportMergeOrder(data),
  });
}

async function runApplyResolve(args: string[]): Promise<void> {
  const into = getFlag(args, "--into");
  const from = getFlag(args, "--from");
  const stashPath = getFlag(args, "--stash");
  if (!into || !from || !stashPath) {
    throw new GitError(
      "apply-resolve 需要 --into --from --stash <json文件>",
      { code: "USAGE" },
    );
  }
  const cwd = getFlag(args, "--cwd");
  const remotes = await remoteNames(cwd);
  if (isSameBranchForMr(into, from, remotes)) {
    throw new GitError(
      `源/目标是同一分支，请自行 push / pull，勿 apply-resolve`,
      { code: "SAME_BRANCH_MR" },
    );
  }
  const raw = await readFile(stashPath, "utf8");
  let parsed: { files?: StashFilePayload[] };
  try {
    parsed = JSON.parse(raw) as { files?: StashFilePayload[] };
  } catch {
    throw new GitError("stash JSON 无法解析", { code: "INVALID_STASH" });
  }
  const files = Array.isArray(parsed.files) ? parsed.files : [];
  const data = await applyStashedResolve({
    cwd,
    into,
    from,
    files,
    remote: await resolvedRemote(args, cwd),
    push: !hasSwitch(args, "--no-push"),
    tempBranch: getFlag(args, "--temp-branch"),
  });
  printJson({
    ok: true,
    command: "apply-resolve",
    data,
    report: [
      `临时分支 ${data.tempBranch}`,
      `commit ${data.commitSha.slice(0, 7)}`,
      data.pushed ? "已推送" : "未推送",
      data.createMrUrl ? `创建页：${data.createMrUrl}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  });
}

async function runPrepareMr(args: string[]): Promise<void> {
  const into = getFlag(args, "--into");
  const from = getFlag(args, "--from");
  if (!into || !from) {
    throw new GitError("prepare-mr 需要 --into 与 --from", { code: "USAGE" });
  }
  const method = parseMethod(getFlag(args, "--method")) ?? "cli";
  const cwd = getFlag(args, "--cwd");
  const data = await prepareCreateMr({
    cwd,
    into,
    from,
    sourceBranch: getFlag(args, "--source"),
    remote: await resolvedRemote(args, cwd),
    method,
    token: resolveToken(getFlag(args, "--token")),
  });
  printJson({
    ok: true,
    command: "prepare-mr",
    data: {
      ...data,
      mrChoices: [
        {
          id: "cli",
          label: "本机 gh / glab",
          hint: "优先：已登录的 GitHub/GitLab CLI",
        },
        {
          id: "token",
          label: "Token API",
          hint: "传 --token 或环境变量 GIT_INSIGHT_GITHUB_TOKEN / GIT_INSIGHT_GITLAB_TOKEN",
        },
        {
          id: "ui",
          label: "唤起扩展 UI",
          hint: `已安装插件时：git-insight open-ui --into … --from …`,
        },
      ],
    },
    report: `准备 MR：${data.sourceBranch} → ${data.targetBranch}（${data.platform} / ${method}）`,
  });
}

async function runCreateMr(args: string[]): Promise<void> {
  const source = getFlag(args, "--source");
  const target = getFlag(args, "--target");
  if (!source || !target) {
    throw new GitError("create-mr 需要 --source 与 --target", { code: "USAGE" });
  }
  const method = parseMethod(getFlag(args, "--method")) ?? "cli";
  const reviewersRaw = getFlag(args, "--reviewers");
  const reviewers = reviewersRaw
    ? reviewersRaw.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
    : [];
  const cwd = getFlag(args, "--cwd");
  const data = await createMergeRequest({
    cwd,
    sourceBranch: source,
    targetBranch: target,
    title: getFlag(args, "--title"),
    body: getFlag(args, "--body"),
    reviewers,
    remote: await resolvedRemote(args, cwd),
    method,
    token: resolveToken(getFlag(args, "--token")),
  });
  printJson({
    ok: true,
    command: "create-mr",
    data,
    report: data.url
      ? `MR 已创建：${data.sourceBranch} → ${data.targetBranch}\n${data.url}`
      : `已提交创建（via ${data.via}），未返回 URL`,
  });
}

async function runOpenUi(args: string[]): Promise<void> {
  const into = getFlag(args, "--into");
  const from = getFlag(args, "--from");
  if (!into || !from) {
    throw new GitError("open-ui 需要 --into 与 --from", { code: "USAGE" });
  }
  const modeRaw = getFlag(args, "--mode");
  const mode =
    modeRaw === "browser" || modeRaw === "extension" || modeRaw === "auto"
      ? modeRaw
      : "auto";
  const data = await openInsightUi({
    cwd: getFlag(args, "--cwd"),
    into,
    from,
    mode,
    open: !hasSwitch(args, "--no-open"),
  });
  const report =
    data.mode === "browser"
      ? data.opened
        ? `已打开浏览器预演：${into} ← ${from}\n${data.url ?? ""}`
        : `未能自动打开浏览器。请手动访问：\n${data.url ?? ""}`
      : data.opened
        ? `已尝试唤起扩展预演：${into} ← ${from}`
        : `未能自动打开 UI。请手动打开 URI 或使用 MCP open_ui：\n${data.uri ?? ""}`;
  printJson({
    ok: true,
    command: "open-ui",
    data,
    report,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === "-h" || command === "--help") {
    process.stdout.write(usage());
    process.exit(command ? 0 : 1);
    return;
  }

  try {
    if (command === "graph") {
      const maxRaw = getFlag(args, "--max");
      const maxNodes = maxRaw && Number.isFinite(Number(maxRaw)) && Number(maxRaw) > 0
        ? Number(maxRaw)
        : undefined;
      const cwd = getFlag(args, "--cwd");
      const graph = await buildBranchGraph({
        cwd,
        maxNodes,
        into: getFlag(args, "--into"),
        from: getFlag(args, "--from"),
        fetch: !hasSwitch(args, "--no-fetch"),
        remote: await resolvedRemote(args, cwd),
      });
      printJson({
        ok: true,
        command,
        data: graph,
        mermaid: graphToMermaid(graph),
        report: reportGraph(graph),
      });
      return;
    }

    if (command === "fetch") {
      const cwd = getFlag(args, "--cwd");
      const data = await fetchRemote(cwd, await resolvedRemote(args, cwd));
      printJson({
        ok: true,
        command,
        data,
        report: reportFetch(data),
      });
      return;
    }

    if (
      command === "preview-merge" ||
      command === "conflict-blame" ||
      command === "merge-rehearsal"
    ) {
      await runMergeRehearsal(command, args);
      return;
    }

    if (command === "survey") {
      await runSurvey(args);
      return;
    }

    if (command === "merge-order") {
      await runMergeOrder(args);
      return;
    }

    if (command === "apply-resolve") {
      await runApplyResolve(args);
      return;
    }

    if (command === "prepare-mr") {
      await runPrepareMr(args);
      return;
    }

    if (command === "create-mr") {
      await runCreateMr(args);
      return;
    }

    if (command === "open-ui") {
      await runOpenUi(args);
      return;
    }

    throw new GitError(`未知命令：${command}\n\n${usage()}`, { code: "USAGE" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof GitError ? err.code : "UNKNOWN";
    printJson({
      ok: false,
      command: command ?? "unknown",
      error: message,
      code,
    });
    process.exitCode = 1;
  }
}

void main();
