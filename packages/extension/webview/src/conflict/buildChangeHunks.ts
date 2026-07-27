import { diffArrays } from "diff";
import { parseConflictContent, type ConflictSegment } from "./parseConflict";

/** WebStorm 风格变更分类 */
export type HunkKind =
  | "equal"
  | "add-left"
  | "add-right"
  | "modify-left"
  | "modify-right"
  | "conflict";

/**
 * auto: 非冲突，默认已纳入结果
 * pending: 冲突未解决
 * accept-left / accept-right: 用户选边
 * ignore-left / ignore-right: 忽略该侧
 */
export type HunkAction =
  | "auto"
  | "pending"
  | "accept-left"
  | "accept-right"
  | "ignore-left"
  | "ignore-right"
  /** AI / 自定义合并正文 */
  | "custom";

export interface ChangeHunk {
  id: string;
  kind: HunkKind;
  leftLines: string[];
  rightLines: string[];
  baseLines: string[];
  action: HunkAction;
  /** action === custom 时写入 Result 的行 */
  customLines?: string[];
  /** AI 选边说明 */
  aiReason?: string;
}

/** 相对 base 的一段变更（含纯插入：start===end） */
interface SideRegion {
  start: number;
  end: number;
  lines: string[];
}

function splitLines(text: string | null | undefined): string[] {
  if (text == null || text === "") {
    return [];
  }
  return text.replace(/\r\n/g, "\n").split("\n");
}

function join(lines: string[]): string {
  return lines.join("\n");
}

/**
 * 将 base→side 的 diff 转为 base 坐标上的变更区间。
 * equal 段不产出 region；insert 为 [i,i)；modify/delete 为 [i,j)。
 */
function collectRegions(base: string[], side: string[]): SideRegion[] {
  const parts = diffArrays(base, side);
  const regions: SideRegion[] = [];
  let baseIdx = 0;
  let i = 0;
  while (i < parts.length) {
    const part = parts[i]!;
    if (!part.added && !part.removed) {
      baseIdx += part.value.length;
      i += 1;
      continue;
    }
    const removed: string[] = [];
    const added: string[] = [];
    const start = baseIdx;
    while (i < parts.length && (parts[i]!.added || parts[i]!.removed)) {
      const p = parts[i]!;
      if (p.removed) {
        removed.push(...p.value);
        baseIdx += p.value.length;
      } else if (p.added) {
        added.push(...p.value);
      }
      i += 1;
    }
    regions.push({ start, end: start + removed.length, lines: added });
  }
  return regions;
}

function findInsertsAt(regions: SideRegion[], at: number): SideRegion[] {
  return regions.filter((r) => r.start === r.end && r.start === at);
}

/**
 * 两侧都有内容且不同 → conflict（红，需手选）。
 * 仅一侧有内容 → add（绿）。
 * 两侧相同 → modify/add（蓝/绿）并 auto。
 *
 * 说明：合并预演对照的是两个分支 tip。左 15 / 右 18 即使
 * 「相对 base 只有右侧改过」，对用户仍是两边不一致，应标红而非蓝。
 */
function classifyBothSides(
  leftLines: string[],
  rightLines: string[],
  baseLines: string[],
): Omit<ChangeHunk, "id"> {
  const l = join(leftLines);
  const r = join(rightLines);
  if (l === r) {
    return {
      kind: baseLines.length === 0 ? "add-left" : "modify-left",
      leftLines,
      rightLines,
      baseLines,
      action: "auto",
    };
  }
  if (leftLines.length === 0 && rightLines.length > 0) {
    return {
      kind: "add-right",
      leftLines,
      rightLines,
      baseLines,
      action: "auto",
    };
  }
  if (rightLines.length === 0 && leftLines.length > 0) {
    return {
      kind: "add-left",
      leftLines,
      rightLines,
      baseLines,
      action: "auto",
    };
  }
  return {
    kind: "conflict",
    leftLines,
    rightLines,
    baseLines,
    action: "pending",
  };
}

/**
 * 按 base 坐标扫掠合并左右变更，保证：
 * - 单侧新增/修改各自成块（绿/蓝），且 auto 写入 Result
 * - 重叠且内容不同 → conflict（红）
 * - 绝不会把「右侧独有行」吞进空洞
 */
export function buildChangeHunksFromSides(
  baseText: string | null | undefined,
  oursText: string | null | undefined,
  theirsText: string | null | undefined,
): ChangeHunk[] {
  const base = splitLines(baseText ?? "");
  const ours = splitLines(oursText ?? "");
  const theirs = splitLines(theirsText ?? "");

  if (base.length === 0) {
    if (join(ours) === join(theirs)) {
      return [
        {
          id: "h-0",
          kind: "equal",
          leftLines: ours,
          rightLines: theirs,
          baseLines: [],
          action: "auto",
        },
      ];
    }
    return buildTwoWayHunks(ours, theirs);
  }

  const leftRegions = collectRegions(base, ours);
  const rightRegions = collectRegions(base, theirs);

  const points = new Set<number>([0, base.length]);
  for (const r of leftRegions) {
    points.add(r.start);
    points.add(r.end);
  }
  for (const r of rightRegions) {
    points.add(r.start);
    points.add(r.end);
  }
  const sorted = [...points].sort((a, b) => a - b);

  const hunks: ChangeHunk[] = [];
  let id = 0;
  const push = (h: Omit<ChangeHunk, "id">) => {
    hunks.push({ ...h, id: `h-${id++}` });
  };

  /** 已输出的变更 region（避免大切片重复输出） */
  const emittedLeft = new Set<SideRegion>();
  const emittedRight = new Set<SideRegion>();

  const emitInserts = (at: number) => {
    const lIns = findInsertsAt(leftRegions, at).filter((r) => !emittedLeft.has(r));
    const rIns = findInsertsAt(rightRegions, at).filter((r) => !emittedRight.has(r));

    // 配对：同位置双侧插入
    const max = Math.max(lIns.length, rIns.length);
    for (let k = 0; k < max; k++) {
      const l = lIns[k];
      const r = rIns[k];
      if (l) {
        emittedLeft.add(l);
      }
      if (r) {
        emittedRight.add(r);
      }
      if (l && r) {
        if (join(l.lines) === join(r.lines)) {
          push({
            kind: "add-left",
            leftLines: l.lines,
            rightLines: r.lines,
            baseLines: [],
            action: "auto",
          });
        } else {
          push({
            kind: "conflict",
            leftLines: l.lines,
            rightLines: r.lines,
            baseLines: [],
            action: "pending",
          });
        }
      } else if (l) {
        push({
          kind: "add-left",
          leftLines: l.lines,
          rightLines: [],
          baseLines: [],
          action: "auto",
        });
      } else if (r) {
        push({
          kind: "add-right",
          leftLines: [],
          rightLines: r.lines,
          baseLines: [],
          action: "auto",
        });
      }
    }
  };

  for (let pi = 0; pi < sorted.length; pi++) {
    const at = sorted[pi]!;
    emitInserts(at);

    if (pi >= sorted.length - 1) {
      break;
    }
    const start = at;
    const end = sorted[pi + 1]!;
    if (start >= end) {
      continue;
    }

    const sliceBase = base.slice(start, end);

    // 找到覆盖本切片的完整 region（在 region 起点才输出整块）
    const lFull = leftRegions.find(
      (r) => r.start !== r.end && r.start === start && r.end >= end && !emittedLeft.has(r),
    );
    const rFull = rightRegions.find(
      (r) => r.start !== r.end && r.start === start && r.end >= end && !emittedRight.has(r),
    );

    // 本切片落在某 region 内部（非起点）→ 跳过（已随起点整块输出）
    const lInside = leftRegions.find(
      (r) => r.start !== r.end && r.start < start && r.end >= end,
    );
    const rInside = rightRegions.find(
      (r) => r.start !== r.end && r.start < start && r.end >= end,
    );
    if ((lInside || rInside) && !lFull && !rFull) {
      continue;
    }

    // 扩展：若 region 比当前切片更大，一次吐完整 region
    const l = leftRegions.find(
      (r) => r.start !== r.end && r.start === start && !emittedLeft.has(r),
    );
    const r = rightRegions.find(
      (r) => r.start !== r.end && r.start === start && !emittedRight.has(r),
    );

    if (l && r) {
      emittedLeft.add(l);
      emittedRight.add(r);
      const baseSlice = base.slice(
        Math.min(l.start, r.start),
        Math.max(l.end, r.end),
      );
      push(classifyBothSides(l.lines, r.lines, baseSlice));
      const skipUntil = Math.max(l.end, r.end);
      while (pi + 1 < sorted.length - 1 && sorted[pi + 1]! < skipUntil) {
        pi += 1;
      }
      continue;
    }

    if (l && !r) {
      emittedLeft.add(l);
      // 右侧 tip 仍是 base；与左侧新内容不同 → 冲突（红）
      const baseSlice = base.slice(l.start, l.end);
      push(classifyBothSides(l.lines, baseSlice, baseSlice));
      while (pi + 1 < sorted.length - 1 && sorted[pi + 1]! < l.end) {
        pi += 1;
      }
      continue;
    }

    if (r && !l) {
      emittedRight.add(r);
      // 左侧 tip 仍是 base（如 marked@15）；右侧不同（如 @18）→ 冲突（红）
      const baseSlice = base.slice(r.start, r.end);
      push(classifyBothSides(baseSlice, r.lines, baseSlice));
      while (pi + 1 < sorted.length - 1 && sorted[pi + 1]! < r.end) {
        pi += 1;
      }
      continue;
    }

    // 双侧都无变更 → equal
    push({
      kind: "equal",
      leftLines: sliceBase,
      rightLines: [...sliceBase],
      baseLines: sliceBase,
      action: "auto",
    });
  }

  // 收尾：漏网的 insert（文件末尾）
  emitInserts(base.length);

  // 漏网的 region（防御）
  for (const l of leftRegions) {
    if (emittedLeft.has(l) || l.start === l.end) {
      continue;
    }
    const r = rightRegions.find(
      (x) => !emittedRight.has(x) && x.start === l.start && x.end === l.end,
    );
    if (r) {
      emittedRight.add(r);
      emittedLeft.add(l);
      push(classifyBothSides(l.lines, r.lines, base.slice(l.start, l.end)));
    } else {
      emittedLeft.add(l);
      const baseSlice = base.slice(l.start, l.end);
      push(classifyBothSides(l.lines, baseSlice, baseSlice));
    }
  }
  for (const r of rightRegions) {
    if (emittedRight.has(r) || r.start === r.end) {
      continue;
    }
    emittedRight.add(r);
    const baseSlice = base.slice(r.start, r.end);
    push(classifyBothSides(baseSlice, r.lines, baseSlice));
  }

  if (hunks.length === 0) {
    return [
      {
        id: "h-0",
        kind: "equal",
        leftLines: ours,
        rightLines: theirs,
        baseLines: base,
        action: "auto",
      },
    ];
  }
  return hunks;
}

/** 无 base 时 ours vs theirs */
function buildTwoWayHunks(ours: string[], theirs: string[]): ChangeHunk[] {
  const parts = diffArrays(ours, theirs);
  const hunks: ChangeHunk[] = [];
  let id = 0;
  let i = 0;
  while (i < parts.length) {
    const part = parts[i]!;
    if (!part.added && !part.removed) {
      hunks.push({
        id: `h-${id++}`,
        kind: "equal",
        leftLines: [...part.value],
        rightLines: [...part.value],
        baseLines: [...part.value],
        action: "auto",
      });
      i += 1;
      continue;
    }
    const left: string[] = [];
    const right: string[] = [];
    while (i < parts.length && (parts[i]!.added || parts[i]!.removed)) {
      const p = parts[i]!;
      if (p.removed) {
        left.push(...p.value);
      } else if (p.added) {
        right.push(...p.value);
      }
      i += 1;
    }
    if (left.length && right.length) {
      hunks.push({
        id: `h-${id++}`,
        kind: "conflict",
        leftLines: left,
        rightLines: right,
        baseLines: [],
        action: "pending",
      });
    } else if (left.length) {
      hunks.push({
        id: `h-${id++}`,
        kind: "add-left",
        leftLines: left,
        rightLines: [],
        baseLines: [],
        action: "auto",
      });
    } else {
      hunks.push({
        id: `h-${id++}`,
        kind: "add-right",
        leftLines: [],
        rightLines: right,
        baseLines: [],
        action: "auto",
      });
    }
  }
  return hunks;
}

/**
 * 从冲突标记解析（仅 equal + conflict）。
 * 注意：equal 两侧相同，会丢失「仅一侧的非冲突变更」展示，故仅作退化路径。
 */
export function buildChangeHunksFromMarkers(
  conflictContent: string | null | undefined,
  oursText?: string | null,
  theirsText?: string | null,
  baseText?: string | null,
): ChangeHunk[] {
  let segs = parseConflictContent(conflictContent);
  if (segs.length === 0 && (oursText != null || theirsText != null)) {
    segs = [
      {
        id: "c-0",
        type: "conflict",
        ours: oursText ?? "",
        base: baseText ?? "",
        theirs: theirsText ?? "",
        choice: null,
      },
    ];
  }
  const hunks: ChangeHunk[] = [];
  let i = 0;
  for (const seg of segs) {
    if (seg.type === "text") {
      const lines = splitLines(seg.content);
      hunks.push({
        id: `h-${i++}`,
        kind: "equal",
        leftLines: lines,
        rightLines: [...lines],
        baseLines: [...lines],
        action: "auto",
      });
    } else {
      const c = seg as ConflictSegment;
      hunks.push({
        id: `h-${i++}`,
        kind: "conflict",
        leftLines: splitLines(c.ours),
        rightLines: splitLines(c.theirs),
        baseLines: splitLines(c.base),
        action: "pending",
      });
    }
  }
  return hunks;
}

/**
 * 用 merge-file 冲突标记给已有 hunk 打标：匹配到的块升为 conflict，
 * 但不整表替换（避免丢掉 add-right 等非冲突行）。
 */
function applyMarkerConflictHints(
  hunks: ChangeHunk[],
  conflictContent: string | null | undefined,
): ChangeHunk[] {
  const markers = parseConflictContent(conflictContent).filter(
    (s): s is ConflictSegment => s.type === "conflict",
  );
  if (markers.length === 0) {
    return hunks;
  }

  return hunks.map((h) => {
    if (h.kind === "equal" || h.kind === "conflict") {
      return h;
    }
    const hLeft = join(h.leftLines).trim();
    const hRight = join(h.rightLines).trim();
    for (const m of markers) {
      const ours = m.ours.trim();
      const theirs = m.theirs.trim();
      if (ours === theirs) {
        continue;
      }
      const leftHit =
        (!!ours && (hLeft === ours || hLeft.includes(ours) || ours.includes(hLeft))) ||
        (!ours && h.kind.endsWith("right") && !!theirs && (hRight === theirs || hRight.includes(theirs)));
      const rightHit =
        !!theirs && (hRight === theirs || hRight.includes(theirs) || theirs.includes(hRight));
      if (!leftHit && !rightHit) {
        continue;
      }
      // 两侧内容不同才标红；补全空侧为 marker 文本
      return {
        ...h,
        kind: "conflict",
        leftLines: h.leftLines.length ? h.leftLines : splitLines(m.ours),
        rightLines: h.rightLines.length ? h.rightLines : splitLines(m.theirs),
        action: "pending",
      };
    }
    return h;
  });
}

/**
 * 优先三方 diff（保留绿/蓝非冲突变更）。
 * marker 仅用于把真正冲突块标红，不再整表回退。
 */
export function buildChangeHunks(file: {
  conflictContent?: string | null;
  oursContent?: string | null;
  theirsContent?: string | null;
  baseContent?: string | null;
}): ChangeHunk[] {
  const hasSides =
    file.oursContent != null || file.theirsContent != null || file.baseContent != null;

  if (hasSides) {
    const hunks = buildChangeHunksFromSides(
      file.baseContent,
      file.oursContent,
      file.theirsContent,
    );
    return applyMarkerConflictHints(hunks, file.conflictContent);
  }

  return buildChangeHunksFromMarkers(
    file.conflictContent,
    file.oursContent,
    file.theirsContent,
    file.baseContent,
  );
}

/** 根据 action 生成该 hunk 写入 Result 的行；pending 返回 null */
export function resolveHunkLines(hunk: ChangeHunk): string[] | null {
  switch (hunk.action) {
    case "auto":
      if (hunk.kind === "equal") {
        return hunk.leftLines.length ? hunk.leftLines : hunk.rightLines;
      }
      if (hunk.kind === "add-left" || hunk.kind === "modify-left") {
        return hunk.leftLines;
      }
      if (hunk.kind === "add-right" || hunk.kind === "modify-right") {
        return hunk.rightLines;
      }
      return null;
    case "accept-left":
    case "ignore-right":
      return hunk.leftLines;
    case "accept-right":
    case "ignore-left":
      return hunk.rightLines;
    case "custom":
      return hunk.customLines ?? [];
    case "pending":
      return null;
    default:
      return null;
  }
}

export function applyHunkActions(hunks: ChangeHunk[]): string {
  const parts: string[] = [];
  for (const h of hunks) {
    const lines = resolveHunkLines(h);
    if (lines == null) {
      parts.push(
        ["<<<<<<< 未解决", ...h.leftLines, "=======", ...h.rightLines, ">>>>>>>"].join(
          "\n",
        ),
      );
    } else if (lines.length > 0) {
      parts.push(lines.join("\n"));
    }
  }
  return parts.join("\n");
}

export function countHunkStats(hunks: ChangeHunk[]): {
  changes: number;
  conflicts: number;
  resolved: number;
  pending: number;
} {
  let changes = 0;
  let conflicts = 0;
  let resolved = 0;
  let pending = 0;
  for (const h of hunks) {
    if (h.kind === "equal") {
      continue;
    }
    changes += 1;
    if (h.kind === "conflict") {
      conflicts += 1;
      if (h.action === "pending") {
        pending += 1;
      } else {
        resolved += 1;
      }
    }
  }
  return { changes, conflicts, resolved, pending };
}

export function kindClass(kind: HunkKind): string {
  switch (kind) {
    case "add-left":
      return "hunk-add hunk-add-left";
    case "add-right":
      return "hunk-add hunk-add-right";
    case "modify-left":
      return "hunk-modify hunk-modify-left";
    case "modify-right":
      return "hunk-modify hunk-modify-right";
    case "conflict":
      return "hunk-conflict";
    default:
      return "hunk-equal";
  }
}

export function choiceToAction(
  choice: "ours" | "theirs" | "base" | "custom" | string,
): HunkAction {
  if (choice === "ours") {
    return "accept-left";
  }
  if (choice === "theirs") {
    return "accept-right";
  }
  if (choice === "custom") {
    return "custom";
  }
  return "pending";
}

export function actionToChoice(
  action: HunkAction,
): "ours" | "theirs" | "custom" | null {
  if (action === "accept-left" || action === "ignore-right") {
    return "ours";
  }
  if (action === "accept-right" || action === "ignore-left") {
    return "theirs";
  }
  if (action === "custom") {
    return "custom";
  }
  return null;
}
