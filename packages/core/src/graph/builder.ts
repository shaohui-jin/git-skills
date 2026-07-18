import { maybeFetch } from "../git/fetch.js";
import {
  ensureRev,
  mergeBase,
  resolveRepoRoot,
  runGit,
} from "../git/runner.js";
import type { BranchGraph, BranchTip, CommitNode, GraphOptions } from "../types.js";

const DEFAULT_MAX_NODES = 200;

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

async function loadCommitMeta(
  repoRoot: string,
  shas: string[],
): Promise<Map<string, CommitNode>> {
  const map = new Map<string, CommitNode>();
  if (shas.length === 0) {
    return map;
  }
  const { stdout } = await runGit(repoRoot, [
    "show",
    "-s",
    "--format=%H%00%P%00%an%00%at%00%s",
    ...shas,
  ]);
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
 * Build a commit DAG. With no into/from, uses all branch tips (capped).
 * With into/from, focuses on the symmetric difference around merge-base.
 */
export async function buildBranchGraph(options: GraphOptions = {}): Promise<BranchGraph> {
  const repoRoot = await resolveRepoRoot(options.cwd);
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const shouldFetch = options.fetch !== false;
  await maybeFetch(repoRoot, shouldFetch, options.remote ?? "origin");

  const tips = await listTips(repoRoot);
  let revListArgs: string[];

  if (options.into && options.from) {
    const intoSha = await ensureRev(repoRoot, options.into);
    const fromSha = await ensureRev(repoRoot, options.from);
    const base = await mergeBase(repoRoot, intoSha, fromSha);
    revListArgs = [
      "rev-list",
      "--parents",
      `--max-count=${maxNodes}`,
      intoSha,
      fromSha,
      "^" + base + "^@",
    ];
  } else {
    const tipShas = tips.map((t) => t.sha);
    if (tipShas.length === 0) {
      return {
        repoRoot,
        nodes: [],
        tips,
        edges: [],
        truncated: false,
        maxNodes,
      };
    }
    revListArgs = ["rev-list", "--parents", `--max-count=${maxNodes}`, ...tipShas];
  }

  const { stdout } = await runGit(repoRoot, revListArgs);
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
  const truncated = shas.length >= maxNodes;
  const meta = await loadCommitMeta(repoRoot, shas);
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
    lineage = await buildLineage(repoRoot, options.into, options.from);
  }

  return {
    repoRoot,
    nodes,
    tips,
    edges,
    lineage,
    truncated,
    maxNodes,
  };
}
