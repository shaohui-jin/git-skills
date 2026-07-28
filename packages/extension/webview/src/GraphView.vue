<script setup lang="ts">
import { CanvasEvent, Graph, NodeEvent } from "@antv/g6";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { pathToRoots } from "./graph/pathToRoot";
import {
  branchGraphToG6,
  kindColor,
  tipNameFromNodeId,
  type G6GraphData,
  type G6NodeKind,
} from "./graph/toG6Data";
import type { BranchGraph } from "./types";

const props = defineProps<{ graph: BranchGraph }>();

const emit = defineEmits<{
  /** chain: tip node ids from selected → root；null 表示清除 */
  select: [payload: { tipName: string; chain: string[] } | null];
}>();

const stageRef = ref<HTMLDivElement | null>(null);
const containerRef = ref<HTMLDivElement | null>(null);
const graphInst = shallowRef<Graph | null>(null);
let resizeObserver: ResizeObserver | null = null;
let g6Data: G6GraphData | null = null;
let renderSeq = 0;
/** 底部图例预留 */
const HINT_RESERVE = 56;

const searchOpen = ref(false);
const searchQuery = ref("");
const searchIndex = ref(0);

const LEGEND_TEXT =
  "点击分支：高亮到根源的链路并更新右侧报告 · 点击空白处恢复总览 · " +
  "绿色=本地分支 · 蓝色=远程跟踪分支 · 从左到右的连线：较近的 tip 祖先 → 子分支（非完整 commit 链） · Ctrl+F 搜索节点";

const searchHits = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  if (!q || !g6Data) {
    return [] as string[];
  }
  return g6Data.nodes
    .filter((n) => {
      const name = (n.data.tipName || n.data.label || "").toLowerCase();
      const sha = (n.data.sha || "").toLowerCase();
      const sub = (n.data.sub || "").toLowerCase();
      return name.includes(q) || sha.includes(q) || sub.includes(q);
    })
    .map((n) => n.id);
});

function nodeLabel(id: string): string {
  const n = g6Data?.nodes.find((x) => x.id === id);
  if (!n) {
    return tipNameFromNodeId(id) ?? id.slice(0, 7);
  }
  return n.data.tipName || n.data.label || id.slice(0, 7);
}

/** 用 stage 测尺寸：container 在 G6 destroy 后常被写成很小的 inline height */
function measureSize(): { width: number; height: number } {
  const stage = stageRef.value;
  const w = Math.max(120, stage?.clientWidth || containerRef.value?.clientWidth || 640);
  const stageH = stage?.clientHeight || 0;
  const h = Math.max(160, (stageH > 0 ? stageH : 360) - HINT_RESERVE);
  return { width: w, height: h };
}

function clearContainerInlineSize(): void {
  const el = containerRef.value;
  if (!el) {
    return;
  }
  el.style.width = "";
  el.style.height = "";
  el.style.minHeight = "";
  el.style.maxHeight = "";
}

function waitLayout(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
}

async function clearHighlight(g: Graph): Promise<void> {
  if (!g6Data) {
    return;
  }
  const states: Record<string, string[]> = {};
  for (const n of g6Data.nodes) {
    states[n.id] = [];
  }
  for (const e of g6Data.edges) {
    states[e.id] = [];
  }
  await g.setElementState(states);
  emit("select", null);
}

async function highlightPath(g: Graph, startId: string): Promise<void> {
  if (!g6Data) {
    return;
  }
  const { nodeIds, edgeIds, chain } = pathToRoots(startId, g6Data);
  const states: Record<string, string[]> = {};

  for (const n of g6Data.nodes) {
    if (n.id === startId) {
      states[n.id] = ["selected"];
    } else if (nodeIds.has(n.id)) {
      states[n.id] = ["highlight"];
    } else {
      states[n.id] = ["inactive"];
    }
  }
  for (const e of g6Data.edges) {
    states[e.id] = edgeIds.has(e.id) ? ["highlight"] : ["inactive"];
  }

  await g.setElementState(states);

  const tipName = tipNameFromNodeId(startId);
  if (tipName) {
    emit("select", { tipName, chain });
  } else {
    emit("select", { tipName: nodeLabel(startId), chain });
  }
}

async function focusNode(id: string): Promise<void> {
  const g = graphInst.value;
  if (!g || !g6Data) {
    return;
  }
  await highlightPath(g, id);
  try {
    // G6 v5：将元素移入视口中心
    await g.focusElement(id, { duration: 300 });
  } catch {
    // ignore — 高亮已完成，视口平移失败可接受
  }
}

function openSearch(): void {
  searchOpen.value = true;
  searchIndex.value = 0;
  void nextTick(() => {
    const el = stageRef.value?.querySelector<HTMLInputElement>(".graph-search-input");
    el?.focus();
    el?.select();
  });
}

function closeSearch(): void {
  searchOpen.value = false;
  searchQuery.value = "";
  searchIndex.value = 0;
}

async function goSearchHit(delta: number): Promise<void> {
  const hits = searchHits.value;
  if (!hits.length) {
    return;
  }
  const next = (searchIndex.value + delta + hits.length * 50) % hits.length;
  searchIndex.value = next;
  await focusNode(hits[next]!);
}

async function onSearchEnter(): Promise<void> {
  if (!searchHits.value.length) {
    return;
  }
  if (searchHits.value.length === 1) {
    searchIndex.value = 0;
    await focusNode(searchHits.value[0]!);
    return;
  }
  await goSearchHit(1);
}

function onStageKeydown(ev: KeyboardEvent): void {
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.key.toLowerCase() === "f") {
    ev.preventDefault();
    ev.stopPropagation();
    openSearch();
    return;
  }
  if (ev.key === "Escape" && searchOpen.value) {
    ev.preventDefault();
    closeSearch();
  }
}

async function destroyGraph(): Promise<void> {
  const g = graphInst.value;
  graphInst.value = null;
  g6Data = null;
  if (g) {
    try {
      g.destroy();
    } catch {
      // ignore
    }
  }
  clearContainerInlineSize();
}

async function applySizeAndFit(g: Graph): Promise<void> {
  const { width, height } = measureSize();
  if (width <= 0 || height <= 0) {
    return;
  }
  g.setSize(width, height);
  await g.fitView();
}

async function renderGraph(): Promise<void> {
  const seq = ++renderSeq;
  await nextTick();
  const el = containerRef.value;
  if (!el) {
    return;
  }

  await destroyGraph();
  if (seq !== renderSeq) {
    return;
  }
  emit("select", null);

  // 等 flex 布局恢复，避免第二次加载读到塌缩高度
  await waitLayout();
  if (seq !== renderSeq) {
    return;
  }
  clearContainerInlineSize();

  const data = branchGraphToG6(props.graph);
  g6Data = data;
  if (data.nodes.length === 0) {
    return;
  }

  const { width, height } = measureSize();

  const g = new Graph({
    container: el,
    width,
    height,
    data,
    autoFit: "view",
    padding: 32,
    theme: "dark",
    layout: {
      type: "dagre",
      rankdir: "LR",
      nodesep: 36,
      ranksep: 72,
      controlPoints: true,
    },
    node: {
      type: "rect",
      style: {
        size: [168, 44],
        radius: 6,
        labelText: (d) => {
          const sub = (d as { data?: { label?: string; sub?: string } }).data?.sub;
          const label = (d as { data?: { label?: string } }).data?.label ?? "";
          return sub ? `${label}\n${sub}` : label;
        },
        labelFill: "#ddd",
        labelFontSize: 11,
        labelFontFamily: "Consolas, monospace",
        labelPlacement: "center",
        fill: (d) => {
          const kind = ((d as { data?: { kind?: G6NodeKind } }).data?.kind ??
            "local-tip") as G6NodeKind;
          return kindColor(kind);
        },
        stroke: "rgba(255,255,255,0.25)",
        lineWidth: 1,
        opacity: 1,
      },
      state: {
        selected: {
          stroke: "#f0c674",
          lineWidth: 3,
          shadowColor: "#f0c674",
          shadowBlur: 12,
          opacity: 1,
        },
        highlight: {
          stroke: "#61afef",
          lineWidth: 2.5,
          opacity: 1,
        },
        inactive: {
          opacity: 0.18,
        },
      },
    },
    edge: {
      type: "cubic-horizontal",
      style: {
        // 未选中时也要和深色背景拉开对比
        stroke: "rgba(180, 198, 220, 0.85)",
        lineWidth: 2,
        endArrow: true,
        opacity: 1,
      },
      state: {
        highlight: {
          stroke: "#61afef",
          lineWidth: 3,
          opacity: 1,
          endArrow: true,
        },
        inactive: {
          opacity: 0.2,
        },
      },
    },
    behaviors: ["drag-canvas", "zoom-canvas", "drag-element"],
  });

  g.on(NodeEvent.CLICK, (evt) => {
    const id = String((evt.target as { id?: string }).id ?? "");
    if (!id) {
      return;
    }
    void highlightPath(g, id);
  });

  g.on(CanvasEvent.CLICK, () => {
    void clearHighlight(g);
  });

  graphInst.value = g;
  await g.render();
  if (seq !== renderSeq) {
    return;
  }

  // layout 完成后再按 stage 真实尺寸校正（防止 G6 写回错误 inline size）
  await waitLayout();
  if (seq !== renderSeq || graphInst.value !== g) {
    return;
  }
  clearContainerInlineSize();
  await applySizeAndFit(g);
}

function bindResize(): void {
  resizeObserver?.disconnect();
  const stage = stageRef.value;
  if (!stage) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  resizeObserver = new ResizeObserver(() => {
    if (timer) {
      clearTimeout(timer);
    }
    // 忽略 destroy 瞬间的 0 尺寸回调
    timer = setTimeout(() => {
      const g = graphInst.value;
      const { width, height } = measureSize();
      if (!g || width < 80 || height < 80) {
        return;
      }
      void applySizeAndFit(g);
    }, 50);
  });
  resizeObserver.observe(stage);
}

function onWindowKeydown(ev: KeyboardEvent): void {
  // webview 聚焦时拦截 Ctrl+F；宿主若已抢走快捷键可用右上角「搜索节点」
  if (!stageRef.value?.isConnected) {
    return;
  }
  onStageKeydown(ev);
}

onMounted(() => {
  void renderGraph().then(bindResize);
  stageRef.value?.addEventListener("keydown", onStageKeydown);
  window.addEventListener("keydown", onWindowKeydown);
});

onBeforeUnmount(() => {
  renderSeq += 1;
  stageRef.value?.removeEventListener("keydown", onStageKeydown);
  window.removeEventListener("keydown", onWindowKeydown);
  resizeObserver?.disconnect();
  resizeObserver = null;
  void destroyGraph();
});

watch(
  () => props.graph,
  () => {
    closeSearch();
    void renderGraph();
  },
);

watch(searchQuery, () => {
  searchIndex.value = 0;
});
</script>

<template>
  <div
    ref="stageRef"
    class="graph-stage"
    tabindex="0"
    title="在图上按 Ctrl+F 搜索分支节点"
  >
    <div ref="containerRef" class="graph-scroll graph-g6" />

    <button
      v-if="!searchOpen"
      type="button"
      class="btn secondary tiny graph-search-toggle"
      title="Ctrl+F"
      @click="openSearch"
    >
      搜索节点
    </button>

    <div v-if="searchOpen" class="graph-search" @mousedown.stop @click.stop>
      <input
        class="graph-search-input"
        type="search"
        :value="searchQuery"
        placeholder="搜索分支名 / sha…"
        @input="searchQuery = ($event.target as HTMLInputElement).value"
        @keydown.enter.prevent="onSearchEnter"
        @keydown.esc.prevent="closeSearch"
      />
      <span class="graph-search-meta muted">
        {{ searchHits.length ? `${Math.min(searchIndex + 1, searchHits.length)}/${searchHits.length}` : "0" }}
      </span>
      <button type="button" class="btn secondary tiny" :disabled="!searchHits.length" @click="goSearchHit(-1)">
        上一个
      </button>
      <button type="button" class="btn secondary tiny" :disabled="!searchHits.length" @click="goSearchHit(1)">
        下一个
      </button>
      <button type="button" class="btn secondary tiny" @click="closeSearch">关闭</button>
    </div>

    <div class="path-hint path-hint--idle" :title="LEGEND_TEXT">{{ LEGEND_TEXT }}</div>
  </div>
</template>
