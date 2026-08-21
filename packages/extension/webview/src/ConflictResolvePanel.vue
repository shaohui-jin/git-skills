<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  actionToChoice,
  applyHunkActions,
  buildChangeHunks,
  choiceToAction,
  countHunkStats,
  kindClass,
  type ChangeHunk,
  type HunkAction,
} from "./conflict/buildChangeHunks";
import { highlightLines } from "./conflict/highlight";
import {
  loadStash,
  saveStash,
  type StashedMergeResolve,
} from "./conflict/resolveStore";
import type {
  AiResolveHunkResult,
  AiResolveRequestPayload,
  AiResolveRuleId,
} from "./conflict/aiResolveTypes";
import type { CommitRef, ConflictFile } from "./types";
import AiResolveDialog, { type AiBridgeView } from "./AiResolveDialog.vue";

const props = defineProps<{
  files: ConflictFile[];
  cwd: string;
  into: string;
  from: string;
  /** 浏览器预览模式不可写仓库 */
  previewMode?: boolean;
  /**
   * 矩阵模式（从矩阵进来的批量预演）：解决不推送，提交到本地临时分支，
   * 推送收敛到矩阵「一键处理合并并推送」。
   * 直接预演不传，维持「解决即推送」旧语义。
   */
  matrixMode?: boolean;
  /** 是否允许点「一键申请 MR」 */
  canCreateMr?: boolean;
  /** 不可点时的原因 */
  createMrBlockReason?: string;
  /** 由 App 转发的 AI 进度 / 结果 */
  aiBusy?: boolean;
  aiProgressPercent?: number | null;
  aiProgressLabel?: string;
  aiResultToken?: number;
  aiResultHunks?: AiResolveHunkResult[] | null;
  aiError?: string | null;
  aiBridge?: AiBridgeView | null;
}>();

const emit = defineEmits<{
  applyResolve: [
    payload: {
      into: string;
      from: string;
      files: Array<{ path: string; resolvedContent: string }>;
      push: boolean;
    },
  ];
  requestCreateMr: [payload: { into: string; from: string }];
  aiResolve: [payload: AiResolveRequestPayload];
  /** 关闭弹层时清掉 App 侧错误态 */
  clearAiError: [];
  aiCopyPrompt: [];
  aiCancelBridge: [];
}>();

const activePath = ref("");
const hunksByPath = ref<Record<string, ChangeHunk[]>>({});
const stashNote = ref("");
const aiDialogOpen = ref(false);
const activeHunkId = ref<string | null>(null);
/** 「仅自动合并」分组是否展开 */
const autoOnlyExpanded = ref(false);
/** 导航时短暂闪烁，强化「跳到了这里」的感知 */
const flashHunkId = ref<string | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | null = null;

const scrollRootRef = ref<HTMLElement | null>(null);
let syncingScroll = false;

const filePaths = computed(() => props.files.map((f) => f.path));

/** 有冲突红块的文件（左侧主列表 / 上下文件跳转范围） */
const conflictFilePaths = computed(() =>
  filePaths.value.filter(
    (p) => countHunkStats(hunksByPath.value[p] ?? []).conflicts > 0,
  ),
);

/** 无冲突、仅绿/蓝自动变更（或空统计）的文件 */
const autoOnlyFilePaths = computed(() =>
  filePaths.value.filter(
    (p) => countHunkStats(hunksByPath.value[p] ?? []).conflicts === 0,
  ),
);

const conflictFileIndex = computed(() =>
  conflictFilePaths.value.indexOf(activePath.value),
);

const activeFile = computed(
  () =>
    props.files.find((f) => f.path === activePath.value) ??
    props.files.find((f) => conflictFilePaths.value.includes(f.path)) ??
    props.files[0],
);

const hunks = computed(() => {
  const path = activeFile.value?.path;
  if (!path) {
    return [] as ChangeHunk[];
  }
  return hunksByPath.value[path] ?? [];
});

const conflictHunks = computed(() => hunks.value.filter((h) => h.kind === "conflict"));

const fileStats = computed(() => countHunkStats(hunks.value));

const allStats = computed(() => {
  let conflicts = 0;
  let resolved = 0;
  let changes = 0;
  for (const list of Object.values(hunksByPath.value)) {
    const s = countHunkStats(list);
    conflicts += s.conflicts;
    resolved += s.resolved;
    changes += s.changes;
  }
  return { conflicts, resolved, changes, pending: conflicts - resolved };
});

const activeHunk = computed(() => {
  const id = activeHunkId.value;
  if (!id) {
    return null;
  }
  return hunks.value.find((h) => h.id === id) ?? null;
});

const activeConflictIndex = computed(() => {
  if (!activeHunkId.value) {
    return -1;
  }
  return conflictHunks.value.findIndex((h) => h.id === activeHunkId.value);
});

/** 预计算高亮行，避免模板内重复计算 */
const highlighted = computed(() => {
  const path = activeFile.value?.path ?? "";
  return hunks.value.map((h) => ({
    id: h.id,
    left: highlightLines(h.leftLines, path),
    right: highlightLines(h.rightLines, path),
    result: (() => {
      if (h.action === "pending") {
        const block = [
          "<<<<<<< 未解决",
          ...h.leftLines,
          "=======",
          ...h.rightLines,
          ">>>>>>>",
        ];
        return highlightLines(block, path);
      }
      if (h.action === "custom") {
        return highlightLines(h.customLines ?? [], path);
      }
      if (h.action === "accept-left" || h.action === "ignore-right") {
        return highlightLines(h.leftLines, path);
      }
      if (h.action === "accept-right" || h.action === "ignore-left") {
        return highlightLines(h.rightLines, path);
      }
      // auto
      if (h.kind === "add-right" || h.kind === "modify-right") {
        return highlightLines(h.rightLines, path);
      }
      return highlightLines(
        h.leftLines.length ? h.leftLines : h.rightLines,
        path,
      );
    })(),
  }));
});

function uniqCommits(list: CommitRef[]): CommitRef[] {
  const map = new Map<string, CommitRef>();
  for (const c of list) {
    if (!map.has(c.sha)) {
      map.set(c.sha, c);
    }
  }
  return [...map.values()];
}

function commitsForFile(path: string): { ours: CommitRef[]; theirs: CommitRef[] } {
  const file = props.files.find((f) => f.path === path);
  if (!file) {
    return { ours: [], theirs: [] };
  }
  // 转成纯对象，避免 Vue Proxy 经 postMessage 时 DataCloneError
  const plain = (c: CommitRef): CommitRef => ({
    sha: String(c.sha),
    author: String(c.author ?? ""),
    message: c.message != null ? String(c.message) : undefined,
    time: typeof c.time === "number" ? c.time : undefined,
    authorEmail: c.authorEmail != null ? String(c.authorEmail) : undefined,
    pr: c.pr != null ? String(c.pr) : undefined,
  });
  return {
    ours: uniqCommits(file.hunks.flatMap((h) => h.oursCommits)).map(plain),
    theirs: uniqCommits(file.hunks.flatMap((h) => h.theirsCommits)).map(plain),
  };
}

const highlightedMap = computed(() => {
  const map = new Map<string, (typeof highlighted.value)[0]>();
  for (const row of highlighted.value) {
    map.set(row.id, row);
  }
  return map;
});

function initFromFiles(): void {
  const next: Record<string, ChangeHunk[]> = {};
  for (const f of props.files) {
    next[f.path] = buildChangeHunks(f);
  }
  const stash = loadStash(props.cwd, props.into, props.from);
  if (stash) {
    for (const [path, fileStash] of Object.entries(stash.files)) {
      const list = next[path];
      if (!list) {
        continue;
      }
      for (const hunk of list) {
        const choice = fileStash.choices[hunk.id];
        if (choice) {
          hunk.action = choiceToAction(choice);
          if (choice === "custom" && fileStash.customByHunk?.[hunk.id] != null) {
            hunk.customLines = fileStash.customByHunk[hunk.id]!.split("\n");
          }
          if (fileStash.reasons?.[hunk.id]) {
            hunk.aiReason = fileStash.reasons[hunk.id];
          }
        }
      }
    }
    stashNote.value = `已加载暂存（${new Date(stash.updatedAt).toLocaleString()}）`;
  } else {
    stashNote.value = "";
  }
  hunksByPath.value = next;
  const firstConflictPath =
    props.files.find((f) =>
      (next[f.path] ?? []).some((h) => h.kind === "conflict"),
    )?.path ??
    props.files[0]?.path ??
    "";
  activePath.value = firstConflictPath;
  const first = next[activePath.value]?.find((h) => h.kind === "conflict");
  activeHunkId.value = first?.id ?? next[activePath.value]?.[0]?.id ?? null;
  autoOnlyExpanded.value = false;
}

watch(
  () =>
    [props.cwd, props.into, props.from, props.files.map((f) => f.path).join("\n")].join(
      "|",
    ),
  () => initFromFiles(),
  { immediate: true },
);

watch(activePath, () => {
  const first = conflictHunks.value[0] ?? hunks.value[0];
  activeHunkId.value = first?.id ?? null;
});

function updateHunk(id: string, action: HunkAction): void {
  const path = activePath.value;
  const list = hunksByPath.value[path];
  if (!list) {
    return;
  }
  const idx = list.findIndex((h) => h.id === id);
  if (idx < 0) {
    return;
  }
  const cur = list[idx]!;
  const updated = [...list];
  updated[idx] = {
    ...cur,
    action,
    customLines: action === "custom" ? cur.customLines : undefined,
  };
  hunksByPath.value = { ...hunksByPath.value, [path]: updated };
  activeHunkId.value = id;
}

function acceptLeft(hunk: ChangeHunk): void {
  updateHunk(hunk.id, "accept-left");
}

function acceptRight(hunk: ChangeHunk): void {
  updateHunk(hunk.id, "accept-right");
}

function ignoreLeft(hunk: ChangeHunk): void {
  // 忽略左侧 → 结果用右侧（若有），否则清空该侧贡献
  if (hunk.kind === "conflict" || hunk.rightLines.length > 0) {
    updateHunk(hunk.id, "ignore-left");
  } else {
    updateHunk(hunk.id, "accept-right");
  }
}

function ignoreRight(hunk: ChangeHunk): void {
  if (hunk.kind === "conflict" || hunk.leftLines.length > 0) {
    updateHunk(hunk.id, "ignore-right");
  } else {
    updateHunk(hunk.id, "accept-left");
  }
}

/** 整文件选边；可指定 path（左侧行内），未指定则用当前文件 */
function acceptAll(side: "left" | "right", path?: string): void {
  const target = path ?? activePath.value;
  const list = hunksByPath.value[target];
  if (!list) {
    return;
  }
  if (path && path !== activePath.value) {
    activePath.value = path;
  }
  const action: HunkAction = side === "left" ? "accept-left" : "accept-right";
  hunksByPath.value = {
    ...hunksByPath.value,
    [target]: list.map((h) =>
      h.kind === "conflict" ? { ...h, action } : h,
    ),
  };
}

function resetCurrentFile(): void {
  const path = activePath.value;
  const file = props.files.find((f) => f.path === path);
  if (!file) {
    return;
  }
  hunksByPath.value = {
    ...hunksByPath.value,
    [path]: buildChangeHunks(file),
  };
}

function triggerFlash(id: string): void {
  if (flashTimer) {
    clearTimeout(flashTimer);
  }
  flashHunkId.value = null;
  // 下一帧再挂上，保证重复点击同一处也会重播动画
  requestAnimationFrame(() => {
    flashHunkId.value = id;
    flashTimer = setTimeout(() => {
      if (flashHunkId.value === id) {
        flashHunkId.value = null;
      }
      flashTimer = null;
    }, 900);
  });
}

function goConflict(delta: number): void {
  const list = conflictHunks.value;
  if (list.length === 0) {
    return;
  }
  // 优先在未解决冲突间跳转；若全已解决则遍历全部冲突
  const pending = list.filter((h) => h.action === "pending");
  const pool = pending.length > 0 ? pending : list;
  let idx = pool.findIndex((h) => h.id === activeHunkId.value);
  if (idx < 0) {
    idx = delta > 0 ? -1 : 0;
  }
  let next = idx + delta;
  if (next < 0) {
    next = pool.length - 1;
  } else if (next >= pool.length) {
    next = 0;
  }
  const target = pool[next]!;
  activeHunkId.value = target.id;
  triggerFlash(target.id);
  void nextTick(() => scrollToActive());
}

/** 仅在有冲突红块的文件间跳转（循环） */
function goConflictFile(delta: number): void {
  const list = conflictFilePaths.value;
  if (list.length === 0) {
    return;
  }
  let idx = conflictFileIndex.value;
  if (idx < 0) {
    idx = delta > 0 ? -1 : 0;
  }
  let next = idx + delta;
  if (next < 0) {
    next = list.length - 1;
  } else if (next >= list.length) {
    next = 0;
  }
  activePath.value = list[next]!;
}

function scrollToActive(): void {
  const id = activeHunkId.value;
  if (!id || !scrollRootRef.value) {
    return;
  }
  const el = scrollRootRef.value.querySelector(`[data-hunk-id="${id}"]`);
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function onMergeScroll(ev: Event): void {
  if (syncingScroll) {
    return;
  }
  // 单滚动容器，无需同步；保留钩子便于后续分栏
  void ev;
  syncingScroll = false;
}

function buildStash(): StashedMergeResolve {
  const files: StashedMergeResolve["files"] = {};
  for (const [path, list] of Object.entries(hunksByPath.value)) {
    const choices: StashedMergeResolve["files"][string]["choices"] = {};
    const customByHunk: Record<string, string> = {};
    const reasons: Record<string, string> = {};
    for (const h of list) {
      const c = actionToChoice(h.action);
      if (c) {
        choices[h.id] = c;
      }
      if (h.action === "custom" && h.customLines) {
        customByHunk[h.id] = h.customLines.join("\n");
      }
      if (h.aiReason) {
        reasons[h.id] = h.aiReason;
      }
    }
    files[path] = {
      path,
      choices,
      customByHunk: Object.keys(customByHunk).length ? customByHunk : undefined,
      reasons: Object.keys(reasons).length ? reasons : undefined,
      resolvedContent: applyHunkActions(list),
      updatedAt: Date.now(),
    };
  }
  return {
    cwd: props.cwd,
    into: props.into,
    from: props.from,
    files,
    updatedAt: Date.now(),
  };
}

/** 仅重置界面选边，不清理 localStorage */
function resetStash(): void {
  const next: Record<string, ChangeHunk[]> = {};
  for (const f of props.files) {
    next[f.path] = buildChangeHunks(f);
  }
  hunksByPath.value = next;
  const firstConflictPath =
    props.files.find((f) =>
      (next[f.path] ?? []).some((h) => h.kind === "conflict"),
    )?.path ??
    props.files[0]?.path ??
    "";
  activePath.value = firstConflictPath;
  const first = next[activePath.value]?.find((h) => h.kind === "conflict");
  activeHunkId.value = first?.id ?? next[activePath.value]?.[0]?.id ?? null;
  stashNote.value = "已重置选边（未清除本地暂存缓存）";
}

function openAiDialog(): void {
  if (allStats.value.conflicts === 0) {
    stashNote.value = "没有冲突可交给 AI";
    return;
  }
  if (props.previewMode) {
    stashNote.value = "预览模式不支持 AI 选边，请在扩展中使用";
    return;
  }
  aiDialogOpen.value = true;
}

function closeAiDialog(): void {
  if (props.aiBusy) {
    return;
  }
  aiDialogOpen.value = false;
  emit("clearAiError");
}

function onAiConfirm(payload: { rules: AiResolveRuleId[]; extraNotes: string }): void {
  const hunks: AiResolveRequestPayload["hunks"] = [];
  for (const [path, list] of Object.entries(hunksByPath.value)) {
    const { ours, theirs } = commitsForFile(path);
    for (const h of list) {
      if (h.kind !== "conflict") {
        continue;
      }
      hunks.push({
        // 各文件本地 id 均从 h-0 起算；带 path 前缀避免 AI 回传/归一化时互相覆盖
        id: `${path}::${h.id}`,
        path,
        leftText: h.leftLines.join("\n"),
        rightText: h.rightLines.join("\n"),
        baseText: h.baseLines.join("\n"),
        oursCommits: ours,
        theirsCommits: theirs,
      });
    }
  }
  if (!hunks.length) {
    stashNote.value = "没有待解决的冲突块";
    return;
  }
  stashNote.value = "AI 选边中…";
  emit("aiResolve", {
    into: props.into,
    from: props.from,
    rules: payload.rules,
    extraNotes: payload.extraNotes,
    hunks,
  });
}

function applyAiResults(results: AiResolveHunkResult[]): void {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const byKey = new Map(results.map((r) => [`${norm(r.path)}\0${r.id}`, r]));
  const next: Record<string, ChangeHunk[]> = {};
  let applied = 0;
  let pending = 0;
  let unmatched = 0;
  for (const [path, list] of Object.entries(hunksByPath.value)) {
    next[path] = list.map((h) => {
      if (h.kind !== "conflict") {
        return h;
      }
      const r = byKey.get(`${norm(path)}\0${h.id}`);
      if (!r) {
        unmatched += 1;
        return h;
      }
      const copy: ChangeHunk = { ...h, aiReason: r.reason };
      if (r.choice === "ours") {
        copy.action = "accept-left";
        copy.customLines = undefined;
        applied += 1;
      } else if (r.choice === "theirs") {
        copy.action = "accept-right";
        copy.customLines = undefined;
        applied += 1;
      } else if (r.choice === "merge" && r.mergedContent != null) {
        copy.action = "custom";
        copy.customLines = r.mergedContent.replace(/\r\n/g, "\n").split("\n");
        applied += 1;
      } else {
        copy.action = "pending";
        copy.customLines = undefined;
        pending += 1;
      }
      return copy;
    });
  }
  hunksByPath.value = next;
  saveStash(buildStash());
  const miss =
    unmatched > 0 ? `，未匹配 ${unmatched}（请重试 AI 或手动选边）` : "";
  stashNote.value = `AI 选边完成：已应用 ${applied}，仍待人工 ${pending}${miss}`;
  aiDialogOpen.value = false;
}

watch(
  () => props.aiResultToken,
  (token) => {
    if (!token || !props.aiResultHunks?.length) {
      return;
    }
    applyAiResults(props.aiResultHunks);
  },
);

watch(
  () => props.aiError,
  (err) => {
    if (!err) {
      return;
    }
    stashNote.value = err;
    // 失败时保持弹层打开，方便看报错 / 复制
    aiDialogOpen.value = true;
  },
);

watch(
  () => props.aiBusy,
  (busy) => {
    if (busy) {
      stashNote.value = props.aiProgressLabel
        ? `${props.aiProgressLabel} ${props.aiProgressPercent ?? 0}%`
        : "AI 选边中…";
    }
  },
);

watch(
  () => [props.aiProgressLabel, props.aiProgressPercent] as const,
  ([label, pct]) => {
    if (!props.aiBusy || !label) {
      return;
    }
    stashNote.value = `${label} ${pct ?? 0}%`;
  },
);

function canApplyResolve(): boolean {
  if (props.previewMode) {
    return false;
  }
  if (allStats.value.conflicts === 0) {
    return false;
  }
  return allStats.value.pending === 0;
}

/** 先写入暂存，再请求宿主执行方案 A：建分支 / merge / commit / push */
function applyResolveNow(): void {
  if (!canApplyResolve()) {
    stashNote.value =
      allStats.value.pending > 0
        ? "请先解决全部冲突后再一键应用"
        : props.previewMode
          ? "预览模式不支持写仓库"
          : "没有可应用的冲突解决结果";
    return;
  }
  const stash = buildStash();
  saveStash(stash);
  const files = Object.values(stash.files).map((f) => ({
    path: f.path,
    resolvedContent: f.resolvedContent,
  }));
  emit("applyResolve", {
    into: props.into,
    from: props.from,
    files,
    push: true,
  });
  stashNote.value = "已提交一键解决请求（等待宿主确认）…";
}

function fileResolvedCount(path: string): string {
  const s = countHunkStats(hunksByPath.value[path] ?? []);
  if (s.conflicts === 0) {
    // Δ = 仅绿/蓝自动合并变更，无需手选
    return s.changes ? `${s.changes}Δ` : "—";
  }
  return `${s.resolved}/${s.conflicts}`;
}

function selectHunk(id: string): void {
  activeHunkId.value = id;
}

function hl(hunkId: string, side: "left" | "right" | "result"): string[] {
  return highlightedMap.value.get(hunkId)?.[side] ?? [];
}

/** 仅冲突块显示 ≫ / × / ≪；绿/蓝自动合并块不展示，避免误当成待解决冲突 */
function showLeftGutter(h: ChangeHunk): boolean {
  return h.kind === "conflict" && h.leftLines.length > 0;
}

function showRightGutter(h: ChangeHunk): boolean {
  return h.kind === "conflict" && h.rightLines.length > 0;
}

function isConflictResolved(h: ChangeHunk): boolean {
  return h.kind === "conflict" && h.action !== "pending";
}

function choseLeft(h: ChangeHunk): boolean {
  return h.action === "accept-left" || h.action === "ignore-right";
}

function choseRight(h: ChangeHunk): boolean {
  return h.action === "accept-right" || h.action === "ignore-left";
}

function rowClass(h: ChangeHunk): Array<string | Record<string, boolean>> {
  return [
    kindClass(h.kind),
    {
      active: h.id === activeHunkId.value,
      "hunk-flash": flashHunkId.value === h.id,
      "hunk-resolved": isConflictResolved(h),
      "hunk-chose-left": choseLeft(h),
      "hunk-chose-right": choseRight(h),
      "hunk-chose-custom": h.action === "custom",
    },
  ];
}

function lineNos(lines: string[], start = 1): number[] {
  if (lines.length === 0) {
    return [];
  }
  return lines.map((_, i) => start + i);
}

/** 为左栏累计行号 */
const leftLineStarts = computed(() => {
  const starts: Record<string, number> = {};
  let n = 1;
  for (const h of hunks.value) {
    starts[h.id] = n;
    n += Math.max(h.leftLines.length, 1);
  }
  return starts;
});

const rightLineStarts = computed(() => {
  const starts: Record<string, number> = {};
  let n = 1;
  for (const h of hunks.value) {
    starts[h.id] = n;
    n += Math.max(h.rightLines.length, 1);
  }
  return starts;
});

const resultLineStarts = computed(() => {
  const starts: Record<string, number> = {};
  let n = 1;
  for (const h of hunks.value) {
    starts[h.id] = n;
    const rows = hl(h.id, "result");
    n += Math.max(rows.length, 1);
  }
  return starts;
});
</script>

<template>
  <div class="resolve-shell">
    <div class="resolve-top">
      <div class="resolve-summary-slot">
        <slot name="summary" />
      </div>
      <div class="resolve-toolbar card">
        <div class="resolve-toolbar-main">
          <h3>冲突解决（预演）</h3>
          <span
            class="badge"
            :class="allStats.pending === 0 && allStats.conflicts ? 'ok' : 'danger'"
          >
            {{ allStats.changes }} changes, {{ allStats.conflicts }} conflicts
          </span>
        </div>
        <p class="muted resolve-tip">
          <span class="tag-online">左栏=线上目标</span>，
          <span class="tag-mine">右栏=我的分支</span>。
          <template v-if="matrixMode">
            选边后点「完成冲突处理」提交到本地临时分支（不推送）；全部处理完回矩阵「一键处理合并并推送」。
          </template>
          <template v-else>
            选边后用「一键解决并推送」写入临时分支（不切换当前分支），再申请 MR。
          </template>
        </p>
        <div class="resolve-actions">
          <button
            type="button"
            class="btn secondary"
            :disabled="allStats.conflicts === 0 || aiBusy || previewMode"
            title="按规则调用模型选边，结果回填后仍需人工确认"
            @click="openAiDialog"
          >
            {{ aiBusy ? "AI 选边中…" : "AI 选边" }}
          </button>
          <button
            type="button"
            class="btn"
            :disabled="!canApplyResolve() || aiBusy"
            :title="
              matrixMode
                ? '校验所有冲突文件已选边后提交到本地临时分支（不推送）；批量合并时自动带上'
                : '在独立 worktree 中创建临时分支并应用选边后推送（不改当前分支）'
            "
            @click="applyResolveNow"
          >
            {{ matrixMode ? "完成冲突处理" : "一键解决并推送" }}
          </button>
          <button
            type="button"
            class="btn"
            :class="{ secondary: !canCreateMr }"
            :disabled="previewMode || !into || !from || aiBusy || !canCreateMr"
            :title="
              !canCreateMr
                ? (matrixMode
                    ? '矩阵模式走批量流程：回矩阵点「一键处理合并并推送」后统一申请总 MR'
                    : (createMrBlockReason ||
                       '请先完成「一键解决并推送」，并在「Git 配置」中选择 MR 方式'))
                : '申请 MR'
            "
            @click="emit('requestCreateMr', { into, from })"
          >
            一键申请 MR
          </button>
          <button
            type="button"
            class="btn secondary"
            :disabled="aiBusy"
            title="重置界面选边，不清理本地暂存缓存"
            @click="resetStash"
          >
            清除暂存
          </button>
          <span v-if="stashNote" class="stash-note">{{ stashNote }}</span>
        </div>
      </div>
    </div>

    <AiResolveDialog
      :open="aiDialogOpen || !!aiBusy"
      :busy="!!aiBusy"
      :progress-percent="aiProgressPercent"
      :progress-label="aiProgressLabel || '准备发送冲突数据…'"
      :error="aiError"
      :bridge="aiBridge"
      @close="closeAiDialog"
      @confirm="onAiConfirm"
      @copy-prompt="emit('aiCopyPrompt')"
      @cancel-bridge="emit('aiCancelBridge')"
    />

    <div class="resolve-layout">
      <aside class="resolve-files card">
        <div class="resolve-files-head">
          <h4>冲突文件（{{ conflictFilePaths.length }}）</h4>
          <div
            v-if="conflictFilePaths.length"
            class="resolve-files-nav"
            title="仅在有红块的冲突文件间跳转"
          >
            <button
              type="button"
              class="btn tiny resolve-files-nav-btn"
              :disabled="conflictFilePaths.length < 2"
              title="上一冲突文件"
              @click="goConflictFile(-1)"
            >
              ‹
            </button>
            <span class="resolve-files-nav-pos">
              {{
                conflictFileIndex >= 0
                  ? `${conflictFileIndex + 1}/${conflictFilePaths.length}`
                  : `0/${conflictFilePaths.length}`
              }}
            </span>
            <button
              type="button"
              class="btn tiny resolve-files-nav-btn"
              :disabled="conflictFilePaths.length < 2"
              title="下一冲突文件"
              @click="goConflictFile(1)"
            >
              ›
            </button>
          </div>
        </div>
        <ul v-if="conflictFilePaths.length">
          <li
            v-for="path in conflictFilePaths"
            :key="path"
            class="resolve-file"
            :class="{ active: path === activePath }"
            :title="path"
            @click="activePath = path"
          >
            <div class="resolve-file-main">
              <span class="mono path">{{ path.split("/").pop() }}</span>
              <span class="count">{{ fileResolvedCount(path) }}</span>
            </div>
            <div
              v-if="path === activePath"
              class="resolve-file-actions"
              @click.stop
            >
              <button
                type="button"
                class="btn secondary tiny resolve-file-side"
                title="本文件全部冲突采用线上目标"
                @click="acceptAll('left', path)"
              >
                线上
              </button>
              <button
                type="button"
                class="btn secondary tiny resolve-file-side"
                title="本文件全部冲突采用我的分支"
                @click="acceptAll('right', path)"
              >
                我的
              </button>
            </div>
          </li>
        </ul>
        <p v-else class="resolve-files-empty muted">无待手选冲突</p>

        <button
          v-if="autoOnlyFilePaths.length"
          type="button"
          class="resolve-auto-toggle"
          :title="'这些文件无冲突红块，仅绿/蓝自动合并变更；一键解决仍会写入'"
          @click="autoOnlyExpanded = !autoOnlyExpanded"
        >
          <span class="tree-caret">{{ autoOnlyExpanded ? "▾" : "▸" }}</span>
          仅自动合并（{{ autoOnlyFilePaths.length }}）
        </button>
        <ul v-if="autoOnlyExpanded && autoOnlyFilePaths.length">
          <li
            v-for="path in autoOnlyFilePaths"
            :key="path"
            class="resolve-file resolve-file--auto"
            :class="{ active: path === activePath }"
            :title="`${path}（无冲突，仅自动变更）`"
            @click="activePath = path"
          >
            <div class="resolve-file-main">
              <span class="mono path">{{ path.split("/").pop() }}</span>
              <span class="count">{{ fileResolvedCount(path) }}</span>
            </div>
          </li>
        </ul>
      </aside>

      <div class="resolve-main">
        <div v-if="!activeFile" class="card empty">无冲突文件</div>
        <template v-else>
          <div class="resolve-main-bar card">
            <div class="resolve-main-bar-left">
              <span class="mono file-name" :title="activeFile.path">{{ activeFile.path }}</span>
              <span class="stat-pill" title="changes=含自动合并的绿/蓝变更；conflicts=需手选的红块">
                {{ fileStats.changes }} 处变更 ·
                <strong>{{ fileStats.conflicts }}</strong> 处冲突
              </span>
              <span class="stat-pill" :class="fileStats.pending === 0 ? 'ok' : 'warn'">
                已解决 <strong>{{ fileStats.resolved }}</strong> /
                {{ fileStats.conflicts }}
              </span>
            </div>
            <div class="resolve-main-bar-right">
              <div class="nav-conflict-group">
                <button
                  type="button"
                  class="btn nav-conflict-btn"
                  :disabled="conflictHunks.length === 0"
                  title="上一处冲突（优先未解决）"
                  @click="goConflict(-1)"
                >
                  ↑ 上一处
                </button>
                <span
                  class="nav-conflict-pos"
                  :class="{ 'nav-conflict-pos--flash': !!flashHunkId }"
                >
                  {{
                    activeConflictIndex >= 0
                      ? `${activeConflictIndex + 1} / ${conflictHunks.length}`
                      : `0 / ${conflictHunks.length}`
                  }}
                </span>
                <button
                  type="button"
                  class="btn nav-conflict-btn"
                  :disabled="conflictHunks.length === 0"
                  title="下一处冲突（优先未解决）"
                  @click="goConflict(1)"
                >
                  ↓ 下一处
                </button>
              </div>
              <span class="bar-sep" />
              <button
                type="button"
                class="btn tiny"
                :disabled="!activeHunk || activeHunk.kind !== 'conflict'"
                title="采用线上目标侧（左栏）"
                @click="activeHunk && acceptLeft(activeHunk)"
              >
                采用线上
              </button>
              <button
                type="button"
                class="btn tiny"
                :disabled="!activeHunk || activeHunk.kind !== 'conflict'"
                title="采用我的分支侧（右栏）"
                @click="activeHunk && acceptRight(activeHunk)"
              >
                采用我的
              </button>
              <button
                type="button"
                class="btn secondary tiny"
                @click="resetCurrentFile"
              >
                重置本文件
              </button>
            </div>
            <p v-if="activeHunk?.aiReason" class="ai-reason muted">
              AI：{{ activeHunk.aiReason }}
              <template v-if="activeHunk.action === 'custom'">（合并正文）</template>
            </p>
          </div>

          <!-- WebStorm：左 | gutter | 结果 | gutter | 右 -->
          <div class="merge-ws">
            <div
              ref="scrollRootRef"
              class="merge-ws-body"
              @scroll="onMergeScroll"
            >
              <!-- 表头放在滚动容器内并 sticky：否则滚动条宽度会让它和下面的列错位 -->
              <header class="merge-ws-heads">
                <div class="merge-ws-head merge-ws-head--ours">
                  线上（目标）{{ into }}
                </div>
                <div class="merge-ws-gutter-head" />
                <div class="merge-ws-head merge-ws-head--result">
                  结果 [{{ activeFile.path.split("/").pop() }}]
                </div>
                <div class="merge-ws-gutter-head" />
                <div class="merge-ws-head merge-ws-head--theirs">
                  我的分支 {{ from }}
                </div>
              </header>

              <div
                v-for="h in hunks"
                :key="h.id"
                class="merge-ws-row"
                :class="rowClass(h)"
                :data-hunk-id="h.id"
                @click="selectHunk(h.id)"
              >
                <!-- 左：线上目标 -->
                <div class="merge-ws-pane merge-ws-pane--ours">
                  <div class="merge-line-nos">
                    <span
                      v-for="(ln, i) in lineNos(
                        h.leftLines.length ? h.leftLines : [''],
                        leftLineStarts[h.id] ?? 1,
                      )"
                      :key="'lnL' + i"
                      >{{ h.leftLines.length ? ln : "" }}</span
                    >
                  </div>
                  <div class="merge-code">
                    <div
                      v-for="(line, i) in hl(h.id, 'left')"
                      :key="'L' + i"
                      class="merge-code-line"
                      v-html="line || '&nbsp;'"
                    />
                    <div
                      v-if="h.leftLines.length === 0 && h.kind !== 'equal'"
                      class="merge-code-line merge-placeholder"
                    >
                      &nbsp;
                    </div>
                  </div>
                </div>

                <!-- gutter：≫ / X -->
                <div class="merge-ws-gutter">
                  <template v-if="showLeftGutter(h)">
                    <button
                      type="button"
                      class="gutter-btn gutter-btn--accept"
                      :class="{ 'gutter-btn--done': choseLeft(h) }"
                      title="采用线上到结果"
                      @click.stop="acceptLeft(h)"
                    >
                      {{ choseLeft(h) ? "✓" : "≫" }}
                    </button>
                    <button
                      v-if="!isConflictResolved(h)"
                      type="button"
                      class="gutter-btn gutter-btn--ignore"
                      title="忽略线上侧"
                      @click.stop="ignoreLeft(h)"
                    >
                      ×
                    </button>
                  </template>
                </div>

                <!-- 中：结果 -->
                <div class="merge-ws-pane merge-ws-pane--result">
                  <div class="merge-line-nos">
                    <span
                      v-for="(ln, i) in lineNos(
                        hl(h.id, 'result').length ? hl(h.id, 'result') : [''],
                        resultLineStarts[h.id] ?? 1,
                      )"
                      :key="'lnM' + i"
                      >{{ hl(h.id, 'result').length ? ln : "" }}</span
                    >
                  </div>
                  <div class="merge-code">
                    <div
                      v-for="(line, i) in hl(h.id, 'result')"
                      :key="'M' + i"
                      class="merge-code-line"
                      v-html="line || '&nbsp;'"
                    />
                  </div>
                </div>

                <!-- gutter：X / ≪ -->
                <div class="merge-ws-gutter">
                  <template v-if="showRightGutter(h)">
                    <button
                      v-if="!isConflictResolved(h)"
                      type="button"
                      class="gutter-btn gutter-btn--ignore"
                      title="忽略我的分支侧"
                      @click.stop="ignoreRight(h)"
                    >
                      ×
                    </button>
                    <button
                      type="button"
                      class="gutter-btn gutter-btn--accept gutter-btn--from-right"
                      :class="{ 'gutter-btn--done': choseRight(h) }"
                      title="采用我的到结果"
                      @click.stop="acceptRight(h)"
                    >
                      {{ choseRight(h) ? "✓" : "≪" }}
                    </button>
                  </template>
                </div>

                <!-- 右：我的分支 -->
                <div class="merge-ws-pane merge-ws-pane--theirs">
                  <div class="merge-line-nos">
                    <span
                      v-for="(ln, i) in lineNos(
                        h.rightLines.length ? h.rightLines : [''],
                        rightLineStarts[h.id] ?? 1,
                      )"
                      :key="'lnR' + i"
                      >{{ h.rightLines.length ? ln : "" }}</span
                    >
                  </div>
                  <div class="merge-code">
                    <div
                      v-for="(line, i) in hl(h.id, 'right')"
                      :key="'R' + i"
                      class="merge-code-line"
                      v-html="line || '&nbsp;'"
                    />
                    <div
                      v-if="h.rightLines.length === 0 && h.kind !== 'equal'"
                      class="merge-code-line merge-placeholder"
                    >
                      &nbsp;
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
