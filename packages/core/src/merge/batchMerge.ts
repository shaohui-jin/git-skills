/**
 * 批量合并：干跑预演（merge-tree，零副作用）+ 实跑（worktree 累积真合并）+ 单次 push。
 *
 * 干跑与 chain.ts 的串行模拟同源（merge-tree + commit-tree 造游离 commit 往下推），
 * 关键差异在「源」：干净格子用原分支，解决过冲突的格子用它的临时分支
 * （本地优先，其次远端历史版本）。解决过的分支内容和原分支不同，
 * 它与前序合入分支之间可能产生矩阵完全没测过的新冲突——
 * 所以预测必须在点击时刻基于钉死的 sha 重跑，不信任任何缓存。
 *
 * 实跑选真合并而非纯对象库：merge-tree 不跑 .gitattributes 自定义 merge driver、
 * 不应用 merge.renormalize、不跑 hooks，真合并保真度最高，且与 applyResolve
 * 的工程模式一致。干跑干净的前提下两者结果树应一致（driver 只在冲突时介入）。
 * 一致性护栏：干跑钉死的 sha 在实跑开始时重新解析比对，任何 ref 移动 → 报
 * BATCH_STALE，由调用方自动重跑干跑，绝不带过期预演往下走。
 */
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeFetch } from "../git/fetch.js";
import { listRemotes } from "../git/remotes.js";
import { GitError, ensureRev, resolveRepoRoot, runGit } from "../git/runner.js";
import { mapProgress, reportProgress } from "../progress.js";
import type { ProgressReporter } from "../types.js";
import { defaultTempBranchName } from "./applyResolve.js";
import { branchNameForMr } from "./branchName.js";
import { previewMergeBySha } from "./preview.js";

export type BatchSourceKind = "branch" | "temp-local" | "temp-remote";

export interface BatchMergeEntry {
  /** 矩阵行分支（展示名） */
  from: string;
  /** 冲突格子已解决过：必须有可用临时分支，否则拒绝整批 */
  resolved?: boolean;
  /** 本会话一键解决记录的 commitSha；用于校验本地临时分支没有漂移 */
  commitSha?: string;
}

export interface BatchPlanItem {
  from: string;
  /** 实际参与合并的 ref：原分支名或临时分支名 */
  source: string;
  sourceKind: BatchSourceKind;
  /** 干跑时钉死的 sha；实跑前重新解析比对 */
  sourceSha: string;
  /** sourceKind !== "branch" 时的临时分支名 */
  tempBranch?: string;
}

export type BatchStepOutcome = "clean" | "up-to-date" | "conflicts" | "error";

export interface BatchPlanStep {
  from: string;
  source: string;
  sourceKind: BatchSourceKind;
  sourceSha: string;
  outcome: BatchStepOutcome;
  conflictPaths: string[];
  error?: string;
}

export interface BatchMergePlanResult {
  repoRoot: string;
  into: string;
  intoSha: string;
  batchBranch: string;
  /** 参与合入的源（顺序 = 传入顺序），供确认对话框展示与实跑复用 */
  items: BatchPlanItem[];
  /** 干跑结果，与 items 一一对应 */
  steps: BatchPlanStep[];
  clean: boolean;
  blockedAt: string | null;
  blockedPaths: string[];
  blockedReason?: string;
  /** 干跑全绿时：批量分支相对 into 的改动文件数（单 MR 过大预警） */
  changedFiles?: number;
  warnings: string[];
}

export interface BatchMergePlanOptions {
  cwd?: string;
  into: string;
  entries: readonly BatchMergeEntry[];
  /** 默认 true */
  fetch?: boolean;
  remote?: string;
  onProgress?: ProgressReporter;
}

export interface BatchRunItem {
  from: string;
  source: string;
  sourceKind: BatchSourceKind;
  sourceSha: string;
}

export interface BatchRunStep {
  from: string;
  source: string;
  outcome: "merged" | "up-to-date";
}

export interface BatchMergeRunResult {
  repoRoot: string;
  into: string;
  intoSha: string;
  batchBranch: string;
  /** 批量分支最终 commit */
  commitSha: string;
  remote: string;
  pushed: boolean;
  /** push 失败原因；此时本地批量分支保留，调用方给「重推」 */
  pushError?: string;
  steps: BatchRunStep[];
  /** 主工作区当前分支（全程不切换） */
  previousBranch: string | null;
  messages: string[];
}

export interface BatchMergeRunOptions {
  cwd?: string;
  into: string;
  batchBranch: string;
  items: readonly BatchRunItem[];
  /** 默认 true */
  fetch?: boolean;
  remote?: string;
  onProgress?: ProgressReporter;
}

export interface PushBranchResult {
  remote: string;
  branch: string;
  sha: string;
}

export interface BatchMrPrecheckResult {
  into: string;
  /** fetch 后的最新 into sha */
  intoSha: string;
  batchBranch: string;
  batchSha: string;
  /** 最新 into 已包含在批量分支里（批量分支领先，无需担心） */
  upToDate: boolean;
  /** 批量分支 → 最新 into 是否仍干净 */
  clean: boolean;
  conflictPaths: string[];
}

export interface DeleteBranchesResult {
  deleted: string[];
  failed: Array<{ branch: string; error: string }>;
}

/** 推送分支用的固定身份：仓库没配 user.name/email 时兜底，commit 才不至于失败 */
const BATCH_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "git-insight",
  GIT_AUTHOR_EMAIL: "git-insight@localhost",
  GIT_COMMITTER_NAME: "git-insight",
  GIT_COMMITTER_EMAIL: "git-insight@localhost",
};

/** 干跑专用：游离 commit 不进任何 ref，身份写死避免依赖仓库配置（同 chain.ts） */
const SIM_IDENTITY: NodeJS.ProcessEnv = BATCH_IDENTITY;

function slugRef(ref: string, remotes: string[]): string {
  return branchNameForMr(ref, remotes)
    .replace(/[^a-zA-Z0-9._/-]+/g, "-")
    .replace(/\/+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * 批量分支名：含 into slug + 时间戳 + 4 位随机后缀。
 * 时间戳让人能认出「这是哪次批量」，随机后缀防同分钟撞名；
 * 即便撞了，实跑前还会查远端同名分支并报错，绝不静默覆盖。
 */
export function batchBranchName(into: string, remotes: string[] = ["origin"]): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(
    now.getHours(),
  )}${pad(now.getMinutes())}`;
  const rand = randomBytes(2).toString("hex");
  return `merge/batch-into-${slugRef(into, remotes)}-${ts}-${rand}`;
}

async function revParseRef(repoRoot: string, ref: string): Promise<string | null> {
  const r = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", ref], {
    allowFail: true,
  });
  const sha = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(sha) ? sha : null;
}

async function isAncestor(
  repoRoot: string,
  sha: string,
  of: string,
): Promise<boolean> {
  const r = await runGit(repoRoot, ["merge-base", "--is-ancestor", sha, of], {
    allowFail: true,
  });
  return r.code === 0;
}

async function currentBranch(cwd: string): Promise<string | null> {
  const r = await runGit(cwd, ["branch", "--show-current"], { allowFail: true });
  const name = r.stdout.trim();
  return name || null;
}

async function listUnmerged(cwd: string): Promise<string[]> {
  const r = await runGit(cwd, ["diff", "--name-only", "--diff-filter=U"], {
    allowFail: true,
  });
  return r.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

async function removeWorktree(repoRoot: string, wtPath: string): Promise<void> {
  await runGit(repoRoot, ["worktree", "remove", "--force", wtPath], { allowFail: true });
  await rm(wtPath, { recursive: true, force: true });
  await runGit(repoRoot, ["worktree", "prune"], { allowFail: true });
}

async function commitTree(
  repoRoot: string,
  tree: string,
  parents: string[],
): Promise<string> {
  const args = ["commit-tree", tree];
  for (const p of parents) {
    args.push("-p", p);
  }
  args.push("-m", "git-insight: batch dry-run (unreferenced)");
  const { stdout } = await runGit(repoRoot, args, { env: SIM_IDENTITY });
  return stdout.trim();
}

/**
 * 实跑的合并身份：优先仓库 user.name/email；没配则回退 git-insight 身份
 * （是推送分支，与纯模拟的游离 commit 区分开——文案上会注明）。
 */
async function commitEnv(repoRoot: string): Promise<NodeJS.ProcessEnv | undefined> {
  const name = await runGit(repoRoot, ["config", "--get", "user.name"], {
    allowFail: true,
  });
  const email = await runGit(repoRoot, ["config", "--get", "user.email"], {
    allowFail: true,
  });
  if (name.stdout.trim() && email.stdout.trim()) {
    return undefined;
  }
  return BATCH_IDENTITY;
}

/** 按优先级解析一格的批量源：本地临时分支 → 远端临时分支 → 原分支 */
async function resolveEntrySource(
  repoRoot: string,
  into: string,
  entry: BatchMergeEntry,
  remote: string,
  remoteNames: string[],
  warnings: string[],
): Promise<BatchPlanItem> {
  const temp = defaultTempBranchName(into, entry.from, remoteNames);

  const localSha = await revParseRef(repoRoot, `refs/heads/${temp}`);
  if (localSha) {
    if (entry.commitSha && entry.commitSha !== localSha) {
      warnings.push(
        `${entry.from}：本地临时分支与本次会话记录不一致（可能重新解决过），将使用本地当前版本 ${localSha.slice(0, 7)}`,
      );
    }
    return { from: entry.from, source: temp, sourceKind: "temp-local", sourceSha: localSha, tempBranch: temp };
  }

  const remoteSha = await revParseRef(repoRoot, `refs/remotes/${remote}/${temp}`);
  if (remoteSha) {
    warnings.push(`${entry.from}：本地无临时分支，使用已推送版本 ${remote}/${temp}`);
    return {
      from: entry.from,
      source: temp,
      sourceKind: "temp-remote",
      sourceSha: remoteSha,
      tempBranch: temp,
    };
  }

  if (entry.resolved) {
    throw new GitError(
      `${entry.from}：没有可用的临时分支（${temp} 本地与远端都不存在），请回矩阵重新解决这一格后再批量`,
      { code: "BATCH_SOURCE_MISSING" },
    );
  }

  try {
    const sha = await ensureRev(repoRoot, entry.from);
    return { from: entry.from, source: entry.from, sourceKind: "branch", sourceSha: sha };
  } catch (err) {
    throw new GitError(
      `${entry.from}：分支解析失败（${err instanceof Error ? err.message : String(err)}），拒绝整批启动`,
      { code: "BATCH_SOURCE_MISSING" },
    );
  }
}

/**
 * 干跑预演：fetch → 解析源（钉死 sha）→ merge-tree 串行推演。
 * 零远端副作用；游离 commit 不被任何 ref 引用，由 git gc 自然回收。
 */
export async function planBatchMerge(
  options: BatchMergePlanOptions,
): Promise<BatchMergePlanResult> {
  const onProgress = options.onProgress;
  const into = options.into.trim();
  const entries = [...options.entries];
  if (!into) {
    throw new GitError("into 不能为空", { code: "USAGE" });
  }
  if (entries.length === 0) {
    throw new GitError("批量合并至少需要一个分支", { code: "USAGE" });
  }
  for (const e of entries) {
    if (!e.from?.trim()) {
      throw new GitError("批量分支名不能为空", { code: "USAGE" });
    }
  }

  await reportProgress(onProgress, 2, "准备批量干跑…");
  const repoRoot = await resolveRepoRoot(options.cwd);
  const remote = options.remote ?? "origin";
  const warnings: string[] = [];

  if (options.fetch !== false) {
    await maybeFetch(repoRoot, true, remote, (u) =>
      mapProgress(onProgress, 2, 15, u.percent / 100, u.label),
    );
  }

  const remoteNames = (await listRemotes(repoRoot)).map((r) => r.name).filter(Boolean);
  const intoSha = await ensureRev(repoRoot, into);
  const batchBranch = batchBranchName(into, remoteNames);

  await reportProgress(onProgress, 18, "解析批量源（钉死 sha）…");
  const items: BatchPlanItem[] = [];
  for (const entry of entries) {
    const from = entry.from.trim();
    if (items.some((i) => i.from === from)) {
      throw new GitError(`批量清单里有重复分支：${from}`, { code: "USAGE" });
    }
    items.push(
      await resolveEntrySource(repoRoot, into, { ...entry, from }, remote, remoteNames, warnings),
    );
  }

  const steps: BatchPlanStep[] = [];
  let cursor = intoSha;
  let blockedAt: string | null = null;
  let blockedPaths: string[] = [];
  let blockedReason: string | undefined;

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    await mapProgress(onProgress, 20, 88, (i + 1) / items.length, `干跑 ${item.from}…`);

    // up-to-date：源已在「已合入状态」里，跳过即可，别造冗余合并提交
    if (await isAncestor(repoRoot, item.sourceSha, cursor)) {
      steps.push({ ...item, outcome: "up-to-date", conflictPaths: [] });
      continue;
    }

    let preview;
    try {
      preview = await previewMergeBySha(repoRoot, cursor, item.sourceSha);
    } catch (err) {
      steps.push({
        ...item,
        outcome: "error",
        conflictPaths: [],
        error: err instanceof Error ? err.message : String(err),
      });
      blockedAt = item.from;
      blockedReason = err instanceof Error ? err.message : String(err);
      break;
    }

    if (preview.unrelatedHistories) {
      steps.push({
        ...item,
        outcome: "error",
        conflictPaths: [],
        error: "两条历史没有共同祖先",
      });
      blockedAt = item.from;
      blockedReason = `${item.from} 与已合入内容没有共同祖先`;
      break;
    }

    if (!preview.clean || !preview.resultTree) {
      const paths = preview.conflictFiles.map((f) => f.path);
      steps.push({ ...item, outcome: "conflicts", conflictPaths: paths });
      blockedAt = item.from;
      blockedPaths = paths;
      blockedReason = `第 ${i + 1} 步：${item.from} 与已合入的前 ${i} 个分支冲突`;
      break;
    }

    cursor = await commitTree(repoRoot, preview.resultTree, [cursor, item.sourceSha]);
    steps.push({ ...item, outcome: "clean", conflictPaths: [] });
  }

  const clean = blockedAt === null;
  let changedFiles: number | undefined;
  if (clean) {
    const diff = await runGit(
      repoRoot,
      ["diff", "--name-only", intoSha, cursor],
      { allowFail: true },
    );
    changedFiles = diff.stdout.split("\n").filter((l) => l.trim()).length;
    if (changedFiles === 0) {
      warnings.push("所有分支相对目标均无新提交，批量分支将与目标一致，无需合并");
    }
  }

  await reportProgress(onProgress, 100, "干跑完成");
  return {
    repoRoot,
    into,
    intoSha,
    batchBranch,
    items,
    steps,
    clean,
    blockedAt,
    blockedPaths,
    blockedReason,
    changedFiles,
    warnings,
  };
}

/**
 * 实跑：sha 护栏 → worktree 累积真合并 → 单次 push。
 *
 * 中途出现干跑未预测到的冲突：立即 merge --abort + 移除 worktree + 删本地批量分支，
 * 主工作区全程不动。push 失败：保留本地批量分支并返回 pushed:false（批量重算成本高，
 * 这是有意为之的例外），由调用方提供「重推」。
 */
export async function runBatchMerge(
  options: BatchMergeRunOptions,
): Promise<BatchMergeRunResult> {
  const onProgress = options.onProgress;
  const into = options.into.trim();
  const batchBranch = options.batchBranch.trim();
  const items = [...options.items];
  if (!into || !batchBranch || items.length === 0) {
    throw new GitError("into / batchBranch / items 不能为空", { code: "USAGE" });
  }

  await reportProgress(onProgress, 2, "准备批量合并…");
  const repoRoot = await resolveRepoRoot(options.cwd);
  const remote = options.remote ?? "origin";

  if (options.fetch !== false) {
    await maybeFetch(repoRoot, true, remote, (u) =>
      mapProgress(onProgress, 2, 12, u.percent / 100, u.label),
    );
  }

  const intoSha = await ensureRev(repoRoot, into);

  // 远端已有同名批量分支：绝不静默覆盖，让调用方换名重来
  if (await revParseRef(repoRoot, `refs/remotes/${remote}/${batchBranch}`)) {
    throw new GitError(
      `远端已存在同名批量分支 ${remote}/${batchBranch}，请重试以换用新分支名`,
      { code: "BATCH_BRANCH_TAKEN" },
    );
  }

  await reportProgress(onProgress, 15, "核对干跑钉死的 sha（一致性护栏）…");
  for (const item of items) {
    const ref =
      item.sourceKind === "temp-local"
        ? `refs/heads/${item.source}`
        : item.sourceKind === "temp-remote"
          ? `refs/remotes/${remote}/${item.source}`
          : item.source;
    const sha = await revParseRef(repoRoot, ref);
    if (!sha) {
      throw new GitError(
        `${item.from}：干跑后源 ${ref} 已不存在，请重新预演`,
        { code: "BATCH_STALE" },
      );
    }
    if (sha !== item.sourceSha) {
      throw new GitError(
        `${item.from}：干跑后 ${ref} 已移动（${item.sourceSha.slice(0, 7)} → ${sha.slice(0, 7)}），已自动重新预演`,
        { code: "BATCH_STALE" },
      );
    }
  }

  const previousBranch = await currentBranch(repoRoot);
  if (previousBranch === batchBranch) {
    throw new GitError(
      `主工作区当前正在检出批量分支「${batchBranch}」，请先切回其他分支`,
      { code: "TEMP_BRANCH_CHECKED_OUT" },
    );
  }

  const messages: string[] = [];
  const steps: BatchRunStep[] = [];
  const wtPath = await mkdtemp(join(tmpdir(), "git-insight-batch-"));
  // 中途冲突：删本地批量分支；push 失败/成功都保留（重推 / MR 要用）
  let committedAny = false;
  /** 冲突中止等需要丢弃批量分支的场景（不管前面合了几个） */
  let discardBranch = false;

  try {
    await reportProgress(onProgress, 18, `创建批量 worktree（${batchBranch}）…`);
    const addRun = await runGit(
      repoRoot,
      ["worktree", "add", "-B", batchBranch, wtPath, intoSha],
      { allowFail: true },
    );
    if (addRun.code !== 0) {
      throw new GitError(
        `无法创建批量 worktree（主工作区未改动）：${(addRun.stderr || addRun.stdout).trim()}`,
        { code: "WORKTREE_ADD_FAILED", stderr: addRun.stderr, stdout: addRun.stdout },
      );
    }
    messages.push(`已在独立 worktree 处理：${wtPath}`);
    messages.push(
      previousBranch
        ? `主工作区保持在「${previousBranch}」，未切换分支`
        : "主工作区 HEAD 未切换",
    );

    const env = await commitEnv(repoRoot);

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      await mapProgress(onProgress, 20, 80, (i + 1) / items.length, `合并 ${item.from}…`);

      if (await isAncestor(wtPath, item.sourceSha, "HEAD")) {
        steps.push({ from: item.from, source: item.source, outcome: "up-to-date" });
        messages.push(`${item.from}：已包含，跳过`);
        continue;
      }

      const msg = `merge: ${item.from} into ${into} via batch ${batchBranch}`;
      const mergeRun = await runGit(
        wtPath,
        ["merge", "--no-ff", "-m", msg, item.sourceSha],
        { allowFail: true, env },
      );
      if (mergeRun.code !== 0) {
        const paths = await listUnmerged(wtPath);
        await runGit(wtPath, ["merge", "--abort"], { allowFail: true });
        discardBranch = true;
        throw new GitError(
          `第 ${i + 1} 步合并 ${item.from} 出现干跑未预测到的冲突` +
            (paths.length > 0 ? `（文件：${paths.join("、")}）` : "") +
            `，已中止并清理（主工作区未改动）`,
          { code: "BATCH_MERGE_CONFLICT", args: paths },
        );
      }
      committedAny = true;
      steps.push({ from: item.from, source: item.source, outcome: "merged" });
      messages.push(`${item.from}：已合并`);
    }

    const head = await runGit(wtPath, ["rev-parse", "HEAD"]);
    const commitSha = head.stdout.trim();
    messages.push(`批量分支 ${batchBranch} @ ${commitSha.slice(0, 7)}`);

    let pushed = false;
    let pushError: string | undefined;
    await reportProgress(onProgress, 85, `推送 ${remote} ${batchBranch}…`);
    const pushRun = await runGit(
      wtPath,
      ["push", "-u", remote, `HEAD:refs/heads/${batchBranch}`],
      { allowFail: true },
    );
    if (pushRun.code !== 0) {
      // 保留本地批量分支：批量重算成本高，给「重推」而不是推倒重来
      pushError = (pushRun.stderr || pushRun.stdout).trim();
      messages.push(`推送失败，本地批量分支已保留：${pushError}`);
    } else {
      pushed = true;
      messages.push(`已推送 ${remote}/${batchBranch}`);
    }

    await reportProgress(onProgress, 100, pushed ? "批量合并完成" : "已合并（推送失败）");
    return {
      repoRoot,
      into,
      intoSha,
      batchBranch,
      commitSha,
      remote,
      pushed,
      pushError,
      steps,
      previousBranch,
      messages,
    };
  } finally {
    await removeWorktree(repoRoot, wtPath);
    // 冲突/护栏中止：批量分支没意义，删掉防下次撞名；
    // push 失败与成功都保留（重推 / 申请 MR 都还要它）
    if (discardBranch || !committedAny) {
      await runGit(repoRoot, ["branch", "-D", batchBranch], { allowFail: true });
    }
  }
}

/**
 * 推送一个已存在的本地分支（批量分支重推、单分支 MR 前的补推送共用）。
 */
export async function pushBranch(options: {
  cwd?: string;
  branch: string;
  remote?: string;
  onProgress?: ProgressReporter;
}): Promise<PushBranchResult> {
  const onProgress = options.onProgress;
  const branch = options.branch.trim();
  if (!branch) {
    throw new GitError("branch 不能为空", { code: "USAGE" });
  }
  await reportProgress(onProgress, 10, `解析 ${branch}…`);
  const repoRoot = await resolveRepoRoot(options.cwd);
  const remote = options.remote ?? "origin";
  const sha = await revParseRef(repoRoot, `refs/heads/${branch}`);
  if (!sha) {
    throw new GitError(`本地分支 ${branch} 不存在`, { code: "NO_LOCAL_BRANCH" });
  }
  await reportProgress(onProgress, 40, `推送 ${remote}/${branch}…`);
  const pushRun = await runGit(
    repoRoot,
    ["push", "-u", remote, `refs/heads/${branch}:refs/heads/${branch}`],
    { allowFail: true },
  );
  if (pushRun.code !== 0) {
    throw new GitError(
      `推送 ${branch} 失败：${(pushRun.stderr || pushRun.stdout).trim()}`,
      { code: "PUSH_FAILED", stderr: pushRun.stderr, stdout: pushRun.stdout },
    );
  }
  await reportProgress(onProgress, 100, "推送完成");
  return { remote, branch, sha };
}

/**
 * MR 前终检：fetch 最新 into 后，预检「批量分支 → 最新 into」。
 * into 在批量期间被推进过且产生冲突时给出预警，由人决定是否继续。
 */
export async function precheckBatchMr(options: {
  cwd?: string;
  into: string;
  batchBranch: string;
  remote?: string;
  fetch?: boolean;
  onProgress?: ProgressReporter;
}): Promise<BatchMrPrecheckResult> {
  const onProgress = options.onProgress;
  const into = options.into.trim();
  const batchBranch = options.batchBranch.trim();
  if (!into || !batchBranch) {
    throw new GitError("into / batchBranch 不能为空", { code: "USAGE" });
  }
  await reportProgress(onProgress, 5, "MR 前终检…");
  const repoRoot = await resolveRepoRoot(options.cwd);
  const remote = options.remote ?? "origin";

  if (options.fetch !== false) {
    await maybeFetch(repoRoot, true, remote, (u) =>
      mapProgress(onProgress, 5, 40, u.percent / 100, u.label),
    );
  }

  const intoSha = await ensureRev(repoRoot, into);
  const batchSha =
    (await revParseRef(repoRoot, `refs/heads/${batchBranch}`)) ??
    (await revParseRef(repoRoot, `refs/remotes/${remote}/${batchBranch}`));
  if (!batchSha) {
    throw new GitError(
      `批量分支 ${batchBranch} 不存在（本地与远端都没有）`,
      { code: "NO_LOCAL_BRANCH" },
    );
  }

  if (await isAncestor(repoRoot, intoSha, batchSha)) {
    await reportProgress(onProgress, 100, "终检通过");
    return {
      into,
      intoSha,
      batchBranch,
      batchSha,
      upToDate: true,
      clean: true,
      conflictPaths: [],
    };
  }

  const preview = await previewMergeBySha(repoRoot, intoSha, batchSha);
  await reportProgress(onProgress, 100, preview.clean ? "终检通过" : "终检发现冲突");
  return {
    into,
    intoSha,
    batchBranch,
    batchSha,
    upToDate: false,
    clean: preview.clean,
    conflictPaths: preview.conflictFiles.map((f) => f.path),
  };
}

/**
 * 批量成功后的清理：删除参与合并的本地 merge/* 临时分支。
 * 只删调用方点名的分支，不做任何通配删除；失败的逐条报告。
 */
export async function deleteLocalBranches(options: {
  cwd?: string;
  branches: readonly string[];
}): Promise<DeleteBranchesResult> {
  const repoRoot = await resolveRepoRoot(options.cwd);
  const deleted: string[] = [];
  const failed: Array<{ branch: string; error: string }> = [];
  for (const raw of options.branches) {
    const branch = raw.trim();
    if (!branch) {
      continue;
    }
    const r = await runGit(repoRoot, ["branch", "-D", branch], { allowFail: true });
    if (r.code === 0) {
      deleted.push(branch);
    } else {
      failed.push({ branch, error: (r.stderr || r.stdout).trim() });
    }
  }
  return { deleted, failed };
}
