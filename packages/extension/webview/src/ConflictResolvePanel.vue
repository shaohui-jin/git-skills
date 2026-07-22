<script setup lang="ts">
import { computed, ref, watch } from "vue";
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

const resolvedPreview = computed(() => applyChoices(segments.value));

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
}

watch(
  () =>
    [props.cwd, props.into, props.from, props.files.map((f) => f.path).join("\n")].join(
      "|",
    ),
  () => initFromFiles(),
  { immediate: true },
);

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
  if (!cur || cur.type !== "conflict") {
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
    [path]: list.map((s) => (s.type === "conflict" ? { ...s, choice } : s)),
  };
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
  stashNote.value = `已暂存 ${allStats.value.resolved}/${allStats.value.total} 处选择 · ${new Date(stash.updatedAt).toLocaleString()}`;
}

function resetStash(): void {
  clearStash(props.cwd, props.into, props.from);
  initFromFiles();
  stashNote.value = "已清除暂存";
}

function fileResolvedCount(path: string): string {
  const c = countConflicts(segmentsByPath.value[path] ?? []);
  if (c.total === 0) {
    return "无标记";
  }
  return `${c.resolved}/${c.total}`;
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
            已选 {{ allStats.resolved }} / {{ allStats.total }}
          </span>
        </div>
        <p class="muted resolve-tip">
          选择「目标侧 / 待合并侧 / Base」后可暂存，不写回仓库。
        </p>
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
        <h4>冲突文件</h4>
        <ul>
          <li
            v-for="path in filePaths"
            :key="path"
            class="resolve-file"
            :class="{ active: path === activePath }"
            @click="activePath = path"
          >
            <span class="mono path">{{ path }}</span>
            <span class="count">{{ fileResolvedCount(path) }}</span>
          </li>
        </ul>
      </aside>

      <div class="resolve-main">
        <div v-if="!activeFile" class="card empty">无冲突文件</div>
        <template v-else>
          <div class="card resolve-file-bar">
            <span class="mono">{{ activeFile.path }}</span>
            <span class="muted">本文件 {{ stats.resolved }}/{{ stats.total }}</span>
            <div class="resolve-file-actions">
              <button type="button" class="btn secondary tiny" @click="acceptAll('ours')">
                全部用目标
              </button>
              <button type="button" class="btn secondary tiny" @click="acceptAll('theirs')">
                全部用待合并
              </button>
            </div>
          </div>

          <div
            v-for="seg in segments"
            :key="seg.id"
            class="card"
            :class="seg.type === 'conflict' ? 'conflict-block' : 'text-block'"
          >
            <template v-if="seg.type === 'text'">
              <div class="muted block-label">共同内容</div>
              <pre class="code-pane">{{ seg.content }}</pre>
            </template>
            <template v-else>
              <div class="conflict-head">
                <span class="badge danger">冲突 {{ seg.id.replace("c-", "#") }}</span>
                <span v-if="seg.choice" class="badge ok">
                  已选：{{
                    seg.choice === "ours"
                      ? "目标侧"
                      : seg.choice === "theirs"
                        ? "待合并侧"
                        : "Base"
                  }}
                </span>
                <span v-else class="badge warn">未解决</span>
                <div class="conflict-btns">
                  <button
                    type="button"
                    class="btn tiny"
                    :class="{ secondary: seg.choice !== 'ours' }"
                    @click="setChoice(seg, 'ours')"
                  >
                    使用目标侧
                  </button>
                  <button
                    type="button"
                    class="btn tiny"
                    :class="{ secondary: seg.choice !== 'theirs' }"
                    @click="setChoice(seg, 'theirs')"
                  >
                    使用待合并侧
                  </button>
                  <button
                    v-if="seg.base.length > 0"
                    type="button"
                    class="btn tiny"
                    :class="{ secondary: seg.choice !== 'base' }"
                    @click="setChoice(seg, 'base')"
                  >
                    使用 Base
                  </button>
                  <button
                    v-if="seg.choice"
                    type="button"
                    class="btn secondary tiny"
                    @click="clearChoice(seg)"
                  >
                    取消选择
                  </button>
                </div>
              </div>
              <div class="conflict-cols" :class="{ 'has-base': seg.base.length > 0 }">
                <div class="side ours" :class="{ picked: seg.choice === 'ours' }">
                  <div class="side-title">目标 （{{ into }}）</div>
                  <pre class="code-pane">{{ seg.ours || "（空）" }}</pre>
                </div>
                <div
                  v-if="seg.base.length > 0"
                  class="side base"
                  :class="{ picked: seg.choice === 'base' }"
                >
                  <div class="side-title">Base</div>
                  <pre class="code-pane">{{ seg.base || "（空）" }}</pre>
                </div>
                <div class="side theirs" :class="{ picked: seg.choice === 'theirs' }">
                  <div class="side-title">待合并 （{{ from }}）</div>
                  <pre class="code-pane">{{ seg.theirs || "（空）" }}</pre>
                </div>
              </div>
            </template>
          </div>

          <div class="card">
            <h4>合并结果预览（本文件）</h4>
            <pre class="code-pane result-pane">{{ resolvedPreview }}</pre>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
