import { fetchRemote } from "../git/fetch.js";
import {
  ensureRev,
  mergeBase,
  resolveRepoRoot,
  runGit,
} from "../git/runner.js";
import type { BranchGraph, BranchTip, CommitNode, GraphOptions } from "../types.js";
import { mapProgress, reportProgress, withSoftProgress } from "../progress.js";

const DEFAULT_MAX_NODES = 200;
/** Avoid Windows/ARG_MAX failures when loading commit meta. */
const META_CHUNK = 200;

async function listTips(repoRoot: string): Promise<BranchTip[]> {
  const { stdout } = await runGit(repoRoot, [
    "for-each-ref",
    "--format=%(refname)%00%(refname:short)%00%(objectname)%00%(upstream:short)",
    "refs/heads",
    "refs/remotes",
  ]);

  const tips: BranchTip[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const [refname, name, sha, upstream] = line.split("\0");
    if (!name || !sha || !refname) {
      continue;
    }
    if (refname.endsWith("/HEAD")) {
      continue;
    }
    tips.push({
      name,
      sha,
      upstream: upstream || undefined,
      remote: refname.startsWith("refs/remotes/"),
    });
  }
  return tips;
}

async function loadCommitMetaChunk(
  repoRoot: string,
  shas: string[],
  onProgress?: GraphOptions["onProgress"],
  softFrom = 0,
  softTo = 0,
  softLabel = "加载提交信息…",
): Promise<Map<string, CommitNode>> {
  const map = new Map<string, CommitNode>();
  if (shas.length === 0) {
    return map;
  }
  const { stdout } = await withSoftProgress(
    onProgress && softTo > softFrom ? onProgress : undefined,
    softFrom,
    softTo,
    softLabel,
    () =>
      runGit(repoRoot, [
        "show",
        "-s",
        "--format=%H%00%P%00%an%00%at%00%s",
        ...shas,
      ]),
  );
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const [sha, parentsRaw, author, timeRaw, message] = line.split("\0");
    if (!sha) {
      continue;
    }
    map.set(sha, {
      sha,
      parents: parentsRaw ? parentsRaw.split(" ").filter(Boolean) : [],
      author: author ?? "",
      time: Number(timeRaw ?? 0),
      message: message ?? "",
    });
  }
  return map;
}

async function loadCommitMeta(
  repoRoot: string,
  shas: string[],
  onChunk?: (done: number, total: number) => void | Promise<void>,
  onProgress?: GraphOptions["onProgress"],
  rangeFrom = 45,
  rangeTo = 92,
): Promise<Map<string, CommitNode>> {
  const map = new Map<string, CommitNode>();
  const total = shas.length;
  let done = 0;
  const chunks = Math.max(1, Math.ceil(shas.length / META_CHUNK));
  for (let i = 0; i < shas.length; i += META_CHUNK) {
    const chunk = shas.slice(i, i + META_CHUNK);
    const chunkIndex = Math.floor(i / META_CHUNK);
    const softFrom = rangeFrom + ((rangeTo - rangeFrom) * chunkIndex) / chunks;
    const softTo = rangeFrom + ((rangeTo - rangeFrom) * (chunkIndex + 1)) / chunks;
    const part = await loadCommitMetaChunk(
      repoRoot,
      chunk,
      onProgress,
      softFrom,
      softTo,
      `加载提交信息（${Math.min(total, i + chunk.length)}/${total}）…`,
    );
    for (const [sha, node] of part) {
      map.set(sha, node);
    }
    done = Math.min(total, i + chunk.length);
    await onChunk?.(done, total);
  }
  return map;
}

async function buildLineage(
  repoRoot: string,
  into: string,
  from: string,
): Promise<BranchGraph["lineage"]> {
  const intoSha = await ensureRev(repoRoot, into);
  const fromSha = await ensureRev(repoRoot, from);
  const base = await mergeBase(repoRoot, intoSha, fromSha);

  const fromOnly = await runGit(repoRoot, ["rev-list", "--count", `${base}..${fromSha}`]);
  const intoOnly = await runGit(repoRoot, ["rev-list", "--count", `${base}..${intoSha}`]);

  let branchedFrom:
    | {
        sha: string;
        author: string;
        message: string;
        time: number;
      }
    | undefined;

  const firstExclusive = await runGit(
    repoRoot,
    ["rev-list", "--reverse", "--max-count=1", `${base}..${fromSha}`],
    { allowFail: true },
  );
  const firstSha = firstExclusive.stdout.trim();
  if (firstSha) {
    const meta = await loadCommitMeta(repoRoot, [firstSha]);
    const node = meta.get(firstSha);
    if (node) {
      branchedFrom = {
        sha: node.sha,
        author: node.author,
        message: node.message,
        time: node.time,
      };
    }
  }

  return {
    mergeBase: base,
    fromOnlyCount: Number(fromOnly.stdout.trim() || 0),
    intoOnlyCount: Number(intoOnly.stdout.trim() || 0),
    branchedFrom,
  };
}

/**
 * Build a commit DAG. With no into/from, uses all branch tips.
 * `maxNodes: 0` = unlimited (full graph); default cap 200 for CLI.
 */
export async function buildBranchGraph(options: GraphOptions = {}): Promise<BranchGraph> {
  const onProgress = options.onProgress;
  const repoRoot = await resolveRepoRoot(options.cwd);
  const unlimited = options.maxNodes === 0;
  const maxNodes = unlimited ? 0 : (options.maxNodes ?? DEFAULT_MAX_NODES);
  const shouldFetch = options.fetch !== false;

  await reportProgress(onProgress, 2, "准备仓库…");
  let fetched = false;
  let fetchOk: boolean | undefined;
  let fetchError: string | undefined;
  if (shouldFetch) {
    fetched = true;
    const fr = await fetchRemote(
      repoRoot,
      options.remote ?? "origin",
      (u) => mapProgress(onProgress, 2, 18, u.percent / 100, u.label),
      {
        token: options.authToken,
        provider: options.authProvider,
      },
    );
    fetchOk = fr.ok;
    if (!fr.ok) {
      fetchError = fr.stderr || fr.stdout || "fetch 失败";
    }
  }
  await reportProgress(onProgress, 20, "列举分支 tip…");

  const tips = await listTips(repoRoot);
  await reportProgress(onProgress, 26, `已找到 ${tips.length} 个 tip，枚举提交…`);

  let revListArgs: string[];

  if (options.into && options.from) {
    const intoSha = await ensureRev(repoRoot, options.into);
    const fromSha = await ensureRev(repoRoot, options.from);
    const base = await mergeBase(repoRoot, intoSha, fromSha);
    revListArgs = ["rev-list", "--parents"];
    if (!unlimited) {
      revListArgs.push(`--max-count=${maxNodes}`);
    }
    revListArgs.push(intoSha, fromSha, "^" + base + "^@");
  } else {
    const tipShas = tips.map((t) => t.sha);
    if (tipShas.length === 0) {
      await reportProgress(onProgress, 100, "完成");
      return {
        repoRoot,
        nodes: [],
        tips,
        edges: [],
        truncated: false,
        maxNodes: 0,
        fetched,
        fetchOk,
        fetchError,
      };
    }
    revListArgs = ["rev-list", "--parents"];
    if (!unlimited) {
      revListArgs.push(`--max-count=${maxNodes}`);
    }
    revListArgs.push(...tipShas);
  }

  const { stdout } = await withSoftProgress(
    onProgress,
    28,
    42,
    "枚举提交（rev-list，仓库大时较久）…",
    () => runGit(repoRoot, revListArgs),
  );
  await reportProgress(onProgress, 44, "解析提交图…");

  const parentMap = new Map<string, string[]>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const parts = line.trim().split(" ");
    const sha = parts[0];
    if (!sha) {
      continue;
    }
    parentMap.set(sha, parts.slice(1));
  }

  const shas = [...parentMap.keys()];
  const truncated = !unlimited && shas.length >= maxNodes;
  await reportProgress(onProgress, 45, `加载提交信息（0/${shas.length}）…`);

  const meta = await loadCommitMeta(
    repoRoot,
    shas,
    (done, total) =>
      mapProgress(
        onProgress,
        45,
        92,
        total === 0 ? 1 : done / total,
        `加载提交信息（${done}/${total}）…`,
      ),
    onProgress,
    45,
    92,
  );

  await reportProgress(onProgress, 94, "组装节点与边…");
  const nodes: CommitNode[] = [];
  const edges: Array<[string, string]> = [];

  for (const sha of shas) {
    const parents = parentMap.get(sha) ?? [];
    const base = meta.get(sha);
    nodes.push({
      sha,
      parents,
      message: base?.message ?? "",
      author: base?.author ?? "",
      time: base?.time ?? 0,
    });
    for (const parent of parents) {
      edges.push([sha, parent]);
    }
  }

  let lineage: BranchGraph["lineage"];
  if (options.into && options.from) {
    await reportProgress(onProgress, 96, "计算分支溯源…");
    lineage = await buildLineage(repoRoot, options.into, options.from);
  }

  await reportProgress(onProgress, 100, "完成");
  return {
    repoRoot,
    nodes,
    tips,
    edges,
    lineage,
    truncated,
    maxNodes: unlimited ? nodes.length : maxNodes,
    fetched,
    fetchOk,
    fetchError,
  };
}
