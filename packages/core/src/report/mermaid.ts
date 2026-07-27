import type { BranchGraph, MergePreviewResult } from "../types.js";

function short(sha: string): string {
  return sha.slice(0, 7);
}

function safeId(sha: string): string {
  return `c_${sha.slice(0, 7)}`;
}

/**
 * Compact flowchart for Skill / docs. Not a full gitGraph (branch rails),
 * but enough to show tip → merge-base relationships.
 */
export function graphToMermaid(graph: BranchGraph): string {
  const lines: string[] = ["flowchart LR"];

  if (graph.lineage) {
    const base = short(graph.lineage.mergeBase);
    lines.push(`  base["merge-base ${base}"]`);
    if (graph.lineage.branchedFrom) {
      const b = graph.lineage.branchedFrom;
      lines.push(`  first["首独有 ${short(b.sha)}<br/>${escapeLabel(b.message)}"]`);
      lines.push("  base --> first");
    }
    lines.push(`  intoOnly["线上独有 ${graph.lineage.intoOnlyCount} commits"]`);
    lines.push(`  fromOnly["我的独有 ${graph.lineage.fromOnlyCount} commits"]`);
    lines.push("  base --> intoOnly");
    lines.push("  base --> fromOnly");
    return lines.join("\n");
  }

  const tipBySha = new Map(graph.tips.map((t) => [t.sha, t.name]));
  const shown = graph.nodes.slice(0, 40);
  for (const node of shown) {
    const tip = tipBySha.get(node.sha);
    const label = tip
      ? `${tip}<br/>${short(node.sha)}`
      : `${short(node.sha)}<br/>${escapeLabel(node.message)}`;
    lines.push(`  ${safeId(node.sha)}["${label}"]`);
  }
  for (const [child, parent] of graph.edges) {
    if (shown.some((n) => n.sha === child) && shown.some((n) => n.sha === parent)) {
      lines.push(`  ${safeId(child)} --> ${safeId(parent)}`);
    }
  }
  if (graph.truncated) {
    lines.push(`  note["已截断至 ${graph.maxNodes} 节点"]`);
  }
  return lines.join("\n");
}

export function mergeToMermaid(result: MergePreviewResult): string {
  const baseLabel = result.mergeBase
    ? `merge-base<br/>${short(result.mergeBase)}`
    : "无共同祖先";
  const lines = [
    "flowchart TB",
    `  into["into: ${escapeLabel(result.into)}<br/>${short(result.intoSha)}"]`,
    `  from["from: ${escapeLabel(result.from)}<br/>${short(result.fromSha)}"]`,
    `  base["${baseLabel}"]`,
    "  into --> base",
    "  from --> base",
  ];
  if (result.unrelatedHistories || result.outcome === "unrelated") {
    lines.push('  result["无关历史"]');
    lines.push("  base --> result");
  } else if (result.clean) {
    lines.push('  result["可干净合并"]');
    lines.push("  base --> result");
  } else {
    lines.push(`  result["冲突 ${result.conflictFiles.length} 个文件"]`);
    lines.push("  base --> result");
    for (const f of result.conflictFiles.slice(0, 12)) {
      const id = `f_${hashPath(f.path)}`;
      lines.push(`  ${id}["${escapeLabel(f.path)}"]`);
      lines.push(`  result --> ${id}`);
    }
  }
  return lines.join("\n");
}

function escapeLabel(text: string): string {
  return text.replace(/["[\]]/g, "").slice(0, 48);
}

function hashPath(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) {
    h = (h * 31 + path.charCodeAt(i)) >>> 0;
  }
  return h.toString(16);
}
