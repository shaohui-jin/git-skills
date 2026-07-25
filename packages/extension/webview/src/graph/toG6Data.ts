import type { BranchGraph, BranchTip, CommitNode } from "../types";

export type G6NodeKind = "base" | "tip" | "local-tip" | "remote-tip";

export interface G6GraphData {
  nodes: Array<{
    id: string;
    data: {
      label: string;
      sub?: string;
      kind: G6NodeKind;
      sha?: string;
      tipName?: string;
      remote?: boolean;
    };
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
  }>;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

/** Stable G6 node id for a tip name (names may contain `/`). */
export function tipNodeId(name: string): string {
  return `tip:${name}`;
}

export function tipNameFromNodeId(id: string): string | null {
  return id.startsWith("tip:") ? id.slice(4) : null;
}

function buildParentMap(nodes: CommitNode[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const n of nodes) {
    map.set(n.sha, n.parents);
  }
  return map;
}

/**
 * Nearest ancestor commit SHAs that are also branch tips (excluding startSha).
 * Layer-BFS so we get immediate tip parents, not all ancestors.
 */
export function nearestAncestorTipShas(
  startSha: string,
  tipShas: Set<string>,
  parentMap: Map<string, string[]>,
): string[] {
  const visited = new Set<string>([startSha]);
  let frontier = [...(parentMap.get(startSha) ?? [])].filter((p) => !visited.has(p));
  while (frontier.length > 0) {
    const found: string[] = [];
    const next: string[] = [];
    for (const sha of frontier) {
      if (visited.has(sha)) {
        continue;
      }
      visited.add(sha);
      if (tipShas.has(sha)) {
        found.push(sha);
        continue;
      }
      for (const p of parentMap.get(sha) ?? []) {
        if (!visited.has(p)) {
          next.push(p);
        }
      }
    }
    if (found.length > 0) {
      return [...new Set(found)];
    }
    frontier = next;
  }
  return [];
}

function tipsToBranchGraph(graph: BranchGraph): G6GraphData {
  const tips = graph.tips;
  if (tips.length === 0) {
    return { nodes: [], edges: [] };
  }

  const parentMap = buildParentMap(graph.nodes);
  const tipShas = new Set(tips.map((t) => t.sha));
  const tipsBySha = new Map<string, BranchTip[]>();
  for (const t of tips) {
    const list = tipsBySha.get(t.sha) ?? [];
    list.push(t);
    tipsBySha.set(t.sha, list);
  }

  const nodes: G6GraphData["nodes"] = tips.map((t) => ({
    id: tipNodeId(t.name),
    data: {
      label: t.name,
      sub: short(t.sha),
      kind: t.remote ? "remote-tip" : "local-tip",
      sha: t.sha,
      tipName: t.name,
      remote: t.remote,
    },
  }));

  const edges: G6GraphData["edges"] = [];
  const edgeKeys = new Set<string>();
  let ei = 0;

  for (const child of tips) {
    const ancestorShas = nearestAncestorTipShas(child.sha, tipShas, parentMap);
    for (const aSha of ancestorShas) {
      const parents = tipsBySha.get(aSha) ?? [];
      for (const parent of parents) {
        if (parent.name === child.name) {
          continue;
        }
        const key = `${parent.name}\0${child.name}`;
        if (edgeKeys.has(key)) {
          continue;
        }
        edgeKeys.add(key);
        edges.push({
          id: `e-${ei++}`,
          source: tipNodeId(parent.name),
          target: tipNodeId(child.name),
        });
      }
    }
  }

  return { nodes, edges };
}

/**
 * Map core BranchGraph → G6：画布只含分支 tip（本地/远程），边表示最近 tip 祖先关系。
 * 中间 commit 不画节点，详情留给右侧报告。
 */
export function branchGraphToG6(graph: BranchGraph): G6GraphData {
  if (graph.lineage) {
    const nodes: G6GraphData["nodes"] = [
      {
        id: "base",
        data: {
          label: `分叉点 ${short(graph.lineage.mergeBase)}`,
          sub: "merge-base",
          kind: "base",
          sha: graph.lineage.mergeBase,
        },
      },
      {
        id: "into",
        data: {
          label: "目标分支",
          sub: `+${graph.lineage.intoOnlyCount} commits`,
          kind: "tip",
        },
      },
      {
        id: "from",
        data: {
          label: "待合并分支",
          sub: `+${graph.lineage.fromOnlyCount} commits`,
          kind: "tip",
        },
      },
    ];
    const edges: G6GraphData["edges"] = [
      { id: "e-base-into", source: "base", target: "into" },
      { id: "e-base-from", source: "base", target: "from" },
    ];
    return { nodes, edges };
  }

  return tipsToBranchGraph(graph);
}

export function kindColor(kind: G6NodeKind): string {
  switch (kind) {
    case "base":
      return "#0e639c";
    case "local-tip":
      return "#3d8b40";
    case "remote-tip":
      return "#2d6a9f";
    case "tip":
      return "#3d8b40";
    default:
      return "#5a5a5a";
  }
}
