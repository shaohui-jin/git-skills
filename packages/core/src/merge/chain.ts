/**
 * 串行合并模拟：不 checkout、不建 worktree，全程在对象库里推。
 *
 * 原理：`merge-tree --write-tree` 除了报冲突，还会输出合并后的**结果树 OID**。
 * 把它交给 `commit-tree` 造一个游离 commit，就能当作下一次 merge-tree 的一侧，
 * 从而模拟「先合 A、再合 B、再合 C」。游离 commit 不被任何 ref 引用，
 * 之后由 git gc 自然回收，不污染仓库。
 *
 * 目标函数是 cleanPrefix（从头能连续干净合入几个），不是「总冲突数最少」：
 * 一旦某步冲突，结果树里的 blob 就带着冲突标记，再往下推出来的数字是失真的；
 * 而且现实里人会先解掉冲突再合下一个。所以遇到第一处冲突就停，
 * 报「按这个顺序前 k 个能干净合入，第 k+1 个开始要人工」。
 */
import { listRemotes } from "../git/remotes.js";
import { ensureRev, resolveRepoRoot, runGit } from "../git/runner.js";
import { maybeFetch } from "../git/fetch.js";
import { reportProgress, mapProgress } from "../progress.js";
import type { ProgressReporter } from "../types.js";
import { isSameBranchForMr } from "./branchName.js";
import { previewMergeBySha } from "./preview.js";
import type { SurveyOutcome } from "./survey.js";

export interface MergeChainStep {
  from: string;
  fromSha: string;
  outcome: SurveyOutcome;
  conflictPaths: string[];
  /** 这一步之后的累计提交（游离 commit）；冲突或跳过时为空 */
  commit: string;
}

export interface MergeChainResult {
  into: string;
  intoSha: string;
  order: string[];
  steps: MergeChainStep[];
  /** 从头开始能连续干净合入的分支数 —— 主目标函数 */
  cleanPrefix: number;
  /** 第一个卡住的分支；null 表示全部干净 */
  blockedAt: string | null;
  /** 卡住那一步的冲突文件 */
  blockedPaths: string[];
  /** 不是冲突而是别的原因卡住时（ref 解析失败等）的说明 */
  blockedReason?: string;
}

export interface SimulateChainOptions {
  cwd?: string;
  into: string;
  order: readonly string[];
  /** 默认 true */
  fetch?: boolean;
  remote?: string;
  onProgress?: ProgressReporter;
}

interface ChainRunner {
  repoRoot: string;
  intoSha: string;
  remoteNames: string[];
  toSha: (ref: string) => Promise<string>;
}

async function makeRunner(
  cwd: string | undefined,
  into: string,
  fetchFirst: boolean,
  remote: string | undefined,
  onProgress?: ProgressReporter,
): Promise<ChainRunner> {
  const repoRoot = await resolveRepoRoot(cwd);
  if (fetchFirst) {
    await maybeFetch(repoRoot, true, remote ?? "origin", (u) =>
      mapProgress(onProgress, 2, 18, u.percent / 100, u.label),
    );
  }
  const seen = new Map<string, Promise<string>>();
  const toSha = (ref: string): Promise<string> => {
    let hit = seen.get(ref);
    if (!hit) {
      hit = ensureRev(repoRoot, ref);
      seen.set(ref, hit);
    }
    return hit;
  };
  const remoteNames = (await listRemotes(repoRoot)).map((r) => r.name).filter(Boolean);
  return { repoRoot, intoSha: await toSha(into), remoteNames, toSha };
}

/**
 * 由结果树造一个游离的两亲 commit，作为下一步的「已合入」状态。
 *
 * 身份写死而不用仓库配置：这些 commit 不会进任何 ref、也不会被推走，
 * 用用户的名字反而误导；更重要的是没配 user.email 的机器上 commit-tree 会直接失败，
 * 而顺序推演是只读操作，不该因为一条无关配置就跑不起来。
 */
const SIM_IDENTITY: NodeJS.ProcessEnv = {
  GIT_AUTHOR_NAME: "git-insight",
  GIT_AUTHOR_EMAIL: "git-insight@localhost",
  GIT_COMMITTER_NAME: "git-insight",
  GIT_COMMITTER_EMAIL: "git-insight@localhost",
};

async function commitTree(
  repoRoot: string,
  tree: string,
  parents: string[],
): Promise<string> {
  const args = ["commit-tree", tree];
  for (const p of parents) {
    args.push("-p", p);
  }
  args.push("-m", "git-insight: simulated merge (unreferenced)");
  const { stdout } = await runGit(repoRoot, args, { env: SIM_IDENTITY });
  return stdout.trim();
}

async function runChain(
  runner: ChainRunner,
  into: string,
  order: readonly string[],
  onProgress?: ProgressReporter,
): Promise<MergeChainResult> {
  const steps: MergeChainStep[] = [];
  let cursor = runner.intoSha;
  let cleanPrefix = 0;
  let blockedAt: string | null = null;
  let blockedPaths: string[] = [];
  let blockedReason: string | undefined;

  for (let i = 0; i < order.length; i++) {
    const from = order[i]!;
    await mapProgress(
      onProgress,
      20,
      96,
      (i + 1) / Math.max(1, order.length),
      `模拟合入 ${from}（第 ${i + 1}/${order.length} 步）…`,
    );

    if (isSameBranchForMr(into, from, runner.remoteNames)) {
      steps.push({
        from,
        fromSha: "",
        outcome: "same",
        conflictPaths: [],
        commit: "",
      });
      continue;
    }

    let fromSha: string;
    try {
      fromSha = await runner.toSha(from);
    } catch (err) {
      steps.push({
        from,
        fromSha: "",
        outcome: "error",
        conflictPaths: [],
        commit: "",
      });
      blockedAt = from;
      blockedReason = err instanceof Error ? err.message : String(err);
      break;
    }

    const preview = await previewMergeBySha(runner.repoRoot, cursor, fromSha);
    const outcome: SurveyOutcome = preview.unrelatedHistories
      ? "unrelated"
      : preview.clean
        ? "clean"
        : "conflicts";

    if (outcome !== "clean" || !preview.resultTree) {
      const paths = preview.conflictFiles.map((f) => f.path);
      steps.push({
        from,
        fromSha,
        outcome: preview.resultTree ? outcome : "error",
        conflictPaths: paths,
        commit: "",
      });
      blockedAt = from;
      blockedPaths = paths;
      if (!preview.resultTree) {
        blockedReason =
          outcome === "unrelated"
            ? "两条历史没有共同祖先"
            : "merge-tree 没有产出结果树，无法继续往下推";
      }
      break;
    }

    cursor = await commitTree(runner.repoRoot, preview.resultTree, [cursor, fromSha]);
    cleanPrefix += 1;
    steps.push({
      from,
      fromSha,
      outcome: "clean",
      conflictPaths: [],
      commit: cursor,
    });
  }

  return {
    into,
    intoSha: runner.intoSha,
    order: [...order],
    steps,
    cleanPrefix,
    blockedAt,
    blockedPaths,
    blockedReason,
  };
}

export async function simulateMergeChain(
  options: SimulateChainOptions,
): Promise<MergeChainResult> {
  const onProgress = options.onProgress;
  await reportProgress(onProgress, 2, "准备串行模拟…");
  const runner = await makeRunner(
    options.cwd,
    options.into,
    options.fetch !== false,
    options.remote,
    onProgress,
  );
  const result = await runChain(runner, options.into, options.order, onProgress);
  await reportProgress(onProgress, 100, "模拟完成");
  return result;
}

export interface SuggestOrderOptions {
  cwd?: string;
  into: string;
  branches: readonly string[];
  /** 默认 true */
  fetch?: boolean;
  remote?: string;
  onProgress?: ProgressReporter;
}

export interface SuggestOrderResult {
  best: MergeChainResult;
  /** 按传入顺序直接合的结果，用于对比「优化了多少」 */
  baseline: MergeChainResult;
  /** 实际跑过的链条数，用于说明搜索成本 */
  tried: number;
}

/**
 * 贪心：每一步从剩余分支里挑能干净合入的，都不行就停。
 *
 * 不做全排列。N 个分支的全排列是 N!，而贪心在「能干净合入就先合」这个
 * 目标下已经足够好：干净合入不会让后续更难（结果树只是多了已有的改动），
 * 所以每步取任意一个可行分支都不会牺牲最终的 cleanPrefix 上界。
 */
async function greedyChain(
  runner: ChainRunner,
  into: string,
  branches: readonly string[],
  onProgress?: ProgressReporter,
): Promise<{ result: MergeChainResult; tried: number }> {
  const remaining = new Set(branches);
  const steps: MergeChainStep[] = [];
  const order: string[] = [];
  let cursor = runner.intoSha;
  let cleanPrefix = 0;
  let tried = 0;
  const total = branches.length;

  while (remaining.size > 0) {
    let picked: { from: string; fromSha: string; tree: string } | null = null;
    /** 本轮剔掉了 same / error，剩下的还没试完，得重开一轮而不是当作「全卡住」 */
    let dropped = false;
    // 全都合不进去时，用来报告「最接近可合的那个」
    let leastBad: { from: string; paths: string[] } | null = null;

    for (const from of remaining) {
      if (isSameBranchForMr(into, from, runner.remoteNames)) {
        remaining.delete(from);
        order.push(from);
        steps.push({ from, fromSha: "", outcome: "same", conflictPaths: [], commit: "" });
        dropped = true;
        break;
      }

      let fromSha: string;
      try {
        fromSha = await runner.toSha(from);
      } catch {
        remaining.delete(from);
        order.push(from);
        steps.push({ from, fromSha: "", outcome: "error", conflictPaths: [], commit: "" });
        dropped = true;
        break;
      }

      tried += 1;
      await mapProgress(
        onProgress,
        20,
        96,
        (total - remaining.size) / Math.max(1, total),
        `试探 ${from}…`,
      );
      const preview = await previewMergeBySha(runner.repoRoot, cursor, fromSha);

      if (preview.clean && preview.resultTree) {
        picked = { from, fromSha, tree: preview.resultTree };
        break;
      }
      const paths = preview.conflictFiles.map((f) => f.path);
      if (!leastBad || paths.length < leastBad.paths.length) {
        leastBad = { from, paths };
      }
    }

    if (dropped) {
      continue;
    }

    if (picked) {
      cursor = await commitTree(runner.repoRoot, picked.tree, [cursor, picked.fromSha]);
      cleanPrefix += 1;
      remaining.delete(picked.from);
      order.push(picked.from);
      steps.push({
        from: picked.from,
        fromSha: picked.fromSha,
        outcome: "clean",
        conflictPaths: [],
        commit: cursor,
      });
      continue;
    }

    // 剩下的都会冲突：把最轻的那个排在最前，作为「从这里开始要人工」
    const blocker = leastBad;
    if (!blocker) {
      break;
    }
    order.push(blocker.from, ...[...remaining].filter((b) => b !== blocker.from));
    steps.push({
      from: blocker.from,
      fromSha: "",
      outcome: "conflicts",
      conflictPaths: blocker.paths,
      commit: "",
    });
    return {
      result: {
        into,
        intoSha: runner.intoSha,
        order,
        steps,
        cleanPrefix,
        blockedAt: blocker.from,
        blockedPaths: blocker.paths,
      },
      tried,
    };
  }

  return {
    result: {
      into,
      intoSha: runner.intoSha,
      order,
      steps,
      cleanPrefix,
      blockedAt: null,
      blockedPaths: [],
    },
    tried,
  };
}

export async function suggestMergeOrder(
  options: SuggestOrderOptions,
): Promise<SuggestOrderResult> {
  const onProgress = options.onProgress;
  await reportProgress(onProgress, 2, "准备顺序推演…");
  const runner = await makeRunner(
    options.cwd,
    options.into,
    options.fetch !== false,
    options.remote,
    onProgress,
  );

  const baseline = await runChain(runner, options.into, options.branches);
  const greedy = await greedyChain(runner, options.into, options.branches, onProgress);

  await reportProgress(onProgress, 100, "顺序推演完成");
  return {
    best: greedy.result.cleanPrefix >= baseline.cleanPrefix ? greedy.result : baseline,
    baseline,
    tried: greedy.tried + options.branches.length,
  };
}
