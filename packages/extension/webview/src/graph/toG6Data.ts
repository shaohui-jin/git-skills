import type { BranchGraph } from "../types";

export type G6NodeKind = "base" | "tip" | "commit" | "branch-tip";

export interface G6GraphData {
  nodes: Array<{
    id: string;
    data: {
      label: string;
      sub?: string;
      kind: G6NodeKind;
      sha?: string;
      tipName?: string;
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

/**
 * Map core BranchGraph JSON → AntV G6 data.
 * 边方向：父 → 子（旧 → 新），配合 dagre LR 时左侧为源头、右侧为分支 tip。
 */
export function branchGraphToG6(graph: BranchGraph): G6GraphData {
  if (graph.lineage) {
    const nodes: G6GraphData["nodes"] = [
      {
        id: "base",
        data: {
          label: `base ${short(graph.lineage.mergeBase)}`,
          kind: "base",
          sha: graph.lineage.mergeBase,
        },
      },
      {
        id: "into",
        data: {
          label: `目标 +${graph.lineage.intoOnlyCount}`,
          kind: "tip",
        },
      },
      {
        id: "from",
        data: {
          label: `待合并 +${graph.lineage.fromOnlyCount}`,
          kind: "tip",
        },
      },
    ];
    // 左：merge-base → 右：两分支 tip
    const edges: G6GraphData["edges"] = [
      { id: "e-base-into", source: "base", target: "into" },
    ];
    if (graph.lineage.branchedFrom) {
      const b = graph.lineage.branchedFrom;
      nodes.push({
        id: "first",
        data: {
          label: short(b.sha),
          sub: b.author,
          kind: "commit",
          sha: b.sha,
        },
      });
      edges.push(
        { id: "e-base-first", source: "base", target: "first" },
        { id: "e-first-from", source: "first", target: "from" },
      );
    } else {
      edges.push({ id: "e-base-from", source: "base", target: "from" });
    }
    return { nodes, edges };
  }

  const nameBySha = new Map<string, string[]>();
  for (const t of graph.tips) {
    const list = nameBySha.get(t.sha) ?? [];
    list.push(t.name);
    nameBySha.set(t.sha, list);
  }

  // 全量节点（与加载全量分支图一致）
  const pool = graph.nodes;
  const idSet = new Set(pool.map((n) => n.sha));
  const nodes: G6GraphData["nodes"] = pool.map((n) => {
    const tipNames = nameBySha.get(n.sha);
    return {
      id: n.sha,
      data: {
        label: tipNames?.[0] ?? short(n.sha),
        sub: tipNames ? short(n.sha) : n.message.slice(0, 24),
        kind: tipNames ? "branch-tip" : "commit",
        sha: n.sha,
        tipName: tipNames?.join(", "),
      },
    };
  });

  // core.edges 为 [child, parent]；G6 用 parent → child，LR 时左旧右新
  const edges: G6GraphData["edges"] = [];
  let ei = 0;
  for (const [child, parent] of graph.edges) {
    if (!idSet.has(child) || !idSet.has(parent)) {
      continue;
    }
    edges.push({
      id: `e-${ei++}-${parent.slice(0, 7)}-${child.slice(0, 7)}`,
      source: parent,
      target: child,
    });
  }

  return { nodes, edges };
}

export function kindColor(kind: G6NodeKind): string {
  switch (kind) {
    case "base":
      return "#0e639c";
    case "tip":
    case "branch-tip":
      return "#3d8b40";
    default:
      return "#5a5a5a";
  }
}
