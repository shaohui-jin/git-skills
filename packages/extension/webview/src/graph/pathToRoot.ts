import type { G6GraphData } from "./toG6Data";

export interface PathHighlight {
  nodeIds: Set<string>;
  edgeIds: Set<string>;
  /** 从当前节点沿父链到根（展示用，取一条主链：优先第一父） */
  chain: string[];
}

/**
 * G6 边为 parent → child；回溯时走 child → parents。
 * 高亮集合：当前节点的全部祖先 + 连边；主链用于底部文案（第一父优先）。
 */
export function pathToRoots(startId: string, data: G6GraphData): PathHighlight {
  const parentsOf = new Map<string, string[]>();
  const edgeIdByPair = new Map<string, string>();

  for (const e of data.edges) {
    const list = parentsOf.get(e.target) ?? [];
    list.push(e.source);
    parentsOf.set(e.target, list);
    edgeIdByPair.set(`${e.source}\0${e.target}`, e.id);
  }

  const nodeIds = new Set<string>([startId]);
  const edgeIds = new Set<string>();
  const queue = [startId];

  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const parent of parentsOf.get(cur) ?? []) {
      const eid = edgeIdByPair.get(`${parent}\0${cur}`);
      if (eid) {
        edgeIds.add(eid);
      }
      if (!nodeIds.has(parent)) {
        nodeIds.add(parent);
        queue.push(parent);
      }
    }
  }

  // 主链：沿第一父走到根，便于文案「当前 ← … ← 根源」
  const chain: string[] = [startId];
  let walk = startId;
  const seen = new Set<string>([startId]);
  for (;;) {
    const parents = parentsOf.get(walk) ?? [];
    const next = parents[0];
    if (!next || seen.has(next)) {
      break;
    }
    seen.add(next);
    chain.push(next);
    walk = next;
  }

  return { nodeIds, edgeIds, chain };
}
