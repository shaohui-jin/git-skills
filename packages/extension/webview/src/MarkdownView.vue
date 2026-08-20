<script setup lang="ts">
import { marked } from "marked";
import { computed } from "vue";
import { sanitizeReportHtml } from "./sanitizeReportHtml";

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
    return "";
  }
  return sanitizeReportHtml(marked.parse(src, { async: false }) as string);
});
</script>

<template>
  <div class="md-body">
    <p v-if="!html" class="md-empty">暂无报告</p>
    <div v-else v-html="html" />
  </div>
</template>
