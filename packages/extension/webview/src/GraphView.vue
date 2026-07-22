<script setup lang="ts">
import { CanvasEvent, Graph, NodeEvent } from "@antv/g6";
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { pathToRoots } from "./graph/pathToRoot";
import { branchGraphToG6, kindColor, type G6GraphData, type G6NodeKind } from "./graph/toG6Data";
import type { BranchGraph } from "./types";

const props = defineProps<{ graph: BranchGraph }>();

const stageRef = ref<HTMLDivElement | null>(null);
const containerRef = ref<HTMLDivElement | null>(null);
const graphInst = shallowRef<Graph | null>(null);
const pathHint = ref("");
let resizeObserver: ResizeObserver | null = null;
let g6Data: G6GraphData | null = null;

function nodeLabel(id: string): string {
  const n = g6Data?.nodes.find((x) => x.id === id);
  if (!n) {
    return id.slice(0, 7);
  }
  return n.data.tipName || n.data.label || id.slice(0, 7);
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

  // chain：当前 → … → 根；展示为左根源 → 右当前
  const labels = [...chain].reverse().map(nodeLabel);
  pathHint.value =
    labels.length <= 1
      ? `已选：${labels[0] ?? startId.slice(0, 7)}（已是根源）`
      : `到根源：${labels.join(" → ")}（高亮 ${nodeIds.size} 节点）`;
}

async function destroyGraph(): Promise<void> {
  const g = graphInst.value;
  graphInst.value = null;
  g6Data = null;
  pathHint.value = "";
  if (g) {
    g.destroy();
  }
}

async function renderGraph(): Promise<void> {
  await nextTick();
  const el = containerRef.value;
  if (!el) {
    return;
  }

  await destroyGraph();

  const data = branchGraphToG6(props.graph);
  g6Data = data;
  if (data.nodes.length === 0) {
    return;
  }

  const g = new Graph({
    container: el,
    width: el.clientWidth || 640,
    height: el.clientHeight || 360,
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
        size: [156, 42],
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
            "commit") as G6NodeKind;
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
}

function bindResize(): void {
  resizeObserver?.disconnect();
  const stage = stageRef.value;
  if (!stage) {
    return;
  }
  resizeObserver = new ResizeObserver(() => {
    const g = graphInst.value;
    const el = containerRef.value;
    if (!g || !el) {
      return;
    }
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w > 0 && h > 0) {
      g.setSize(w, h);
      void g.fitView();
    }
  });
  resizeObserver.observe(stage);
}

onMounted(() => {
  void renderGraph().then(bindResize);
});

onBeforeUnmount(() => {
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
    <div v-else class="path-hint path-hint--idle">点击节点：高亮到根源的链路 · 点击空白处清除</div>
  </div>
</template>
