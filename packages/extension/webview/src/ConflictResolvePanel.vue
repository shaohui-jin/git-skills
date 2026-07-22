<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  applyChoices,
  countConflicts,
  parseConflictContent,
  type ConflictChoice,
  type ConflictSegment,
  type MergeSegment,
} from "./conflict/parseConflict";
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
const segmentsByPath = ref<Record<string, MergeSegment[]>>({});
const stashNote = ref("");
/** 当前聚焦的冲突块，用于导航与高亮 */
const activeConflictId = ref<string | null>(null);

const leftPaneRef = ref<HTMLElement | null>(null);
const midPaneRef = ref<HTMLElement | null>(null);
const rightPaneRef = ref<HTMLElement | null>(null);
let syncingScroll = false;

const filePaths = computed(() => props.files.map((f) => f.path));

const activeFile = computed(
  () => props.files.find((f) => f.path === activePath.value) ?? props.files[0],
);

const segments = computed(() => {
  const path = activeFile.value?.path;
  if (!path) {
    return [] as MergeSegment[];
  }
  return segmentsByPath.value[path] ?? [];
});

const conflictSegments = computed(() =>
  segments.value.filter((s): s is ConflictSegment => s.type === "conflict"),
);

const stats = computed(() => countConflicts(segments.value));

const allStats = computed(() => {
  let total = 0;
  let resolved = 0;
  for (const path of Object.keys(segmentsByPath.value)) {
    const c = countConflicts(segmentsByPath.value[path] ?? []);
    total += c.total;
    resolved += c.resolved;
  }
  return { total, resolved };
});

/** 当前文件：冲突处数 + 两侧差异行数（粗略） */
const fileDiffStats = computed(() => {
  let oursLines = 0;
  let theirsLines = 0;
  for (const c of conflictSegments.value) {
    oursLines += c.ours ? c.ours.split("\n").length : 0;
    theirsLines += c.theirs ? c.theirs.split("\n").length : 0;
  }
  return {
    conflicts: stats.value.total,
    resolved: stats.value.resolved,
    pending: Math.max(0, stats.value.total - stats.value.resolved),
    oursLines,
    theirsLines,
  };
});

const hasBaseOption = computed(() =>
  conflictSegments.value.some((c) => c.base.trim().length > 0),
);

const activeConflict = computed(() => {
  const id = activeConflictId.value;
  if (!id) {
    return null;
  }
  return conflictSegments.value.find((c) => c.id === id) ?? null;
});

const activeConflictIndex = computed(() => {
  if (!activeConflictId.value) {
    return -1;
  }
  return conflictSegments.value.findIndex((c) => c.id === activeConflictId.value);
});

function initFromFiles(): void {
  const next: Record<string, MergeSegment[]> = {};
  for (const f of props.files) {
    let segs = parseConflictContent(f.conflictContent);
    if (segs.length === 0 && (f.oursContent != null || f.theirsContent != null)) {
      segs = [
        {
          id: "c-0",
          type: "conflict",
          ours: f.oursContent ?? "",
          base: f.baseContent ?? "",
          theirs: f.theirsContent ?? "",
          choice: null,
        },
      ];
    }
    next[f.path] = segs;
  }
  const stash = loadStash(props.cwd, props.into, props.from);
  if (stash) {
    for (const [path, fileStash] of Object.entries(stash.files)) {
      const segs = next[path];
      if (!segs) {
        continue;
      }
      for (const seg of segs) {
        if (seg.type === "conflict" && fileStash.choices[seg.id]) {
          seg.choice = fileStash.choices[seg.id]!;
        }
      }
    }
    stashNote.value = `已加载暂存（${new Date(stash.updatedAt).toLocaleString()}）`;
  } else {
    stashNote.value = "";
  }
  segmentsByPath.value = next;
  activePath.value = props.files[0]?.path ?? "";
  const first = next[activePath.value]?.find((s) => s.type === "conflict");
  activeConflictId.value = first?.id ?? null;
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
  const first = conflictSegments.value[0];
  activeConflictId.value = first?.id ?? null;
});

function setChoice(seg: ConflictSegment, choice: ConflictChoice): void {
  const path = activePath.value;
  const list = segmentsByPath.value[path];
  if (!list) {
    return;
  }
  const idx = list.findIndex((s) => s.id === seg.id);
  if (idx < 0) {
    return;
  }
  const cur = list[idx];
  if (!cur || cur.type !== "conflict") {
    return;
  }
  const updated = [...list];
  updated[idx] = { ...cur, choice };
  segmentsByPath.value = { ...segmentsByPath.value, [path]: updated };
  activeConflictId.value = seg.id;
}

function clearChoice(seg: ConflictSegment): void {
  const path = activePath.value;
  const list = segmentsByPath.value[path];
  if (!list) {
    return;
  }
  const idx = list.findIndex((s) => s.id === seg.id);
  if (idx < 0) {
    return;
  }
  const cur = list[idx];
  if (!cur || cur.type === "text") {
    return;
  }
  const updated = [...list];
  updated[idx] = { ...cur, choice: null };
  segmentsByPath.value = { ...segmentsByPath.value, [path]: updated };
}

function acceptAll(choice: ConflictChoice): void {
  const path = activePath.value;
  const list = segmentsByPath.value[path];
  if (!list) {
    return;
  }
  segmentsByPath.value = {
    ...segmentsByPath.value,
    [path]: list.map((s) =>
      s.type === "conflict"
        ? {
            ...s,
            choice:
              choice === "base" && s.base.trim().length === 0 ? s.choice : choice,
          }
        : s,
    ),
  };
}

function acceptCurrent(choice: ConflictChoice): void {
  const seg = activeConflict.value;
  if (!seg) {
    return;
  }
  if (choice === "base" && seg.base.trim().length === 0) {
    return;
  }
  setChoice(seg, choice);
}

function resetCurrentFile(): void {
  const path = activePath.value;
  const list = segmentsByPath.value[path];
  if (!list) {
    return;
  }
  segmentsByPath.value = {
    ...segmentsByPath.value,
    [path]: list.map((s) => (s.type === "conflict" ? { ...s, choice: null } : s)),
  };
}

function goConflict(delta: number): void {
  const list = conflictSegments.value;
  if (list.length === 0) {
    return;
  }
  let idx = activeConflictIndex.value;
  if (idx < 0) {
    idx = delta > 0 ? -1 : 0;
  }
  const next = Math.max(0, Math.min(list.length - 1, idx + delta));
  activeConflictId.value = list[next]!.id;
  void nextTick(() => scrollToActiveConflict());
}

function scrollToActiveConflict(): void {
  const id = activeConflictId.value;
  if (!id) {
    return;
  }
  for (const root of [leftPaneRef.value, midPaneRef.value, rightPaneRef.value]) {
    const el = root?.querySelector(`[data-conflict-id="${id}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}

function onPaneScroll(source: "left" | "mid" | "right", ev: Event): void {
  if (syncingScroll) {
    return;
  }
  const target = ev.target as HTMLElement;
  const ratio =
    target.scrollHeight <= target.clientHeight
      ? 0
      : target.scrollTop / (target.scrollHeight - target.clientHeight);
  const others: Array<HTMLElement | null> = [
    source === "left" ? null : leftPaneRef.value,
    source === "mid" ? null : midPaneRef.value,
    source === "right" ? null : rightPaneRef.value,
  ];
  syncingScroll = true;
  for (const pane of others) {
    if (!pane) {
      continue;
    }
    const max = pane.scrollHeight - pane.clientHeight;
    pane.scrollTop = max > 0 ? ratio * max : 0;
  }
  requestAnimationFrame(() => {
    syncingScroll = false;
  });
}

function buildStash(): StashedMergeResolve {
  const files: StashedMergeResolve["files"] = {};
  for (const [path, segs] of Object.entries(segmentsByPath.value)) {
    const choices: Record<string, ConflictChoice> = {};
    for (const s of segs) {
      if (s.type === "conflict" && s.choice) {
        choices[s.id] = s.choice;
      }
    }
    files[path] = {
      path,
      choices,
      resolvedContent: applyChoices(segs),
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
  stashNote.value = `已暂存 ${allStats.value.resolved}/${allStats.value.total} 处 · ${new Date(stash.updatedAt).toLocaleString()}`;
}

function resetStash(): void {
  clearStash(props.cwd, props.into, props.from);
  initFromFiles();
  stashNote.value = "已清除暂存";
}

function fileResolvedCount(path: string): string {
  const c = countConflicts(segmentsByPath.value[path] ?? []);
  if (c.total === 0) {
    return "—";
  }
  return `${c.resolved}/${c.total}`;
}

function choiceLabel(choice: ConflictChoice | null): string {
  if (choice === "ours") {
    return "左侧";
  }
  if (choice === "theirs") {
    return "右侧";
  }
  if (choice === "base") {
    return "Base";
  }
  return "未解决";
}

function selectConflict(id: string): void {
  activeConflictId.value = id;
}
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
            :class="allStats.resolved >= allStats.total && allStats.total ? 'ok' : 'danger'"
          >
            全部 {{ allStats.resolved }} / {{ allStats.total }}
          </span>
        </div>
        <p class="muted resolve-tip">三栏对照选择，结果仅暂存，不写回仓库。</p>
        <div class="resolve-actions">
          <button type="button" class="btn" :disabled="allStats.total === 0" @click="stashNow">
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
          <!-- 第一行：统计 + 快捷操作（对齐 WebStorm Merge 工具栏） -->
          <div class="resolve-main-bar card">
            <div class="resolve-main-bar-left">
              <span class="mono file-name" :title="activeFile.path">{{ activeFile.path }}</span>
              <span class="stat-pill">
                冲突 <strong>{{ fileDiffStats.conflicts }}</strong>
              </span>
              <span class="stat-pill" :class="fileDiffStats.pending === 0 ? 'ok' : 'warn'">
                已解决 <strong>{{ fileDiffStats.resolved }}</strong> /
                {{ fileDiffStats.conflicts }}
              </span>
              <span class="stat-pill muted-pill">
                两侧行 {{ fileDiffStats.oursLines }} / {{ fileDiffStats.theirsLines }}
              </span>
              <span v-if="activeConflictIndex >= 0" class="stat-pill muted-pill">
                当前 #{{ activeConflictIndex + 1 }}
              </span>
            </div>
            <div class="resolve-main-bar-right">
              <button
                type="button"
                class="btn secondary tiny"
                :disabled="conflictSegments.length === 0"
                title="上一处冲突"
                @click="goConflict(-1)"
              >
                ↑ 上一处
              </button>
              <button
                type="button"
                class="btn secondary tiny"
                :disabled="conflictSegments.length === 0"
                title="下一处冲突"
                @click="goConflict(1)"
              >
                ↓ 下一处
              </button>
              <span class="bar-sep" />
              <button
                type="button"
                class="btn tiny"
                :disabled="!activeConflict"
                title="Resolve using Left（采用目标侧）"
                @click="acceptCurrent('ours')"
              >
                采用左侧
              </button>
              <button
                type="button"
                class="btn tiny"
                :disabled="!activeConflict"
                title="Resolve using Right（采用待合并侧）"
                @click="acceptCurrent('theirs')"
              >
                采用右侧
              </button>
              <button
                v-if="hasBaseOption"
                type="button"
                class="btn secondary tiny"
                :disabled="!activeConflict || !activeConflict.base.trim()"
                title="使用 merge-base 版本"
                @click="acceptCurrent('base')"
              >
                采用 Base
              </button>
              <button
                type="button"
                class="btn secondary tiny"
                :disabled="!activeConflict?.choice"
                title="取消当前冲突的选择"
                @click="activeConflict && clearChoice(activeConflict)"
              >
                撤销当前
              </button>
              <span class="bar-sep" />
              <button
                type="button"
                class="btn secondary tiny"
                :disabled="stats.total === 0"
                title="Accept Yours：本文件全部用目标侧"
                @click="acceptAll('ours')"
              >
                全部左侧
              </button>
              <button
                type="button"
                class="btn secondary tiny"
                :disabled="stats.total === 0"
                title="Accept Theirs：本文件全部用待合并侧"
                @click="acceptAll('theirs')"
              >
                全部右侧
              </button>
              <button
                type="button"
                class="btn secondary tiny"
                :disabled="stats.resolved === 0"
                title="清空本文件全部选择"
                @click="resetCurrentFile"
              >
                重置本文件
              </button>
            </div>
          </div>

          <!-- 第二行：左 | 结果 | 右 -->
          <div class="merge-triptych">
            <section class="merge-pane merge-pane--ours">
              <header class="merge-pane-head">
                <span class="pane-role">左侧 · 目标</span>
                <span class="mono pane-branch">{{ into }}</span>
              </header>
              <div
                ref="leftPaneRef"
                class="merge-pane-body"
                @scroll="onPaneScroll('left', $event)"
              >
                <template v-for="seg in segments" :key="'L-' + seg.id">
                  <pre v-if="seg.type === 'text'" class="merge-text">{{ seg.content }}</pre>
                  <div
                    v-else
                    class="merge-hunk"
                    :class="{
                      active: seg.id === activeConflictId,
                      picked: seg.choice === 'ours',
                    }"
                    :data-conflict-id="seg.id"
                    @click="selectConflict(seg.id)"
                  >
                    <div class="merge-hunk-gutter">
                      <button
                        type="button"
                        class="chevron-accept"
                        title="采用左侧到结果"
                        @click.stop="setChoice(seg, 'ours')"
                      >
                        ≫
                      </button>
                      <span class="hunk-tag">{{ choiceLabel(seg.choice) }}</span>
                    </div>
                    <pre class="merge-hunk-code">{{ seg.ours || "（空）" }}</pre>
                  </div>
                </template>
              </div>
            </section>

            <section class="merge-pane merge-pane--result">
              <header class="merge-pane-head">
                <span class="pane-role">中间 · 结果</span>
                <span class="muted pane-branch">合并预览</span>
              </header>
              <div
                ref="midPaneRef"
                class="merge-pane-body"
                @scroll="onPaneScroll('mid', $event)"
              >
                <template v-for="seg in segments" :key="'M-' + seg.id">
                  <pre v-if="seg.type === 'text'" class="merge-text">{{ seg.content }}</pre>
                  <div
                    v-else
                    class="merge-hunk merge-hunk--result"
                    :class="{
                      active: seg.id === activeConflictId,
                      resolved: !!seg.choice,
                      unresolved: !seg.choice,
                    }"
                    :data-conflict-id="seg.id"
                    @click="selectConflict(seg.id)"
                  >
                    <div class="merge-hunk-gutter">
                      <span class="hunk-tag">{{ choiceLabel(seg.choice) }}</span>
                    </div>
                    <pre v-if="seg.choice === 'ours'" class="merge-hunk-code side-tint-ours">{{
                      seg.ours || "（空）"
                    }}</pre>
                    <pre
                      v-else-if="seg.choice === 'theirs'"
                      class="merge-hunk-code side-tint-theirs"
                      >{{ seg.theirs || "（空）" }}</pre
                    >
                    <pre
                      v-else-if="seg.choice === 'base'"
                      class="merge-hunk-code side-tint-base"
                      >{{ seg.base || "（空）" }}</pre
                    >
                    <pre v-else class="merge-hunk-code unresolved-code">{{
                      [
                        "<<<<<<< 未解决",
                        seg.ours,
                        "=======",
                        seg.theirs,
                        ">>>>>>>",
                      ].join("\n")
                    }}</pre>
                  </div>
                </template>
              </div>
            </section>

            <section class="merge-pane merge-pane--theirs">
              <header class="merge-pane-head">
                <span class="pane-role">右侧 · 待合并</span>
                <span class="mono pane-branch">{{ from }}</span>
              </header>
              <div
                ref="rightPaneRef"
                class="merge-pane-body"
                @scroll="onPaneScroll('right', $event)"
              >
                <template v-for="seg in segments" :key="'R-' + seg.id">
                  <pre v-if="seg.type === 'text'" class="merge-text">{{ seg.content }}</pre>
                  <div
                    v-else
                    class="merge-hunk"
                    :class="{
                      active: seg.id === activeConflictId,
                      picked: seg.choice === 'theirs',
                    }"
                    :data-conflict-id="seg.id"
                    @click="selectConflict(seg.id)"
                  >
                    <div class="merge-hunk-gutter">
                      <button
                        type="button"
                        class="chevron-accept chevron-accept--left"
                        title="采用右侧到结果"
                        @click.stop="setChoice(seg, 'theirs')"
                      >
                        ≪
                      </button>
                      <span class="hunk-tag">{{ choiceLabel(seg.choice) }}</span>
                    </div>
                    <pre class="merge-hunk-code">{{ seg.theirs || "（空）" }}</pre>
                  </div>
                </template>
              </div>
            </section>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
