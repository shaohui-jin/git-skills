#!/usr/bin/env node
import { rehearseMerge } from "./merge/rehearsal.js";
import { fetchRemote } from "./git/fetch.js";
import { buildBranchGraph } from "./graph/builder.js";
import { GitError } from "./git/runner.js";
import { reportFetch, reportGraph, reportMergeRehearsal } from "./report/chinese.js";
import { graphToMermaid, mergeToMermaid } from "./report/mermaid.js";
import type { CliJsonError, CliJsonResult } from "./types.js";

function printJson(payload: CliJsonResult<unknown> | CliJsonError): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usage(): string {
  return `git-insight — branch graph & merge rehearsal

Usage:
  git-insight graph [--cwd <path>] [--max <n>] [--into <branch>] [--from <branch>] [--no-fetch]
  git-insight fetch [--cwd <path>] [--remote <name>]
  git-insight preview-merge --into <target> --from <source> [--cwd <path>] [--no-fetch]

Notes:
  - graph: no required args; uses current repo refs (fetch by default)
  - preview-merge（合并预演）: 任意两分支；输出是否可合并、冲突文件、冲突正文、来源溯源
  - conflict-blame: 同 preview-merge（兼容旧命令名）
  - fetch runs by default; use --no-fetch to skip
  - does not modify the worktree (merge-tree / merge-file -p only)
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

async function runMergeRehearsal(command: string, args: string[]): Promise<void> {
  const into = getFlag(args, "--into");
  const from = getFlag(args, "--from");
  if (!into || !from) {
    throw new GitError(`${command} 需要 --into <目标分支> 与 --from <待合并分支>`, {
      code: "USAGE",
    });
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
      const data = await fetchRemote(getFlag(args, "--cwd"), getFlag(args, "--remote") ?? "origin");
      printJson({
        ok: true,
        command,
        data,
        report: reportFetch(data),
      });
      return;
    }

    if (command === "preview-merge" || command === "conflict-blame" || command === "merge-rehearsal") {
      await runMergeRehearsal(command, args);
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
