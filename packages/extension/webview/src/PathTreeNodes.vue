<script setup lang="ts">
import { computed } from "vue";
import type { PathTreeNode } from "./graph/branchTree";
import PathTreeNodes from "./PathTreeNodes.vue";

const props = defineProps<{
  nodes: PathTreeNode[];
  modelValue: string;
  /** folder key prefix，用于展开状态 */
  expandKeyPrefix: string;
  expanded: Record<string, boolean>;
  activeFull: string | null;
  depth?: number;
}>();

const emit = defineEmits<{
  select: [full: string];
  toggle: [key: string];
  hover: [full: string];
}>();

const depth = computed(() => props.depth ?? 0);

function folderKey(segment: string): string {
  return `${props.expandKeyPrefix}/${segment}`;
}

function isExpanded(segment: string): boolean {
  // 默认折叠，少占行；点开或筛选时再展开
  return props.expanded[folderKey(segment)] === true;
}

function leafCount(node: PathTreeNode): number {
  let n = node.full ? 1 : 0;
  for (const c of node.children) {
    n += leafCount(c);
  }
  return n;
}
</script>

<template>
  <ul class="tree-children" :class="{ nested: depth > 0 }">
    <template v-for="n in nodes" :key="folderKey(n.segment)">
      <!-- 文件夹：有子节点 -->
      <li v-if="n.children.length > 0" class="tree-folder">
        <button
          type="button"
          class="tree-group-title nested tree-folder-title"
          tabindex="-1"
          @click="emit('toggle', folderKey(n.segment))"
        >
          <span class="tree-caret">{{ isExpanded(n.segment) ? "▾" : "▸" }}</span>
          {{ n.segment }}
          <span class="tree-count">{{ leafCount(n) }}</span>
        </button>
        <!-- 该段本身也是 tip：文件夹下可再点选同名分支 -->
        <div
          v-if="n.full && isExpanded(n.segment)"
          class="tree-leaf tree-leaf--self"
          :class="{
            active: n.full === modelValue,
            'kbd-active': activeFull === n.full,
          }"
          :title="n.full"
          @click="emit('select', n.full)"
          @mouseenter="emit('hover', n.full)"
        >
          <span class="tree-self-tip">（本段）</span>
          {{ n.segment }}
        </div>
        <PathTreeNodes
          v-if="isExpanded(n.segment)"
          :nodes="n.children"
          :model-value="modelValue"
          :expand-key-prefix="folderKey(n.segment)"
          :expanded="expanded"
          :active-full="activeFull"
          :depth="depth + 1"
          @select="emit('select', $event)"
          @toggle="emit('toggle', $event)"
          @hover="emit('hover', $event)"
        />
      </li>

      <!-- 纯叶子 -->
      <li
        v-else-if="n.full"
        class="tree-leaf"
        :class="{
          active: n.full === modelValue,
          'kbd-active': activeFull === n.full,
        }"
        :title="n.full"
        @click="emit('select', n.full)"
        @mouseenter="emit('hover', n.full)"
      >
        {{ n.segment }}
      </li>
    </template>
  </ul>
</template>
