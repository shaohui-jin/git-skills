#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { rehearseMerge } from "./merge/rehearsal.js";
import { fetchRemote } from "./git/fetch.js";
import { buildBranchGraph } from "./graph/builder.js";
import { applyStashedResolve } from "./merge/applyResolve.js";
import {
  createMergeRequest,
  prepareCreateMr,
} from "./merge/createMr.js";
import { isSameBranchForMr } from "./merge/branchName.js";
import type { MrMethod } from "./config/gitInsightConfig.js";
import { GitError } from "./git/runner.js";
import { reportFetch, reportGraph, reportMergeRehearsal } from "./report/chinese.js";
import { graphToMermaid, mergeToMermaid } from "./report/mermaid.js";
import type { CliJsonError, CliJsonResult } from "./types.js";
import type { StashFilePayload } from "./merge/applyResolve.js";

const EXT_ID = "jinshaohui.git-insight";

function printJson(payload: CliJsonResult<unknown> | CliJsonError): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usage(): string {
  return `git-insight — branch graph, merge rehearsal, resolve & MR

Usage (read-only):
  git-insight graph [--cwd <path>] [--max <n>] [--into <branch>] [--from <branch>] [--no-fetch]
  git-insight fetch [--cwd <path>] [--remote <name>]
  git-insight preview-merge --into <线上目标> --from <我的分支> [--cwd <path>] [--no-fetch]

Usage (write / MR — 需确认后由 Agent 调用):
  git-insight apply-resolve --into <线上> --from <我的> --stash <file.json> [--cwd] [--no-push]
  git-insight prepare-mr --into <线上> --from <我的> [--source <分支>] [--method cli|token] [--token <pat>] [--cwd]
  git-insight create-mr --source <源> --target <目标> [--method cli|token] [--token <pat>] [--title] [--body] [--reviewers a,b] [--cwd]
  git-insight open-ui --into <线上> --from <我的> [--cwd] [--no-open]

Notes:
  - preview-merge: --into=线上合入目标（建议远程），--from=我的分支
  - apply-resolve: stash JSON 为 { files: [{ path, resolvedContent }] }；干净合并可用 { "files": [] }
  - create-mr --method: cli（本机 gh/glab）| token（--token 或环境 GIT_INSIGHT_GITHUB_TOKEN / GIT_INSIGHT_GITLAB_TOKEN）
  - open-ui: 生成并尝试打开扩展预演面板（需已安装 Git Insight）
  - 同名分支（master ↔ origin/master）不要走 MR，请自行 push/pull
`;
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
  if (isSameBranchForMr(into, from)) {
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
    cwd: getFlag(args, "--cwd"),
    into,
    from,
    fetch: !hasSwitch(args, "--no-fetch"),
    remote: getFlag(args, "--remote"),
  });
  printJson({
    ok: true,
    command: "preview-merge",
    data,
    mermaid: mergeToMermaid(data),
    report: reportMergeRehearsal(data),
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
  if (isSameBranchForMr(into, from)) {
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
    cwd: getFlag(args, "--cwd"),
    into,
    from,
    files,
    remote: getFlag(args, "--remote"),
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
  const data = await prepareCreateMr({
    cwd: getFlag(args, "--cwd"),
    into,
    from,
    sourceBranch: getFlag(args, "--source"),
    remote: getFlag(args, "--remote"),
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
  const data = await createMergeRequest({
    cwd: getFlag(args, "--cwd"),
    sourceBranch: source,
    targetBranch: target,
    title: getFlag(args, "--title"),
    body: getFlag(args, "--body"),
    reviewers,
    remote: getFlag(args, "--remote"),
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

function runCmdCapture(
  cmd: string,
  cmdArgs: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      windowsHide: true,
      shell: process.platform === "win32",
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    child.stderr?.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ code: 127, stdout: "", stderr: err.message });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function runOpenUi(args: string[]): Promise<void> {
  const into = getFlag(args, "--into");
  const from = getFlag(args, "--from");
  if (!into || !from) {
    throw new GitError("open-ui 需要 --into 与 --from", { code: "USAGE" });
  }
  const cwd = getFlag(args, "--cwd") ?? process.cwd();
  const q = new URLSearchParams({
    into,
    from,
    cwd,
    autoPreview: "1",
  });
  const uri = `vscode://${EXT_ID}/preview?${q.toString()}`;
  const cursorUri = `cursor://${EXT_ID}/preview?${q.toString()}`;
  const messages: string[] = [];
  let opened = false;
  let openedWith: string | null = null;

  if (!hasSwitch(args, "--no-open")) {
    const attempts: Array<{ bin: string; args: string[] }> =
      process.platform === "win32"
        ? [
            { bin: "cursor", args: ["--open-url", uri] },
            { bin: "cursor", args: [uri] },
            { bin: "cmd", args: ["/c", "start", "", uri] },
            { bin: "cmd", args: ["/c", "start", "", cursorUri] },
          ]
        : [
            { bin: "cursor", args: ["--open-url", uri] },
            { bin: "cursor", args: [uri] },
            { bin: "code", args: ["--open-url", uri] },
            { bin: "open", args: [uri] },
          ];

    for (const a of attempts) {
      const r = await runCmdCapture(a.bin, a.args);
      if (r.code === 0) {
        opened = true;
        openedWith = `${a.bin} ${a.args.join(" ")}`;
        messages.push(`已尝试打开：${openedWith}`);
        break;
      }
      messages.push(`尝试失败：${a.bin}（${(r.stderr || r.stdout).trim() || r.code}）`);
    }
  } else {
    messages.push("已跳过自动打开（--no-open）");
  }

  printJson({
    ok: true,
    command: "open-ui",
    data: {
      extensionId: EXT_ID,
      uri,
      cursorUri,
      vscodeCommand: "gitInsight.openPreview",
      commandArgs: { into, from, cwd, autoPreview: true },
      opened,
      openedWith,
      howTo: [
        "方式 A：本机已装扩展时执行本命令（默认会尝试拉起 Cursor/VS Code）",
        "方式 B：在 Cursor 命令面板运行 Git Insight: 打开预演（带参）",
        `方式 C：打开 URI：${uri}`,
        "方式 D：Agent 在扩展宿主内 executeCommand('gitInsight.openPreview', { into, from })",
      ],
      messages,
    },
    report: opened
      ? `已尝试唤起扩展预演：${into} ← ${from}`
      : `未能自动打开 UI。请手动打开 URI 或命令面板：\n${uri}`,
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
      const graph = await buildBranchGraph({
        cwd: getFlag(args, "--cwd"),
        maxNodes: maxRaw ? Number(maxRaw) : undefined,
        into: getFlag(args, "--into"),
        from: getFlag(args, "--from"),
        fetch: !hasSwitch(args, "--no-fetch"),
        remote: getFlag(args, "--remote"),
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
      const data = await fetchRemote(
        getFlag(args, "--cwd"),
        getFlag(args, "--remote") ?? "origin",
      );
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
