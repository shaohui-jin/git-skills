<script setup lang="ts">
/**
 * 通用确认框：applyResolve（一键解决并推送）、createMr（一键申请 MR）等写操作共用。
 * 复用现有自绘弹窗样式基座（.mr-dialog-mask / .mr-dialog，见 styles.css），与面板主题统一。
 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /** true 时确认按钮用危险强调色（表明确认后即执行不可撤销的写操作） */
    danger?: boolean;
    busy?: boolean;
  }>(),
  {
    confirmLabel: "确认",
    cancelLabel: "取消",
    danger: false,
    busy: false,
  },
);

const emit = defineEmits<{
  (e: "confirm"): void;
  (e: "cancel"): void;
}>();

function onConfirm(): void {
  if (props.busy) {
    return;
  }
  emit("confirm");
}
</script>

<template>
  <div v-if="open" class="mr-dialog-mask" @click.self="emit('cancel')">
    <div class="mr-dialog card" role="alertdialog" aria-label="确认">
      <div class="mr-dialog-head">
        <h3>{{ title }}</h3>
      </div>
      <p class="confirm-dialog-message">{{ message }}</p>
      <div class="mr-dialog-actions">
        <button type="button" class="btn secondary" :disabled="busy" @click="emit('cancel')">
          {{ cancelLabel }}
        </button>
        <button
          type="button"
          class="btn"
          :class="{ danger: danger }"
          :disabled="busy"
          @click="onConfirm"
        >
          {{ confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
