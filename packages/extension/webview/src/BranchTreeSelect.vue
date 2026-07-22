<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { buildBranchTree, type BranchOption } from "./graph/branchTree";

const props = defineProps<{
  modelValue: string;
  branches: BranchOption[];
  placeholder?: string;
  disabled?: boolean;
}>();

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
const panelStyle = ref<Record<string, string>>({});
/** 键盘高亮在可见叶子中的下标；-1 表示仍在输入框 */
const activeIndex = ref(-1);

const tree = computed(() => buildBranchTree(props.branches));

const filtered = computed(() => {
  const q = filter.value.trim().toLowerCase();
  if (!q) {
    return tree.value;
  }
  const local = tree.value.local.filter(
    (b) => b.full.toLowerCase().includes(q) || b.name.toLowerCase().includes(q),
  );
  const remotes = tree.value.remotes
    .map((g) => ({
      remote: g.remote,
      branches: g.branches.filter(
        (b) =>
          b.full.toLowerCase().includes(q) ||
          b.name.toLowerCase().includes(q) ||
          g.remote.toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.branches.length > 0);
  return { local, remotes };
});

/** 当前筛选结果中的全部叶子（不因折叠而跳过，上下键能扫过每一项） */
const flatLeaves = computed(() => {
  const list: Array<{ full: string; name: string }> = [];
  for (const b of filtered.value.local) {
    list.push(b);
  }
  for (const g of filtered.value.remotes) {
    for (const b of g.branches) {
      list.push(b);
    }
  }
  return list;
});

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
  const maxH = Math.min(280, window.innerHeight - r.bottom - 12);
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

function ensureExpandedForIndex(index: number): void {
  const leaf = flatLeaves.value[index];
  if (!leaf) {
    return;
  }
  // 本地
  if (filtered.value.local.some((b) => b.full === leaf.full)) {
    expandedLocal.value = true;
    return;
  }
  // 远程：展开对应 remote 组
  for (const g of filtered.value.remotes) {
    if (g.branches.some((b) => b.full === leaf.full)) {
      expandedRemotes.value[g.remote] = true;
      return;
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
    // 到顶/到底不再循环，避免「跳到另一头」
    if (next < 0) {
      next = 0;
    } else if (next >= n) {
      next = n - 1;
    }
  }
  activeIndex.value = next;
  ensureExpandedForIndex(next);
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
        {{ modelValue || placeholder || "选择分支…" }}
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
              <span class="tree-count">{{ filtered.local.length }}</span>
            </button>
            <ul v-show="expandedLocal" class="tree-children">
              <li
                v-for="b in filtered.local"
                :key="b.full"
                class="tree-leaf"
                :class="{
                  active: b.full === modelValue,
                  'kbd-active':
                    activeIndex >= 0 && flatLeaves[activeIndex]?.full === b.full,
                }"
                @click="select(b.full)"
                @mouseenter="
                  activeIndex = flatLeaves.findIndex((x) => x.full === b.full)
                "
              >
                {{ b.name }}
              </li>
            </ul>
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
                <span class="tree-count">{{ g.branches.length }}</span>
              </button>
              <ul v-show="expandedRemotes[g.remote]" class="tree-children nested">
                <li
                  v-for="b in g.branches"
                  :key="b.full"
                  class="tree-leaf"
                  :class="{
                    active: b.full === modelValue,
                    'kbd-active':
                      activeIndex >= 0 && flatLeaves[activeIndex]?.full === b.full,
                  }"
                  :title="b.full"
                  @click="select(b.full)"
                  @mouseenter="
                    activeIndex = flatLeaves.findIndex((x) => x.full === b.full)
                  "
                >
                  {{ b.name }}
                </li>
              </ul>
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
