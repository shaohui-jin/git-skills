/**
 * 批量合并预演：一次问「这些分支两两合起来会怎样」。
 *
 * 与 previewMerge / rehearseMerge 的分工：
 *   previewMerge   单对，会 fetch，给冲突文件列表
 *   rehearseMerge  单对，额外生成冲突正文 + blame 溯源（贵）
 *   surveyMerges   多对，整批只 fetch 一次，只给路径不给正文（便宜，可高频跑）
 *
 * 矩阵视图、合并顺序建议、后台冲突预警都建立在这个原语上。
 */
import type { GitAuthProvider } from "../git/auth.js";
import { maybeFetch } from "../git/fetch.js";
import { listRemotes } from "../git/remotes.js";
import { ensureRev, resolveRepoRoot, runGit } from "../git/runner.js";
import { mapProgress, reportProgress } from "../progress.js";
import type { ProgressReporter } from "../types.js";
import { mapLimit } from "../util/concurrency.js";
import { defaultTempBranchName } from "./applyResolve.js";
import { isSameBranchForMr } from "./branchName.js";
import { previewMergeBySha } from "./preview.js";

export interface MergeSurveyPair {
  into: string;
  from: string;
}

/** 比 MergeOutcome 多两个只在批量场景出现的结论 */
export type SurveyOutcome = "clean" | "conflicts" | "unrelated" | "same" | "error";

export interface MergeSurveyCell {
  into: string;
  from: string;
  /** outcome === "error" 时可能为空 */
  intoSha: string;
  fromSha: string;
  outcome: SurveyOutcome;
  /** 只有路径：批量场景不生成冲突正文、不做 blame */
  conflictPaths: string[];
  /** merge-tree 结果树 OID，供 chain.ts 串行模拟 */
  resultTree?: string;
  /**
   * 这一对的临时分支已经存在（本地或远程），说明之前解决过。
   *
   * 从 git 里查而不是靠调用方自己记：内存里的记录挨不过面板重建、
   * 推送失败、以及 ref 移动导致的作废，而分支存不存在是可查的事实。
   */
  tempBranch?: TempBranchState;
  error?: string;
}

export interface TempBranchState {
  name: string;
  local: boolean;
  /** 推上去了才谈得上申请 MR */
  remote: boolean;
}

export interface MergeSurveyResult {
  repoRoot: string;
  fetched: boolean;
  generatedAt: number;
  cells: MergeSurveyCell[];
}

export interface MergeSurveyOptions {
  cwd?: string;
  pairs: readonly MergeSurveyPair[];
  remote?: string;
  /** 默认 true，且整批只做一次 */
  fetch?: boolean;
  authToken?: string;
  authProvider?: GitAuthProvider;
  /** 默认 4 */
  concurrency?: number;
  /**
   * 默认 true。同一对 sha 在进程内只算一次，跨调用也复用。
   * 预演结果只取决于两个 sha，所以缓存是安全的。
   */
  cache?: boolean;
  onProgress?: ProgressReporter;
}

const PAIR_CONCURRENCY = 4;

/**
 * 结果只取决于 (repoRoot, intoSha, fromSha)，sha 变了 key 自然就变，
 * 所以不需要失效策略。上限用于防止长驻进程（MCP server、预警）无限增长。
 */
const CACHE_LIMIT = 500;
const cache = new Map<string, MergeSurveyCell>();

function cacheKey(repoRoot: string, intoSha: string, fromSha: string): string {
  return `${repoRoot}\0${intoSha}\0${fromSha}`;
}

function cachePut(key: string, cell: MergeSurveyCell): void {
  if (cache.size >= CACHE_LIMIT) {
    // Map 迭代按插入序，删最旧的一批即可，不值得为它引一个 LRU
    let drop = Math.ceil(CACHE_LIMIT / 4);
    for (const k of cache.keys()) {
      cache.delete(k);
      drop -= 1;
      if (drop <= 0) {
        break;
      }
    }
  }
  cache.set(key, cell);
}

/** 供测试与「强制重算」使用 */
export function clearMergeSurveyCache(): void {
  cache.clear();
}

/**
 * 一次列出所有 merge/* 分支，供整批查「这一对之前解决过没有」。
 *
 * 一次 for-each-ref 而不是每格两次 show-ref：格子数是 N×M，逐格查会把
 * 一个本地元数据查询放大成上百次进程启动。
 */
async function listTempBranches(
  repoRoot: string,
  remoteNames: string[],
): Promise<Map<string, TempBranchState>> {
  const found = new Map<string, TempBranchState>();
  const run = await runGit(
    repoRoot,
    ["for-each-ref", "--format=%(refname)", "refs/heads/merge/", "refs/remotes/"],
    { allowFail: true },
  );
  if (run.code !== 0) {
    return found;
  }
  for (const line of run.stdout.split("\n")) {
    const ref = line.trim();
    if (!ref) {
      continue;
    }
    let name: string | null = null;
    let local = false;
    if (ref.startsWith("refs/heads/")) {
      name = ref.slice("refs/heads/".length);
      local = true;
    } else if (ref.startsWith("refs/remotes/")) {
      const rest = ref.slice("refs/remotes/".length);
      // refs/remotes/<remote>/<branch>；remote 名本身可能带斜杠，逐个试
      const hit = remoteNames.find((r) => rest.startsWith(`${r}/`));
      name = hit ? rest.slice(hit.length + 1) : null;
    }
    if (!name || !name.startsWith("merge/")) {
      continue;
    }
    const prev = found.get(name);
    found.set(name, {
      name,
      local: local || !!prev?.local,
      remote: !local || !!prev?.remote,
    });
  }
  return found;
}

/** ref → sha，同一批里同一个 ref 只解析一次 */
function makeRevResolver(repoRoot: string): (ref: string) => Promise<string> {
  const seen = new Map<string, Promise<string>>();
  return (ref: string) => {
    let hit = seen.get(ref);
    if (!hit) {
      hit = ensureRev(repoRoot, ref);
      seen.set(ref, hit);
    }
    return hit;
  };
}

export async function surveyMerges(
  options: MergeSurveyOptions,
): Promise<MergeSurveyResult> {
  const onProgress = options.onProgress;
  const repoRoot = await resolveRepoRoot(options.cwd);
  const pairs = [...options.pairs];
  const useCache = options.cache !== false;

  await reportProgress(onProgress, 2, `批量预演 ${pairs.length} 组…`);

  let fetched = false;
  if (options.fetch !== false) {
    fetched = await maybeFetch(
      repoRoot,
      true,
      options.remote ?? "origin",
      (u) => mapProgress(onProgress, 2, 22, u.percent / 100, u.label),
      options.authToken
        ? { token: options.authToken, provider: options.authProvider }
        : undefined,
    );
  }

  const remoteNames = (await listRemotes(repoRoot)).map((r) => r.name).filter(Boolean);
  const toSha = makeRevResolver(repoRoot);
  const tempBranches = await listTempBranches(repoRoot, remoteNames);

  /** 之前解决过没有——查 git，不依赖调用方的记忆 */
  const tempFor = (into: string, from: string): TempBranchState | undefined =>
    tempBranches.get(defaultTempBranchName(into, from, remoteNames));

  let done = 0;
  const bump = async (label: string): Promise<void> => {
    done += 1;
    await mapProgress(onProgress, 24, 98, done / Math.max(1, pairs.length), label);
  };

  const runPair = async (pair: MergeSurveyPair): Promise<MergeSurveyCell> => {
    const label = `${pair.from} → ${pair.into}`;
    // 规范化后同名不预演，与单对预演、一键解决的约定一致
    if (isSameBranchForMr(pair.into, pair.from, remoteNames)) {
      await bump(label);
      return {
        into: pair.into,
        from: pair.from,
        intoSha: "",
        fromSha: "",
        outcome: "same",
        conflictPaths: [],
      };
    }

    try {
      const [intoSha, fromSha] = await Promise.all([toSha(pair.into), toSha(pair.from)]);
      const key = cacheKey(repoRoot, intoSha, fromSha);
      if (useCache) {
        const hit = cache.get(key);
        if (hit) {
          await bump(label);
          // 临时分支状态不进缓存：它会因为一次解决就变，而缓存键只认两侧 sha
          return {
            ...hit,
            into: pair.into,
            from: pair.from,
            tempBranch: tempFor(pair.into, pair.from),
          };
        }
      }

      const preview = await previewMergeBySha(repoRoot, intoSha, fromSha, {
        into: pair.into,
        from: pair.from,
      });
      const cell: MergeSurveyCell = {
        into: pair.into,
        from: pair.from,
        intoSha,
        fromSha,
        outcome: preview.unrelatedHistories
          ? "unrelated"
          : preview.clean
            ? "clean"
            : "conflicts",
        conflictPaths: preview.conflictFiles.map((f) => f.path),
        resultTree: preview.resultTree,
      };
      if (useCache) {
        cachePut(key, cell);
      }
      await bump(label);
      return { ...cell, tempBranch: tempFor(pair.into, pair.from) };
    } catch (err) {
      // 单格失败不能拖垮整批：矩阵里一个 ref 打错字，其余格子仍应有结果
      await bump(label);
      return {
        into: pair.into,
        from: pair.from,
        intoSha: "",
        fromSha: "",
        outcome: "error",
        conflictPaths: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const cells = await mapLimit(pairs, options.concurrency ?? PAIR_CONCURRENCY, runPair);

  await reportProgress(onProgress, 100, "批量预演完成");
  return { repoRoot, fetched, generatedAt: Date.now(), cells };
}

/** 笛卡尔积，矩阵视图的常用入口 */
export function crossPairs(
  intos: readonly string[],
  froms: readonly string[],
): MergeSurveyPair[] {
  const pairs: MergeSurveyPair[] = [];
  for (const into of intos) {
    for (const from of froms) {
      pairs.push({ into, from });
    }
  }
  return pairs;
}
