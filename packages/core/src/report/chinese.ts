import type {
  BranchGraph,
  ConflictBlameResult,
  FetchResult,
  MergePreviewResult,
} from "../types.js";

function short(sha: string): string {
  return sha.slice(0, 7);
}

export function reportGraph(graph: BranchGraph): string {
  const lines: string[] = [
    `# 分支图`,
    ``,
    `- 仓库：${graph.repoRoot}`,
    `- 分支 tip 数：${graph.tips.length}`,
    `- 分支 tip：${graph.tips.length}（可视化画布仅展示 tip 链路；提交元数据 ${graph.nodes.length} 条${graph.truncated ? `，已截断上限 ${graph.maxNodes}` : ""}）`,
  ];
  if (graph.fetched) {
    lines.push(
      `- 本次 fetch：${graph.fetchOk ? "成功" : `失败（数据可能落后于线上）${graph.fetchError ? `：${graph.fetchError}` : ""}`}`,
    );
  } else {
    lines.push(`- 本次 fetch：已跳过`);
  }

  if (graph.lineage) {
    lines.push(``, `## 溯源（相对两分支）`);
    lines.push(`- merge-base：\`${short(graph.lineage.mergeBase)}\``);
    lines.push(`- 目标分支独有提交：${graph.lineage.intoOnlyCount}`);
    lines.push(`- 待合并分支独有提交：${graph.lineage.fromOnlyCount}`);
    if (graph.lineage.branchedFrom) {
      const b = graph.lineage.branchedFrom;
      lines.push(
        `- 待合并侧首个独有提交：\`${short(b.sha)}\` ${b.author} — ${b.message}`,
      );
    }
  }

  const localTips = graph.tips.filter((t) => !t.remote);
  const remoteTips = graph.tips.filter((t) => t.remote);
  lines.push(``, `## 本地分支（${localTips.length}）`);
  for (const t of localTips) {
    lines.push(`- \`${t.name}\` → \`${short(t.sha)}\`${t.upstream ? ` (↑ ${t.upstream})` : ""}`);
  }
  lines.push(``, `## 远程跟踪分支（${remoteTips.length}）`);
  for (const t of remoteTips) {
    lines.push(`- \`${t.name}\` → \`${short(t.sha)}\``);
  }
  return lines.join("\n");
}

function appendConflictDetails(lines: string[], result: ConflictBlameResult): void {
  lines.push(``, `## 冲突详情`);
  for (const f of result.conflictFiles) {
    lines.push(``, `### \`${f.path}\``);

    const hunks = f.hunks.length > 0 ? f.hunks : result.blamed.filter((h) => h.path === f.path);
    if (hunks.length > 0) {
      lines.push(`#### 来源溯源`);
      for (const hunk of hunks) {
        lines.push(`- 目标侧行 ${hunk.oursRange[0]}-${hunk.oursRange[1]}：`);
        for (const c of hunk.oursCommits) {
          lines.push(
            `  - \`${short(c.sha)}\` ${c.author}${c.pr ? ` ${c.pr}` : ""}${c.message ? ` — ${c.message}` : ""}`,
          );
        }
        lines.push(`- 待合并侧行 ${hunk.theirsRange[0]}-${hunk.theirsRange[1]}：`);
        for (const c of hunk.theirsCommits) {
          lines.push(
            `  - \`${short(c.sha)}\` ${c.author}${c.pr ? ` ${c.pr}` : ""}${c.message ? ` — ${c.message}` : ""}`,
          );
        }
      }
    } else {
      lines.push(`- （未能解析 blame 区间，可能为增删冲突）`);
    }

    if (f.conflictContent) {
      lines.push(``, `#### 冲突内容`);
      lines.push("```diff");
      lines.push(f.conflictContent.replace(/\r\n/g, "\n").trimEnd());
      lines.push("```");
    } else {
      lines.push(``, `#### 冲突内容`);
      lines.push(`- （未能生成冲突标记文本）`);
      if (f.oursContent != null || f.theirsContent != null) {
        lines.push(``, `<details><summary>目标侧原文</summary>`, ``, "```");
        lines.push((f.oursContent ?? "（无）").slice(0, 8000));
        lines.push("```", `</details>`);
        lines.push(``, `<details><summary>待合并侧原文</summary>`, ``, "```");
        lines.push((f.theirsContent ?? "（无）").slice(0, 8000));
        lines.push("```", `</details>`);
      }
    }
  }
}

function outcomeLabel(result: ConflictBlameResult): string {
  if (result.outcome === "unrelated" || result.unrelatedHistories) {
    return "**无关历史（无共同祖先）**";
  }
  if (result.clean) {
    return "**可干净合并**";
  }
  return `**存在冲突（${result.conflictFiles.length} 个文件）**`;
}

/** 合并预演完整报告（干净 / 冲突 / 无关历史 + 冲突正文 + 溯源） */
export function reportMergeRehearsal(result: ConflictBlameResult): string {
  const lines: string[] = [
    `# 合并预演`,
    ``,
    `- 仓库：${result.repoRoot}`,
    `- 目标分支 (--into)：\`${result.into}\` @ \`${short(result.intoSha)}\``,
    `- 待合并分支 (--from)：\`${result.from}\` @ \`${short(result.fromSha)}\``,
    `- merge-base：${result.mergeBase ? `\`${short(result.mergeBase)}\`` : "（无共同祖先，无法计算）"}`,
    `- 本次是否 fetch：${result.fetched ? "是" : "否"}`,
    `- 结果：${outcomeLabel(result)}`,
  ];

  if (result.unrelatedHistories || result.outcome === "unrelated") {
    lines.push(``, `## 说明`);
    lines.push(
      `两条分支没有共同祖先（git merge-base 失败）。常见原因：仓库曾替换过历史、或分支来自不同根提交。`,
    );
    lines.push(`已尝试按「无关历史」继续预演；若下方仍无冲突文件列表，请人工确认是否应使用 \`git merge --allow-unrelated-histories\`。`);
    if (result.messages.length > 0) {
      lines.push(``, `## 引擎消息`);
      for (const m of result.messages.slice(0, 30)) {
        lines.push(`- ${m}`);
      }
    }
    if (result.conflictFiles.length === 0) {
      return lines.join("\n");
    }
  }

  if (result.clean) {
    lines.push(``, `无冲突，可以将 \`${result.from}\` 合入 \`${result.into}\`。`);
    return lines.join("\n");
  }

  lines.push(``, `## 冲突文件列表`);
  for (const f of result.conflictFiles) {
    lines.push(`- \`${f.path}\``);
  }
  appendConflictDetails(lines, result);
  return lines.join("\n");
}

/** @deprecated 使用 reportMergeRehearsal；保留给仅 preview 的轻量结果 */
export function reportMerge(result: MergePreviewResult): string {
  if ("blamed" in result) {
    return reportMergeRehearsal(result as ConflictBlameResult);
  }
  const lines: string[] = [
    `# 合并预演`,
    ``,
    `- 仓库：${result.repoRoot}`,
    `- 目标分支 (--into)：\`${result.into}\` @ \`${short(result.intoSha)}\``,
    `- 待合并分支 (--from)：\`${result.from}\` @ \`${short(result.fromSha)}\``,
    `- merge-base：\`${short(result.mergeBase)}\``,
    `- 本次是否 fetch：${result.fetched ? "是" : "否"}`,
    `- 结果：${result.clean ? "**可干净合并**" : `**存在冲突（${result.conflictFiles.length} 个文件）**`}`,
  ];
  if (!result.clean) {
    lines.push(``, `## 冲突文件列表`);
    for (const f of result.conflictFiles) {
      lines.push(`- \`${f.path}\``);
      if (f.conflictContent) {
        lines.push(``, "```diff", f.conflictContent.trimEnd(), "```");
      }
    }
  }
  return lines.join("\n");
}

export function reportBlame(result: ConflictBlameResult): string {
  return reportMergeRehearsal(result);
}

export function reportFetch(result: FetchResult): string {
  return [
    `# Fetch`,
    ``,
    `- 仓库：${result.repoRoot}`,
    `- remote：${result.remote}`,
    `- 结果：${result.ok ? "成功" : "失败（将继续使用本地已有 refs）"}`,
    result.stderr ? `- 信息：${result.stderr}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
