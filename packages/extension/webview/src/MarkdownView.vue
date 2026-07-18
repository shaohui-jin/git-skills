<script setup lang="ts">
import { marked } from "marked";
import { computed } from "vue";

const props = defineProps<{
  source: string;
}>();

marked.setOptions({
  gfm: true,
  breaks: true,
});

const html = computed(() => {
  const src = props.source?.trim() ?? "";
  if (!src) {
    return "<p class=\"md-empty\">暂无报告</p>";
  }
  return marked.parse(src, { async: false }) as string;
});
</script>

<template>
  <div class="md-body" v-html="html" />
</template>
