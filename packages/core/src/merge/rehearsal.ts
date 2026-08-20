import { EMPTY_TREE_SHA } from "../git/constants.js";
import { ensureRev, resolveRepoRoot } from "../git/runner.js";
import type {
  ConflictBlameResult,
  ConflictFile,
  ConflictHunk,
  MergeOptions,
} from "../types.js";
import { mapProgress, reportProgress } from "../progress.js";
import { mapLimit } from "../util/concurrency.js";
import { conflictBlame } from "./blame.js";
import { buildConflictContent } from "./conflictContent.js";
import { previewMerge } from "./preview.js";

/** 每个文件三次 git show + 一次 merge-file，几路并行即可 */
const FILE_CONCURRENCY = 4;

/**
 * 合并预演：冲突检测 + 冲突原文 + 来源溯源（不改工作区）。
 * merge-base 失败（无关历史）时仍返回结构化报告，不抛裸 git 错误。
 */
export async function rehearseMerge(options: MergeOptions): Promise<ConflictBlameResult> {
  const onProgress = options.onProgress;
  const withBlame = await conflictBlame({
    ...options,
    onProgress: onProgress
      ? (u) => mapProgress(onProgress, 0, 55, u.percent / 100, u.label)
      : undefined,
  });
  if (withBlame.clean) {
    await reportProgress(onProgress, 100, "可干净合并");
    return withBlame;
  }

  if (withBlame.unrelatedHistories && withBlame.conflictFiles.length === 0) {
    await reportProgress(onProgress, 100, "无关历史");
    return withBlame;
  }

  const repoRoot = await resolveRepoRoot(options.cwd);
  const intoSha = withBlame.intoSha || (await ensureRev(repoRoot, options.into));
  const fromSha = withBlame.fromSha || (await ensureRev(repoRoot, options.from));
  const base = withBlame.mergeBase || EMPTY_TREE_SHA;

  const maxFiles = options.maxBlameFiles ?? 20;
  const toLoad = withBlame.conflictFiles.slice(0, maxFiles);
  await reportProgress(onProgress, 58, `生成冲突正文（0/${toLoad.length}）…`);

  let finished = 0;
  const conflictFiles: ConflictFile[] = await mapLimit(
    toLoad,
    FILE_CONCURRENCY,
    async (file) => {
      const content = await buildConflictContent(
        repoRoot,
        base,
        intoSha,
        fromSha,
        file.path,
      );
      finished += 1;
      await mapProgress(
        onProgress,
        58,
        98,
        finished / toLoad.length,
        `生成冲突正文（${finished}/${toLoad.length}）：${file.path}`,
      );
      const hunks: ConflictHunk[] = withBlame.blamed.filter((h) => h.path === file.path);
      return {
        ...file,
        hunks,
        conflictContent: content.conflictContent,
        oursContent: content.oursContent,
        theirsContent: content.theirsContent,
        baseContent: content.baseContent,
      };
    },
  );

  for (const file of withBlame.conflictFiles.slice(maxFiles)) {
    conflictFiles.push({
      ...file,
      hunks: withBlame.blamed.filter((h) => h.path === file.path),
      conflictContent: "（超出展示上限，已省略冲突正文）",
    });
  }

  await reportProgress(onProgress, 100, "合并预演完成");
  return {
    ...withBlame,
    conflictFiles,
  };
}

/** Lightweight preview only (no content/blame) — kept for internal use. */
export { previewMerge };
