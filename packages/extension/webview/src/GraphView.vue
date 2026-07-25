<script setup lang="ts">
import { CanvasEvent, Graph, NodeEvent } from "@antv/g6";
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
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
const pathHint = ref("");
let resizeObserver: ResizeObserver | null = null;
let g6Data: G6GraphData | null = null;
let renderSeq = 0;
/** 底部 path-hint 预留 */
const HINT_RESERVE = 44;

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
  pathHint.value = "";
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

  const labels = [...chain].reverse().map(nodeLabel);
  pathHint.value =
    labels.length <= 1
      ? `已选：${labels[0] ?? startId}（已是根源）`
      : `到根源：${labels.join(" → ")}（高亮 ${nodeIds.size} 个分支）`;

  const tipName = tipNameFromNodeId(startId);
  if (tipName) {
    emit("select", { tipName, chain });
  } else {
    emit("select", { tipName: nodeLabel(startId), chain });
  }
}

async function destroyGraph(): Promise<void> {
  const g = graphInst.value;
  graphInst.value = null;
  g6Data = null;
  pathHint.value = "";
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
        stroke: "rgba(200,200,200,0.4)",
        lineWidth: 1.5,
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
          opacity: 0.08,
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

onMounted(() => {
  void renderGraph().then(bindResize);
});

onBeforeUnmount(() => {
  renderSeq += 1;
  resizeObserver?.disconnect();
  resizeObserver = null;
  void destroyGraph();
});

watch(
  () => props.graph,
  () => {
    void renderGraph();
  },
);
</script>

<template>
  <div ref="stageRef" class="graph-stage">
    <div ref="containerRef" class="graph-scroll graph-g6" />
    <div v-if="pathHint" class="path-hint" :title="pathHint">{{ pathHint }}</div>
    <div v-else class="path-hint path-hint--idle">
      点击分支：高亮到根源的链路并更新右侧报告 · 点击空白处恢复总览
    </div>
  </div>
</template>
