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
  clearStash,
  loadStash,
  saveStash,
  type StashedMergeResolve,
} from "./conflict/resolveStore";
import type { ConflictFile } from "./types";

const props = defineProps<{
  files: ConflictFile[];
  cwd: string;
  into: string;
  from: string;
}>();

const activePath = ref("");
const hunksByPath = ref<Record<string, ChangeHunk[]>>({});
const stashNote = ref("");
const activeHunkId = ref<string | null>(null);
/** 导航时短暂闪烁，强化「跳到了这里」的感知 */
const flashHunkId = ref<string | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | null = null;

const scrollRootRef = ref<HTMLElement | null>(null);
let syncingScroll = false;

const filePaths = computed(() => props.files.map((f) => f.path));

const activeFile = computed(
  () => props.files.find((f) => f.path === activePath.value) ?? props.files[0],
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
        }
      }
    }
    stashNote.value = `已加载暂存（${new Date(stash.updatedAt).toLocaleString()}）`;
  } else {
    stashNote.value = "";
  }
  hunksByPath.value = next;
  activePath.value = props.files[0]?.path ?? "";
  const first = next[activePath.value]?.find((h) => h.kind === "conflict");
  activeHunkId.value = first?.id ?? next[activePath.value]?.[0]?.id ?? null;
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
  updated[idx] = { ...cur, action };
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

function acceptAll(side: "left" | "right"): void {
  const path = activePath.value;
  const list = hunksByPath.value[path];
  if (!list) {
    return;
  }
  const action: HunkAction = side === "left" ? "accept-left" : "accept-right";
  hunksByPath.value = {
    ...hunksByPath.value,
    [path]: list.map((h) =>
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
    const choices: Record<string, "ours" | "theirs"> = {};
    for (const h of list) {
      const c = actionToChoice(h.action);
      if (c) {
        choices[h.id] = c;
      }
    }
    files[path] = {
      path,
      choices,
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

function stashNow(): void {
  const stash = buildStash();
  saveStash(stash);
  stashNote.value = `已暂存 ${allStats.value.resolved}/${allStats.value.conflicts} 冲突 · ${new Date(stash.updatedAt).toLocaleString()}`;
}

function resetStash(): void {
  clearStash(props.cwd, props.into, props.from);
  initFromFiles();
  stashNote.value = "已清除暂存";
}

function fileResolvedCount(path: string): string {
  const s = countHunkStats(hunksByPath.value[path] ?? []);
  if (s.conflicts === 0) {
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
        <p class="muted resolve-tip">三栏对照选择，结果仅暂存，不写回仓库。</p>
        <div class="resolve-actions">
          <button
            type="button"
            class="btn"
            :disabled="allStats.conflicts === 0"
            @click="stashNow"
          >
            暂存结果
          </button>
          <button type="button" class="btn secondary" @click="resetStash">清除暂存</button>
          <span v-if="stashNote" class="stash-note">{{ stashNote }}</span>
        </div>
      </div>
    </div>

    <div class="resolve-layout">
      <aside class="resolve-files card">
        <h4>文件</h4>
        <ul>
          <li
            v-for="path in filePaths"
            :key="path"
            class="resolve-file"
            :class="{ active: path === activePath }"
            :title="path"
            @click="activePath = path"
          >
            <span class="mono path">{{ path.split("/").pop() }}</span>
            <span class="count">{{ fileResolvedCount(path) }}</span>
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
                title="采用当前冲突的左侧"
                @click="activeHunk && acceptLeft(activeHunk)"
              >
                Accept Left
              </button>
              <button
                type="button"
                class="btn tiny"
                :disabled="!activeHunk || activeHunk.kind !== 'conflict'"
                title="采用当前冲突的右侧"
                @click="activeHunk && acceptRight(activeHunk)"
              >
                Accept Right
              </button>
              <span class="bar-sep" />
              <button
                type="button"
                class="btn secondary tiny"
                :disabled="fileStats.conflicts === 0"
                @click="acceptAll('left')"
              >
                全部左侧
              </button>
              <button
                type="button"
                class="btn secondary tiny"
                :disabled="fileStats.conflicts === 0"
                @click="acceptAll('right')"
              >
                全部右侧
              </button>
              <button
                type="button"
                class="btn secondary tiny"
                @click="resetCurrentFile"
              >
                重置本文件
              </button>
            </div>
          </div>

          <!-- WebStorm：左 | gutter | 结果 | gutter | 右 -->
          <div class="merge-ws">
            <header class="merge-ws-heads">
              <div class="merge-ws-head merge-ws-head--ours">
                Changes from {{ into }}
              </div>
              <div class="merge-ws-gutter-head" />
              <div class="merge-ws-head merge-ws-head--result">
                Result [{{ activeFile.path.split("/").pop() }}]
              </div>
              <div class="merge-ws-gutter-head" />
              <div class="merge-ws-head merge-ws-head--theirs">
                Changes from {{ from }}
              </div>
            </header>

            <div
              ref="scrollRootRef"
              class="merge-ws-body"
              @scroll="onMergeScroll"
            >
              <div
                v-for="h in hunks"
                :key="h.id"
                class="merge-ws-row"
                :class="rowClass(h)"
                :data-hunk-id="h.id"
                @click="selectHunk(h.id)"
              >
                <!-- 左：目标 -->
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
                      title="接受左侧到结果"
                      @click.stop="acceptLeft(h)"
                    >
                      {{ choseLeft(h) ? "✓" : "≫" }}
                    </button>
                    <button
                      v-if="!isConflictResolved(h)"
                      type="button"
                      class="gutter-btn gutter-btn--ignore"
                      title="忽略左侧"
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
                      title="忽略右侧"
                      @click.stop="ignoreRight(h)"
                    >
                      ×
                    </button>
                    <button
                      type="button"
                      class="gutter-btn gutter-btn--accept gutter-btn--from-right"
                      :class="{ 'gutter-btn--done': choseRight(h) }"
                      title="接受右侧到结果"
                      @click.stop="acceptRight(h)"
                    >
                      {{ choseRight(h) ? "✓" : "≪" }}
                    </button>
                  </template>
                </div>

                <!-- 右：待合并 -->
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
