import { ensureRev, resolveRepoRoot } from "../git/runner.js";
import type { ConflictBlameResult, ConflictHunk, MergeOptions } from "../types.js";
import { conflictBlame } from "./blame.js";
import { buildConflictContent } from "./conflictContent.js";
import { previewMerge } from "./preview.js";

/**
 * 合并预演：冲突检测 + 冲突原文 + 来源溯源（不改工作区）。
 * merge-base 失败（无关历史）时仍返回结构化报告，不抛裸 git 错误。
 */
export async function rehearseMerge(options: MergeOptions): Promise<ConflictBlameResult> {
  const withBlame = await conflictBlame(options);
  if (withBlame.clean) {
    return withBlame;
  }

  // 无关历史且没有任何冲突文件：仍返回可读结论
  if (withBlame.unrelatedHistories && withBlame.conflictFiles.length === 0) {
    return withBlame;
  }

  const repoRoot = await resolveRepoRoot(options.cwd);
  const intoSha = withBlame.intoSha || (await ensureRev(repoRoot, options.into));
  const fromSha = withBlame.fromSha || (await ensureRev(repoRoot, options.from));
  // 无 merge-base 时用 empty tree 作为三方合并的 base 近似
  // 无共同祖先时用 Git 空 tree OID 作为三方合并 base
  const base = withBlame.mergeBase || EMPTY_TREE_SHA;

  const maxFiles = options.maxBlameFiles ?? 20;
  const conflictFiles = [];
  for (const file of withBlame.conflictFiles.slice(0, maxFiles)) {
    const content = await buildConflictContent(
      repoRoot,
      base,
      intoSha,
      fromSha,
      file.path,
    );
    const hunks: ConflictHunk[] = withBlame.blamed.filter((h) => h.path === file.path);
    conflictFiles.push({
      ...file,
      hunks,
      conflictContent: content.conflictContent,
      oursContent: content.oursContent,
      theirsContent: content.theirsContent,
      baseContent: content.baseContent,
    });
  }

  for (const file of withBlame.conflictFiles.slice(maxFiles)) {
    conflictFiles.push({
      ...file,
      hunks: withBlame.blamed.filter((h) => h.path === file.path),
      conflictContent: "（超出展示上限，已省略冲突正文）",
    });
  }

  return {
    ...withBlame,
    conflictFiles,
  };
}

/** git hash-object -t tree --stdin </dev/null */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d6927f6fb5fb496";

/** Lightweight preview only (no content/blame) — kept for internal use. */
export { previewMerge };
