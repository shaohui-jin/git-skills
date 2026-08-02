<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  buildBranchTree,
  branchDisplayLabel,
  filterPathTree,
  findBranchByGitRef,
  flattenPathTree,
  type BranchOption,
} from "./graph/branchTree";
import PathTreeNodes from "./PathTreeNodes.vue";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    branches: BranchOption[];
    placeholder?: string;
    disabled?: boolean;
    /** 只展示远程跟踪分支（目标分支用） */
    remoteOnly?: boolean;
  }>(),
  { remoteOnly: false },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const filterRef = ref<HTMLInputElement | null>(null);
const bodyRef = ref<HTMLElement | null>(null);
const filter = ref("");
const expandedLocal = ref(true);
const expandedRemotes = ref<Record<string, boolean>>({});
/** 路径文件夹展开：key 如 `remote:origin/npm_and_yarn`；默认折叠 */
const expandedFolders = ref<Record<string, boolean>>({});
const panelStyle = ref<Record<string, string>>({});
const activeIndex = ref(-1);

const effectiveBranches = computed(() =>
  props.remoteOnly ? props.branches.filter((b) => b.remote) : props.branches,
);

const tree = computed(() => buildBranchTree(effectiveBranches.value));

const triggerLabel = computed(() => {
  if (!props.modelValue) {
    return "";
  }
  const hit = findBranchByGitRef(effectiveBranches.value, props.modelValue);
  return hit ? branchDisplayLabel(hit) : props.modelValue;
});

const filtered = computed(() => {
  const q = filter.value.trim();
  const base = props.remoteOnly
    ? { ...tree.value, local: [] as typeof tree.value.local, localLeafCount: 0 }
    : tree.value;
  if (!q) {
    return base;
  }
  const local = props.remoteOnly ? [] : filterPathTree(base.local, q);
  const remotes = base.remotes
    .map((g) => {
      const t = filterPathTree(g.tree, q);
      return {
        remote: g.remote,
        tree: t,
        leafCount: flattenPathTree(t).length,
      };
    })
    .filter((g) => g.leafCount > 0);
  return {
    local,
    localLeafCount: flattenPathTree(local).length,
    remotes,
  };
});

const flatLeaves = computed(() => {
  const list: Array<{ full: string; label: string }> = [];
  list.push(...flattenPathTree(filtered.value.local));
  for (const g of filtered.value.remotes) {
    list.push(...flattenPathTree(g.tree));
  }
  return list;
});

const activeFull = computed(() =>
  activeIndex.value >= 0 ? (flatLeaves.value[activeIndex.value]?.full ?? null) : null,
);

watch(
  () => tree.value.remotes,
  (groups) => {
    for (const g of groups) {
      if (expandedRemotes.value[g.remote] === undefined) {
        expandedRemotes.value[g.remote] = true;
      }
    }
  },
  { immediate: true },
);

/** 筛选时自动展开命中路径上的文件夹 */
watch(
  filtered,
  (f) => {
    if (!filter.value.trim()) {
      return;
    }
    const expandAll = (nodes: typeof f.local, prefix: string) => {
      for (const n of nodes) {
        if (n.children.length > 0) {
          const key = `${prefix}/${n.segment}`;
          expandedFolders.value[key] = true;
          expandAll(n.children, key);
        }
      }
    };
    expandAll(f.local, "local");
    for (const g of f.remotes) {
      expandedRemotes.value[g.remote] = true;
      expandAll(g.tree, `remote:${g.remote}`);
    }
  },
  { deep: true },
);

watch(filter, () => {
  activeIndex.value = -1;
});

watch(flatLeaves, (leaves) => {
  if (activeIndex.value >= leaves.length) {
    activeIndex.value = leaves.length > 0 ? leaves.length - 1 : -1;
  }
});

async function placePanel(): Promise<void> {
  await nextTick();
  const trigger = rootRef.value;
  if (!trigger) {
    return;
  }
  const r = trigger.getBoundingClientRect();
  const maxH = Math.min(320, window.innerHeight - r.bottom - 12);
  panelStyle.value = {
    position: "fixed",
    left: `${Math.max(8, r.left)}px`,
    top: `${r.bottom + 4}px`,
    width: `${r.width}px`,
    maxHeight: `${Math.max(160, maxH)}px`,
    zIndex: "1000",
  };
}

async function focusFilter(): Promise<void> {
  await nextTick();
  filterRef.value?.focus();
  filterRef.value?.select();
}

function select(full: string): void {
  emit("update:modelValue", full);
  open.value = false;
  filter.value = "";
  activeIndex.value = -1;
}

function toggleFolder(key: string): void {
  expandedFolders.value[key] = !expandedFolders.value[key];
}

async function openPanel(): Promise<void> {
  open.value = true;
  filter.value = "";
  activeIndex.value = -1;
  await placePanel();
  await focusFilter();
}

function closePanel(): void {
  open.value = false;
  filter.value = "";
  activeIndex.value = -1;
}

async function toggle(): Promise<void> {
  if (props.disabled) {
    return;
  }
  if (open.value) {
    closePanel();
  } else {
    await openPanel();
  }
}

function scrollActiveIntoView(): void {
  void nextTick(() => {
    const el = bodyRef.value?.querySelector<HTMLElement>(".tree-leaf.kbd-active");
    el?.scrollIntoView({ block: "nearest" });
  });
}

function expandPathToFull(full: string): void {
  const localHit = flattenPathTree(filtered.value.local).some((x) => x.full === full);
  if (localHit) {
    expandedLocal.value = true;
    // 展开 local 下路径
    for (const leaf of flattenPathTree(tree.value.local)) {
      if (leaf.full !== full) {
        continue;
      }
      const parts = leaf.label.split("/");
      let prefix = "local";
      for (let i = 0; i < parts.length - 1; i++) {
        prefix = `${prefix}/${parts[i]}`;
        expandedFolders.value[prefix] = true;
      }
    }
    return;
  }
  for (const g of filtered.value.remotes) {
    if (!flattenPathTree(g.tree).some((x) => x.full === full)) {
      continue;
    }
    expandedRemotes.value[g.remote] = true;
    for (const leaf of flattenPathTree(g.tree)) {
      if (leaf.full !== full) {
        continue;
      }
      const parts = leaf.label.split("/");
      let prefix = `remote:${g.remote}`;
      for (let i = 0; i < parts.length - 1; i++) {
        prefix = `${prefix}/${parts[i]}`;
        expandedFolders.value[prefix] = true;
      }
    }
  }
}

function moveActive(delta: number): void {
  const n = flatLeaves.value.length;
  if (n === 0) {
    activeIndex.value = -1;
    return;
  }
  let next: number;
  if (activeIndex.value < 0) {
    next = delta > 0 ? 0 : n - 1;
  } else {
    next = activeIndex.value + delta;
    if (next < 0) {
      next = 0;
    } else if (next >= n) {
      next = n - 1;
    }
  }
  activeIndex.value = next;
  const leaf = flatLeaves.value[next];
  if (leaf) {
    expandPathToFull(leaf.full);
  }
  scrollActiveIntoView();
}

function onFilterKeydown(ev: KeyboardEvent): void {
  if (ev.key === "ArrowDown") {
    ev.preventDefault();
    ev.stopPropagation();
    moveActive(1);
    return;
  }
  if (ev.key === "ArrowUp") {
    ev.preventDefault();
    ev.stopPropagation();
    moveActive(-1);
    return;
  }
  if (ev.key === "Enter") {
    ev.preventDefault();
    ev.stopPropagation();
    const hit =
      activeIndex.value >= 0
        ? flatLeaves.value[activeIndex.value]
        : flatLeaves.value.length === 1
          ? flatLeaves.value[0]
          : undefined;
    if (hit) {
      select(hit.full);
    }
    return;
  }
  if (ev.key === "Escape") {
    ev.preventDefault();
    ev.stopPropagation();
    closePanel();
  }
}

function onDocClick(ev: MouseEvent): void {
  const t = ev.target as Node;
  if (rootRef.value?.contains(t) || panelRef.value?.contains(t)) {
    return;
  }
  closePanel();
}

function onScrollOrResize(): void {
  if (open.value) {
    void placePanel();
  }
}

onMounted(() => {
  document.addEventListener("mousedown", onDocClick);
  window.addEventListener("resize", onScrollOrResize);
  window.addEventListener("scroll", onScrollOrResize, true);
});

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocClick);
  window.removeEventListener("resize", onScrollOrResize);
  window.removeEventListener("scroll", onScrollOrResize, true);
});
</script>

<template>
  <div ref="rootRef" class="tree-select" :class="{ open, disabled }">
    <button
      type="button"
      class="tree-select-trigger"
      :disabled="disabled"
      @click="toggle"
    >
      <span class="tree-select-value" :class="{ placeholder: !modelValue }">
        {{ triggerLabel || placeholder || "选择分支…" }}
      </span>
      <span class="tree-select-arrow">▾</span>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="panelRef"
        class="tree-select-panel"
        :style="panelStyle"
      >
        <input
          ref="filterRef"
          v-model="filter"
          class="tree-select-filter"
          type="text"
          placeholder="筛选分支…"
          autocomplete="off"
          @click.stop
          @keydown="onFilterKeydown"
        />

        <div ref="bodyRef" class="tree-select-body">
          <div v-if="filtered.local.length" class="tree-group">
            <button
              type="button"
              class="tree-group-title"
              tabindex="-1"
              @click="expandedLocal = !expandedLocal"
            >
              <span class="tree-caret">{{ expandedLocal ? "▾" : "▸" }}</span>
              本地
              <span class="tree-count">{{ filtered.localLeafCount }}</span>
            </button>
            <PathTreeNodes
              v-if="expandedLocal"
              :nodes="filtered.local"
              :model-value="modelValue"
              expand-key-prefix="local"
              :expanded="expandedFolders"
              :active-full="activeFull"
              @select="select"
              @toggle="toggleFolder"
              @hover="(full) => (activeIndex = flatLeaves.findIndex((x) => x.full === full))"
            />
          </div>

          <div v-if="filtered.remotes.length" class="tree-group">
            <div class="tree-group-title static">远程</div>
            <div
              v-for="g in filtered.remotes"
              :key="g.remote"
              class="tree-remote"
            >
              <button
                type="button"
                class="tree-group-title nested"
                tabindex="-1"
                @click="expandedRemotes[g.remote] = !expandedRemotes[g.remote]"
              >
                <span class="tree-caret">{{
                  expandedRemotes[g.remote] ? "▾" : "▸"
                }}</span>
                {{ g.remote }}
                <span class="tree-count">{{ g.leafCount }}</span>
              </button>
              <PathTreeNodes
                v-if="expandedRemotes[g.remote]"
                :nodes="g.tree"
                :model-value="modelValue"
                :expand-key-prefix="`remote:${g.remote}`"
                :expanded="expandedFolders"
                :active-full="activeFull"
                @select="select"
                @toggle="toggleFolder"
                @hover="(full) => (activeIndex = flatLeaves.findIndex((x) => x.full === full))"
              />
            </div>
          </div>

          <div
            v-if="!filtered.local.length && !filtered.remotes.length"
            class="tree-empty"
          >
            无匹配分支
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
