<script setup lang="ts">
import { Graph } from "@antv/g6";
import { nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { branchGraphToG6, kindColor, type G6NodeKind } from "./graph/toG6Data";
import type { BranchGraph } from "./types";

const props = defineProps<{ graph: BranchGraph }>();

const stageRef = ref<HTMLDivElement | null>(null);
const containerRef = ref<HTMLDivElement | null>(null);
const graphInst = shallowRef<Graph | null>(null);
let resizeObserver: ResizeObserver | null = null;

async function destroyGraph(): Promise<void> {
  const g = graphInst.value;
  graphInst.value = null;
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
      rankdir: "TB",
      nodesep: 28,
      ranksep: 48,
    },
    node: {
      type: "rect",
      style: {
        size: [148, 40],
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
      },
    },
    edge: {
      type: "cubic-vertical",
      style: {
        stroke: "rgba(200,200,200,0.35)",
        lineWidth: 1.5,
        endArrow: true,
      },
    },
    behaviors: ["drag-canvas", "zoom-canvas", "click-select", "drag-element"],
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
    <div class="tip-list" aria-label="分支 tips">
      <span
        v-for="t in graph.tips.slice(0, 40)"
        :key="t.name"
        class="tip-chip"
        :class="{ remote: t.remote }"
        :title="t.sha"
      >
        {{ t.name }}
      </span>
    </div>
    <div class="engine-badge" title="AntV G6 — 可视化引擎；编辑器场景可再评估 X6">
      G6
    </div>
  </div>
</template>
