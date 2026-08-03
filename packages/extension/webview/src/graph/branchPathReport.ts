import type { BranchGraph, BranchTip, CommitNode } from "../types";
import { tipNameFromNodeId } from "./toG6Data";

const MAX_COMMITS_PER_SEGMENT = 20;

function short(sha: string): string {
  return sha.slice(0, 7);
}

function formatTime(ts: number): string {
  if (!ts) {
    return "";
  }
  try {
    return new Date(ts * 1000).toLocaleString();
  } catch {
    return "";
  }
}

function nodeBySha(graph: BranchGraph): Map<string, CommitNode> {
  const map = new Map<string, CommitNode>();
  for (const n of graph.nodes) {
    map.set(n.sha, n);
  }
  return map;
}

function parentMap(graph: BranchGraph): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const n of graph.nodes) {
    map.set(n.sha, n.parents);
  }
  return map;
}

/**
 * Commit SHAs from child tip → ancestor tip (inclusive).
 * BFS over parent links; `cameFrom[parent] = childSide` for reconstruct.
 */
export function commitPathToAncestor(
  childSha: string,
  ancestorSha: string,
  parents: Map<string, string[]>,
): string[] | null {
  if (childSha === ancestorSha) {
    return [childSha];
  }
  const cameFrom = new Map<string, string>();
  const queue = [childSha];
  const seen = new Set<string>([childSha]);
  let found = false;

  while (queue.length > 0 && !found) {
    const cur = queue.shift()!;
    for (const p of parents.get(cur) ?? []) {
      if (seen.has(p)) {
        continue;
      }
      seen.add(p);
      cameFrom.set(p, cur);
      if (p === ancestorSha) {
        found = true;
        break;
      }
      queue.push(p);
    }
  }
  if (!found) {
    return null;
  }

  // ancestor → … → child, then reverse
  const rev: string[] = [ancestorSha];
  let cur = ancestorSha;
  while (cur !== childSha) {
    const next = cameFrom.get(cur);
    if (!next) {
      return null;
    }
    rev.push(next);
    cur = next;
    if (rev.length > 100_000) {
      return null;
    }
  }
  return rev.reverse();
}

function commitsBetweenTips(
  child: BranchTip,
  parent: BranchTip,
  graph: BranchGraph,
): CommitNode[] {
  const parents = parentMap(graph);
  const bySha = nodeBySha(graph);
  const path = commitPathToAncestor(child.sha, parent.sha, parents);
  if (!path || path.length < 2) {
    return [];
  }
  // exclude endpoints (both tip commits)
  const middle = path.slice(1, -1);
  return middle.map((sha) => bySha.get(sha)).filter((n): n is CommitNode => !!n);
}

function tipByName(graph: BranchGraph, name: string): BranchTip | undefined {
  return graph.tips.find((t) => t.name === name);
}

export function overviewReport(graph: BranchGraph): string {
  const local = graph.tips.filter((t) => !t.remote);
  const remote = graph.tips.filter((t) => t.remote);
  const lines: string[] = [
    `# 分支图总览`,
    ``,
    `- 仓库：\`${graph.repoRoot}\``,
    `- 分支 tip：本地 **${local.length}** / 远程 **${remote.length}**（共 ${graph.tips.length}）`,
    `- 画布：仅显示**分支节点**与最近祖先关系；中间提交不画在图上`,
    `- 操作：点击分支高亮到根源的链路，并在此显示链路详情；点击空白处恢复本总览`,
    ``,
  ];

  if (graph.truncated) {
    lines.push(`> 提交元数据已截断（上限 ${graph.maxNodes}），链路中间 commit 可能不完整。`, ``);
  }

  lines.push(`## 本地分支（${local.length}）`);
  for (const t of local) {
    lines.push(
      `- \`${t.name}\` → \`${short(t.sha)}\`${t.upstream ? `（跟踪 ${t.upstream}）` : ""}`,
    );
  }
  lines.push(``, `## 远程跟踪分支（${remote.length}）`);
  for (const t of remote) {
    lines.push(`- \`${t.name}\` → \`${short(t.sha)}\``);
  }

  lines.push(
    ``,
    `## 说明`,
    `- 琥珀：本地分支；蓝色：远程跟踪分支`,
    `- 边：子分支 tip 的**最近** tip 祖先 → 子分支（不是完整 commit 链）`,
    `- 同 commit 上的本地/远程 tip 会并列为两个节点`,
  );
  return lines.join("\n");
}

function lineagePathReport(graph: BranchGraph, selectedLabel: string): string {
  const L = graph.lineage!;
  const lines: string[] = [
    `# 双分支溯源`,
    ``,
    `- 选中：${selectedLabel}`,
    `- merge-base：\`${short(L.mergeBase)}\``,
    `- 线上目标独有提交：${L.intoOnlyCount}`,
    `- 我的分支独有提交：${L.fromOnlyCount}`,
  ];
  if (L.branchedFrom) {
    const b = L.branchedFrom;
    const when = formatTime(b.time);
    lines.push(
      `- 我的分支侧首个独有提交：\`${short(b.sha)}\` ${b.author}${when ? ` · ${when}` : ""} — ${b.message}`,
    );
  }
  lines.push(
    ``,
    `> 此为「线上目标 / 我的分支」聚焦视图；完整仓库分支图请用不带双分支的加载方式。`,
  );
  return lines.join("\n");
}

/**
 * @param chainNodeIds G6 node ids from selected tip back to root (tip:xxx …)
 * @param selectedLabel fallback label when id 不是 tip: 前缀（如 lineage 图）
 */
export function pathReport(
  graph: BranchGraph,
  chainNodeIds: string[],
  selectedLabel?: string,
): string {
  if (graph.lineage) {
    return lineagePathReport(graph, selectedLabel || "（节点）");
  }

  const tipNames = chainNodeIds
    .map((id) => tipNameFromNodeId(id))
    .filter((n): n is string => !!n);

  if (tipNames.length === 0) {
    return overviewReport(graph);
  }

  const selected = tipNames[0]!;
  const selectedTip = tipByName(graph, selected);
  const lines: string[] = [
    `# 分支链路`,
    ``,
    `- 选中：\`${selected}\`${selectedTip ? ` @ \`${short(selectedTip.sha)}\`` : ""}`,
    `- 链路（选中 → 根源）：${tipNames.map((n) => `\`${n}\``).join(" → ")}`,
    `- 途经分支节点：**${tipNames.length}**`,
    ``,
  ];

  if (selectedTip) {
    lines.push(`## 选中分支`);
    lines.push(`- 名称：\`${selectedTip.name}\``);
    lines.push(`- 类型：${selectedTip.remote ? "远程跟踪" : "本地"}`);
    lines.push(`- Tip：\`${selectedTip.sha}\``);
    if (selectedTip.upstream) {
      lines.push(`- 上游：\`${selectedTip.upstream}\``);
    }
    const tipCommit = nodeBySha(graph).get(selectedTip.sha);
    if (tipCommit) {
      const tipMsg = tipCommit.message?.trim() || "（无提交说明）";
      const tipAuthor = tipCommit.author?.trim() || "未知作者";
      lines.push(`- Tip 提交：${tipAuthor} — ${tipMsg}`);
      const when = formatTime(tipCommit.time);
      if (when) {
        lines.push(`- 时间：${when}`);
      }
    } else {
      lines.push(`- Tip 提交元数据未加载（可重新加载分支图）`);
    }
    lines.push(``);
  }

  lines.push(`## 分段详情（相邻分支 tip 之间）`);
  if (tipNames.length === 1) {
    lines.push(`- 已是图上的根源分支（无更近的 tip 祖先）。`);
    return lines.join("\n");
  }

  // chain is selected → … → root; segments between consecutive tips
  for (let i = 0; i < tipNames.length - 1; i++) {
    const childName = tipNames[i]!;
    const parentName = tipNames[i + 1]!;
    const child = tipByName(graph, childName);
    const parent = tipByName(graph, parentName);
    lines.push(``, `### \`${childName}\` ← \`${parentName}\``);
    if (!child || !parent) {
      lines.push(`- （缺少 tip 元数据）`);
      continue;
    }
    lines.push(`- 子 tip \`${short(child.sha)}\` ← 父 tip \`${short(parent.sha)}\``);

    const middle = commitsBetweenTips(child, parent, graph);
    if (middle.length === 0) {
      lines.push(`- 两 tip 之间无额外提交（或提交元数据未加载）。`);
      continue;
    }

    const shown = middle.slice(0, MAX_COMMITS_PER_SEGMENT);
    const omitted = middle.length - shown.length;
    lines.push(`- 中间提交 **${middle.length}** 个${omitted > 0 ? `（显示前 ${shown.length}）` : ""}：`);
    for (const c of shown) {
      const when = formatTime(c.time);
      const author = c.author?.trim() || "未知作者";
      const msg = c.message?.trim();
      const detail = msg
        ? msg
        : author === "未知作者" && !when
          ? "（提交元数据缺失）"
          : "（无提交说明）";
      lines.push(
        `  - \`${short(c.sha)}\` ${author}${when ? ` · ${when}` : ""} — ${detail}`,
      );
    }
    if (omitted > 0) {
      lines.push(`  - … 另有 ${omitted} 个提交未列出`);
    }
  }

  return lines.join("\n");
}
