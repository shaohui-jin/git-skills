import { cssVar, currentTheme, type ThemeName } from "../theme";
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
      /** 完整 tip 名（含 remote 前缀），用于边与选中 */
      tipFullName?: string;
      remote?: boolean;
      remoteName?: string;
      /** 节点填充色（多 remote 时按名配色） */
      color?: string;
    };
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
  }>;
}

export interface TipsGraphOptions {
  /** 默认远程；仅与该 remote 同短名且同 sha 的本地 tip 会被合并隐藏 */
  defaultRemote?: string;
  /** 仓库 remote 名列表（用于拆 tip 前缀） */
  remotes?: string[];
}

/*
 * canvas 吃不到 CSS 变量，只能把 styles.css 的语义色读出来传给 G6，
 * 否则深浅主题一切换，画布就和外壳对不上了。按主题缓存，避免每个节点都跑 getComputedStyle。
 */
type GraphPalette = {
  local: string;
  remote: string;
  base: string;
  lineage: string;
  fallback: string;
  others: readonly string[];
};

/** 非默认 remote 的区分色，纯装饰、CSS 里没有对应语义，所以就地按主题给两套 */
const OTHER_REMOTES_DARK = [
  "#c678dd",
  "#56b6c2",
  "#e5c07b",
  "#98c379",
  "#e06c75",
  "#61afef",
] as const;
const OTHER_REMOTES_LIGHT = [
  "#8250df",
  "#0f7490",
  "#9a6700",
  "#3a7d34",
  "#c0392b",
  "#1f6feb",
] as const;

let paletteCache: { theme: ThemeName; value: GraphPalette } | null = null;

export function graphPalette(): GraphPalette {
  const theme = currentTheme();
  if (paletteCache?.theme === theme) {
    return paletteCache.value;
  }
  const value: GraphPalette = {
    local: cssVar("--mine", "#f0a35e"),
    remote: cssVar("--online", "#4c9aff"),
    base: cssVar("--base", "#9d8cff"),
    lineage: cssVar("--clean", "#56d364"),
    fallback: cssVar("--dim", "#5a5a5a"),
    others: theme === "light" ? OTHER_REMOTES_LIGHT : OTHER_REMOTES_DARK,
  };
  paletteCache = { theme, value };
  return value;
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

export function splitRemoteTipName(
  tipName: string,
  knownRemotes: string[],
): { remoteName: string; shortName: string } | null {
  const name = tipName.trim();
  if (!name.includes("/")) {
    return null;
  }
  const sorted = [...knownRemotes]
    .map((r) => r.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  for (const remote of sorted) {
    const prefix = `${remote}/`;
    if (name.startsWith(prefix) && name.length > prefix.length) {
      return { remoteName: remote, shortName: name.slice(prefix.length) };
    }
  }
  const i = name.indexOf("/");
  if (i <= 0 || i === name.length - 1) {
    return null;
  }
  return { remoteName: name.slice(0, i), shortName: name.slice(i + 1) };
}

function hashHue(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** 本地=我的橙；默认远程=线上蓝；其它 remote 走稳定调色板 */
export function colorForTip(opts: {
  remote: boolean;
  remoteName?: string;
  defaultRemote: string;
}): string {
  const p = graphPalette();
  if (!opts.remote) {
    return p.local;
  }
  const rn = opts.remoteName || "";
  if (!rn || rn === opts.defaultRemote) {
    return p.remote;
  }
  return p.others[hashHue(rn) % p.others.length]!;
}

export function kindColor(kind: G6NodeKind): string {
  const p = graphPalette();
  switch (kind) {
    case "base":
      return p.base;
    case "local-tip":
      return p.local;
    case "remote-tip":
      return p.remote;
    case "tip":
      return p.lineage;
    default:
      return p.fallback;
  }
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

function collectRemotesFromTips(tips: BranchTip[]): string[] {
  const set = new Set<string>();
  for (const t of tips) {
    if (!t.remote) {
      continue;
    }
    const i = t.name.indexOf("/");
    if (i > 0) {
      set.add(t.name.slice(0, i));
    }
  }
  return [...set];
}

function tipsToBranchGraph(
  graph: BranchGraph,
  options?: TipsGraphOptions,
): G6GraphData {
  const tips = graph.tips;
  if (tips.length === 0) {
    return { nodes: [], edges: [] };
  }

  const remotes =
    options?.remotes?.length ? options.remotes : collectRemotesFromTips(tips);
  const defaultRemote =
    options?.defaultRemote?.trim() ||
    (remotes.includes("origin") ? "origin" : remotes[0] || "origin");

  /** 本地 tip 名：与默认 remote 同短名且同 sha → 不单独成点 */
  const hiddenLocalNames = new Set<string>();
  for (const local of tips) {
    if (local.remote) {
      continue;
    }
    const pair = tips.find((t) => {
      if (!t.remote || t.sha !== local.sha) {
        return false;
      }
      const split = splitRemoteTipName(t.name, remotes);
      return split?.remoteName === defaultRemote && split.shortName === local.name;
    });
    if (pair) {
      hiddenLocalNames.add(local.name);
    }
  }

  const displayTips = tips.filter(
    (t) => t.remote || !hiddenLocalNames.has(t.name),
  );

  const parentMap = buildParentMap(graph.nodes);
  const tipShas = new Set(displayTips.map((t) => t.sha));
  const tipsBySha = new Map<string, BranchTip[]>();
  for (const t of displayTips) {
    const list = tipsBySha.get(t.sha) ?? [];
    list.push(t);
    tipsBySha.set(t.sha, list);
  }

  const nodes: G6GraphData["nodes"] = displayTips.map((t) => {
    const split = t.remote ? splitRemoteTipName(t.name, remotes) : null;
    const shortName = t.remote ? (split?.shortName ?? t.name) : t.name;
    const remoteName = t.remote ? split?.remoteName : undefined;
    const color = colorForTip({
      remote: t.remote,
      remoteName,
      defaultRemote,
    });
    return {
      id: tipNodeId(t.name),
      data: {
        label: shortName,
        sub: short(t.sha),
        kind: t.remote ? "remote-tip" : "local-tip",
        sha: t.sha,
        tipName: shortName,
        tipFullName: t.name,
        remote: t.remote,
        remoteName,
        color,
      },
    };
  });

  const edges: G6GraphData["edges"] = [];
  const edgeKeys = new Set<string>();
  let ei = 0;

  for (const child of displayTips) {
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
export function branchGraphToG6(
  graph: BranchGraph,
  options?: TipsGraphOptions,
): G6GraphData {
  if (graph.lineage) {
    const p = graphPalette();
    const nodes: G6GraphData["nodes"] = [
      {
        id: "base",
        data: {
          label: `分叉点 ${short(graph.lineage.mergeBase)}`,
          sub: "merge-base",
          kind: "base",
          sha: graph.lineage.mergeBase,
          color: p.base,
        },
      },
      {
        id: "into",
        data: {
          label: "线上（目标）",
          sub: `+${graph.lineage.intoOnlyCount} commits`,
          kind: "tip",
          color: p.remote,
        },
      },
      {
        id: "from",
        data: {
          label: "我的分支",
          sub: `+${graph.lineage.fromOnlyCount} commits`,
          kind: "tip",
          color: p.local,
        },
      },
    ];
    const edges: G6GraphData["edges"] = [
      { id: "e-base-into", source: "base", target: "into" },
      { id: "e-base-from", source: "base", target: "from" },
    ];
    return { nodes, edges };
  }

  return tipsToBranchGraph(graph, options);
}

/** 图例项：本地 + 各 remote */
export function legendItemsForGraph(
  graph: BranchGraph,
  options?: TipsGraphOptions,
): Array<{ key: string; label: string; color: string }> {
  const remotes =
    options?.remotes?.length
      ? options.remotes
      : collectRemotesFromTips(graph.tips);
  const defaultRemote =
    options?.defaultRemote?.trim() ||
    (remotes.includes("origin") ? "origin" : remotes[0] || "origin");
  const items: Array<{ key: string; label: string; color: string }> = [
    { key: "local", label: "本地", color: graphPalette().local },
  ];
  for (const r of remotes) {
    items.push({
      key: `remote:${r}`,
      label: r,
      color: colorForTip({
        remote: true,
        remoteName: r,
        defaultRemote,
      }),
    });
  }
  return items;
}
