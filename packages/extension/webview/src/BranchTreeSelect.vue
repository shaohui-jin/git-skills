<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { buildBranchTree } from "./graph/branchTree";

const props = defineProps<{
  modelValue: string;
  branches: string[];
  placeholder?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const open = ref(false);
const rootRef = ref<HTMLElement | null>(null);
const panelRef = ref<HTMLElement | null>(null);
const filter = ref("");
const expandedLocal = ref(true);
const expandedRemotes = ref<Record<string, boolean>>({});
const panelStyle = ref<Record<string, string>>({});

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

function select(full: string): void {
  emit("update:modelValue", full);
  open.value = false;
  filter.value = "";
}

async function toggle(): Promise<void> {
  if (props.disabled) {
    return;
  }
  open.value = !open.value;
  if (open.value) {
    await placePanel();
  }
}

function onDocClick(ev: MouseEvent): void {
  const t = ev.target as Node;
  if (rootRef.value?.contains(t) || panelRef.value?.contains(t)) {
    return;
  }
  open.value = false;
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
          v-model="filter"
          class="tree-select-filter"
          type="text"
          placeholder="筛选分支…"
          @click.stop
        />

        <div class="tree-select-body">
          <div v-if="filtered.local.length" class="tree-group">
            <button
              type="button"
              class="tree-group-title"
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
                :class="{ active: b.full === modelValue }"
                @click="select(b.full)"
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
                  :class="{ active: b.full === modelValue }"
                  :title="b.full"
                  @click="select(b.full)"
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
