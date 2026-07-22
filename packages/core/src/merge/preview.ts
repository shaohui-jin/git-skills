import { maybeFetch } from "../git/fetch.js";
import { assertMergeTreeSupported } from "../git/version.js";
import {
  ensureRev,
  resolveRepoRoot,
  runGit,
  tryMergeBase,
} from "../git/runner.js";
import type { ConflictFile, MergeOptions, MergePreviewResult } from "../types.js";
import { mapProgress, reportProgress, withSoftProgress } from "../progress.js";

interface ParsedMergeTree {
  clean: boolean;
  conflictFiles: ConflictFile[];
  messages: string[];
}

function collectConflictPaths(text: string): Set<string> {
  const conflictPaths = new Set<string>();
  const patterns = [
    /Merge conflict in (.+)$/gm,
    /CONFLICT \(add\/add\): Merge conflict in (.+)$/gm,
    /CONFLICT \(modify\/delete\): (.+) deleted in/gm,
    /CONFLICT \(rename\/delete\): (.+) deleted in/gm,
    /CONFLICT \(file location\): .+ added in .+ inside a directory .+ containing a file .+ competing with (.+)$/gm,
  ];
  for (const re of patterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      if (match[1]) {
        conflictPaths.add(match[1].trim());
      }
    }
  }

  const blockRe = /changed in both\n\s+base\s+\d+\s+\w+\s+(.+)\n/g;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRe.exec(text)) !== null) {
    if (blockMatch[1]) {
      conflictPaths.add(blockMatch[1].trim());
    }
  }

  const addedBoth = /added in both\n\s+our\s+\d+\s+\w+\s+(.+)\n/g;
  while ((blockMatch = addedBoth.exec(text)) !== null) {
    if (blockMatch[1]) {
      conflictPaths.add(blockMatch[1].trim());
    }
  }

  return conflictPaths;
}

function toConflictFiles(paths: Set<string>): ConflictFile[] {
  return [...paths].sort().map((path) => ({
    path,
    contentConflict: true,
    hunks: [],
  }));
}

async function runMergeTree(
  repoRoot: string,
  intoSha: string,
  fromSha: string,
  options?: { allowUnrelated?: boolean; mergeBaseSha?: string | null },
): Promise<ParsedMergeTree> {
  await assertMergeTreeSupported(repoRoot);

  const args = ["merge-tree", "--write-tree", "-z", "--messages", "--name-only"];
  if (options?.allowUnrelated) {
    args.push("--allow-unrelated-histories");
  }
  args.push(intoSha, fromSha);

  const modern = await runGit(repoRoot, args, { allowFail: true });

  const combined = `${modern.stdout}\n${modern.stderr}`;
  const fromMessages = collectConflictPaths(combined);

  const zParts = modern.stdout.split("\0").map((p) => p.trim()).filter(Boolean);
  for (let i = 1; i < zParts.length; i++) {
    const part = zParts[i];
    if (!part) {
      continue;
    }
    if (!part.includes("\n") && !part.startsWith("CONFLICT") && part !== zParts[0]) {
      if (!part.includes(" ") && (part.includes("/") || /\.\w+$/.test(part))) {
        fromMessages.add(part);
      }
    }
  }

  if (fromMessages.size > 0 || combined.includes("CONFLICT")) {
    return {
      clean: false,
      conflictFiles: toConflictFiles(fromMessages),
      messages: zParts.length > 0 ? zParts : combined.split("\n").filter(Boolean),
    };
  }

  if (modern.code === 0) {
    return {
      clean: true,
      conflictFiles: [],
      messages: zParts,
    };
  }

  // Fallback: classic merge-tree needs an explicit base
  const base = options?.mergeBaseSha;
  if (!base) {
    return {
      clean: false,
      conflictFiles: [],
      messages: [
        ...combined.split("\n").filter((l) => l.trim()),
        "无法计算 merge-base，且 merge-tree 未能给出冲突文件列表（可能为无关历史）。",
      ],
    };
  }

  const classic = await runGit(repoRoot, ["merge-tree", base, intoSha, fromSha], {
    allowFail: true,
  });
  const classicPaths = collectConflictPaths(classic.stdout);
  return {
    clean: classicPaths.size === 0 && !classic.stdout.includes("<<<<<<<"),
    conflictFiles: toConflictFiles(classicPaths),
    messages: classic.stdout.split("\n").filter((l) => l.trim()),
  };
}

/**
 * Preview merging `from` into `into` without touching the worktree.
 * Defaults to fetch first so local remote-tracking branches stay fresh.
 * merge-base 失败时不抛错，返回结构化结果（unrelatedHistories）。
 */
export async function previewMerge(options: MergeOptions): Promise<MergePreviewResult> {
  const onProgress = options.onProgress;
  const repoRoot = await resolveRepoRoot(options.cwd);
  await reportProgress(onProgress, 2, "准备合并预演…");
  const shouldFetch = options.fetch !== false;
  let fetched = false;
  if (shouldFetch) {
    fetched = await maybeFetch(repoRoot, true, options.remote ?? "origin", (u) =>
      mapProgress(onProgress, 2, 28, u.percent / 100, u.label),
    );
  }
  await reportProgress(onProgress, 30, "解析分支…");

  const intoSha = await ensureRev(repoRoot, options.into);
  const fromSha = await ensureRev(repoRoot, options.from);
  await reportProgress(onProgress, 38, "计算 merge-base…");
  const base = await tryMergeBase(repoRoot, intoSha, fromSha);
  const unrelated = base === null;

  await reportProgress(onProgress, 45, "执行 merge-tree（不改工作区）…");
  const parsed = await withSoftProgress(
    onProgress,
    45,
    92,
    "merge-tree 分析冲突中…",
    () =>
      runMergeTree(repoRoot, intoSha, fromSha, {
        allowUnrelated: unrelated,
        mergeBaseSha: base,
      }),
  );
  await reportProgress(onProgress, 100, "冲突检测完成");

  const messages = [...parsed.messages];
  if (unrelated) {
    messages.unshift(
      "两条分支没有共同祖先（unrelated histories），git merge-base 无法计算。",
      "已使用 --allow-unrelated-histories 继续预演合并结果。",
    );
  }

  const clean = unrelated ? false : parsed.clean;
  const outcome = unrelated ? "unrelated" : clean ? "clean" : "conflicts";

  return {
    repoRoot,
    into: options.into,
    from: options.from,
    intoSha,
    fromSha,
    mergeBase: base ?? "",
    clean,
    fetched,
    conflictFiles: parsed.conflictFiles,
    messages,
    unrelatedHistories: unrelated,
    outcome,
  };
}
