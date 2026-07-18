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
 * Keep this the single adapter so future features (conflict highlight, PR badges)
 * only extend `data` fields here.
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
    const edges: G6GraphData["edges"] = [
      { id: "e-into-base", source: "into", target: "base" },
      { id: "e-from-base", source: "from", target: "base" },
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
      edges.push({ id: "e-from-first", source: "from", target: "first" });
    }
    return { nodes, edges };
  }

  const tips = graph.tips.slice(0, 40);
  const tipSha = new Set(tips.map((t) => t.sha));
  const nameBySha = new Map<string, string[]>();
  for (const t of tips) {
    const list = nameBySha.get(t.sha) ?? [];
    list.push(t.name);
    nameBySha.set(t.sha, list);
  }

  let pool = graph.nodes.filter((n) => tipSha.has(n.sha));
  if (pool.length === 0) {
    pool = [...graph.nodes].sort((a, b) => b.time - a.time).slice(0, 48);
  } else {
    // include some parents for context
    const extra = new Set(pool.map((n) => n.sha));
    for (const n of pool) {
      for (const p of n.parents.slice(0, 2)) {
        extra.add(p);
      }
    }
    const bySha = new Map(graph.nodes.map((n) => [n.sha, n]));
    pool = [...extra]
      .map((sha) => bySha.get(sha))
      .filter((n): n is NonNullable<typeof n> => !!n)
      .slice(0, 80);
  }

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

  const edges: G6GraphData["edges"] = [];
  let ei = 0;
  for (const [child, parent] of graph.edges) {
    if (!idSet.has(child) || !idSet.has(parent)) {
      continue;
    }
    edges.push({
      id: `e-${ei++}-${child.slice(0, 7)}-${parent.slice(0, 7)}`,
      source: child,
      target: parent,
    });
    if (edges.length >= 120) {
      break;
    }
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
