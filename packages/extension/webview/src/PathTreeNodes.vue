<script setup lang="ts">
import { computed } from "vue";
import type { PathTreeNode } from "./graph/branchTree";
import PathTreeNodes from "./PathTreeNodes.vue";

const props = defineProps<{
  nodes: PathTreeNode[];
  modelValue: string | string[];
  /** folder key prefix，用于展开状态 */
  expandKeyPrefix: string;
  expanded: Record<string, boolean>;
  activeFull: string | null;
  depth?: number;
  /** 多选模式：显示 checkbox */
  multi?: boolean;
  /** 多选模式下判断某个 full 是否已勾选 */
  isChecked?: (full: string) => boolean;
}>();

const emit = defineEmits<{
  select: [full: string];
  toggle: [key: string];
  hover: [full: string];
}>();

const depth = computed(() => props.depth ?? 0);

/** 外部 modelValue 统一转成 Set，方便比较 */
const externalSet = computed<Set<string>>(() => {
  if (Array.isArray(props.modelValue)) {
    return new Set(props.modelValue);
  }
  return props.modelValue ? new Set([props.modelValue]) : new Set();
});

function isSelected(full: string): boolean {
  return externalSet.value.has(full);
}

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
            active: isSelected(n.full),
            'kbd-active': activeFull === n.full,
            'multi': props.multi,
          }"
          :title="n.full"
          @click="emit('select', n.full)"
          @mouseenter="emit('hover', n.full)"
        >
          <input
            v-if="props.multi"
            type="checkbox"
            :checked="isChecked ? isChecked(n.full) : false"
            class="tree-multi-cb"
            @click.stop
            @change="emit('select', n.full)"
          />
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
          :multi="multi"
          :is-checked="isChecked"
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
          active: isSelected(n.full),
          'kbd-active': activeFull === n.full,
          'multi': props.multi,
        }"
        :title="n.full"
        @click="emit('select', n.full)"
        @mouseenter="emit('hover', n.full)"
      >
        <input
          v-if="props.multi"
          type="checkbox"
          :checked="isChecked ? isChecked(n.full) : false"
          class="tree-multi-cb"
          @click.stop
          @change="emit('select', n.full)"
        />
        {{ n.segment }}
      </li>
    </template>
  </ul>
</template>
