<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  AI_RESOLVE_RULES,
  type AiResolveRuleId,
} from "./conflict/aiResolveTypes";

export interface AiBridgeView {
  port: number;
  callbackUrl: string;
  prompt: string;
  promptFile: string;
  conflictsFile?: string;
  resultFile?: string;
  openedChat: boolean;
  copied: boolean;
  pasted?: boolean;
  submitted?: boolean;
  batchIndex?: number;
  batchTotal?: number;
}

const props = defineProps<{
  open: boolean;
  busy?: boolean;
  progressPercent?: number | null;
  progressLabel?: string;
  error?: string | null;
  bridge?: AiBridgeView | null;
}>();

const emit = defineEmits<{
  close: [];
  confirm: [payload: { rules: AiResolveRuleId[]; extraNotes: string }];
  copyPrompt: [];
  cancelBridge: [];
}>();

const selected = ref<AiResolveRuleId[]>(["preferMine", "mergeWhenPossible"]);
const extraNotes = ref("");
const copiedErr = ref(false);
const copiedPromptLocal = ref(false);
const copiedUrlLocal = ref(false);
const copiedResultLocal = ref(false);
const showOps = ref(false);

watch(
  () => props.open,
  (open) => {
    if (open && !props.busy && !props.error && !props.bridge) {
      selected.value = ["preferMine", "mergeWhenPossible"];
      extraNotes.value = "";
      copiedErr.value = false;
      copiedPromptLocal.value = false;
      copiedUrlLocal.value = false;
      copiedResultLocal.value = false;
      showOps.value = false;
    }
  },
);

watch(
  () => props.error,
  () => {
    copiedErr.value = false;
  },
);

watch(
  () => props.bridge?.copied,
  (v) => {
    if (v) {
      copiedPromptLocal.value = true;
    }
  },
);

const preferConflict = computed(
  () =>
    selected.value.includes("preferMine") && selected.value.includes("preferOnline"),
);

const canConfirm = computed(() => {
  if (props.busy) {
    return false;
  }
  if (preferConflict.value) {
    return false;
  }
  const hasBias =
    selected.value.includes("preferMine") ||
    selected.value.includes("preferOnline") ||
    selected.value.includes("newerWins");
  return hasBias && selected.value.length > 0;
});

const pct = computed(() => {
  const n = props.progressPercent;
  if (n == null || !Number.isFinite(n)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(n)));
});

function toggle(id: AiResolveRuleId): void {
  const set = new Set(selected.value);
  if (set.has(id)) {
    set.delete(id);
  } else {
    if (id === "preferMine") {
      set.delete("preferOnline");
    }
    if (id === "preferOnline") {
      set.delete("preferMine");
    }
    set.add(id);
  }
  selected.value = [...set];
}

function onConfirm(): void {
  if (!canConfirm.value) {
    return;
  }
  emit("confirm", {
    rules: [...selected.value],
    extraNotes: extraNotes.value.trim(),
  });
}

async function copyText(text: string): Promise<boolean> {
  const t = text.trim();
  if (!t) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    return false;
  }
}

async function copyError(): Promise<void> {
  copiedErr.value = await copyText(props.error ?? "");
}

async function copyCallbackUrl(): Promise<void> {
  copiedUrlLocal.value = await copyText(props.bridge?.callbackUrl ?? "");
}

async function copyResultFile(): Promise<void> {
  copiedResultLocal.value = await copyText(props.bridge?.resultFile ?? "");
}

function onCopyPrompt(): void {
  copiedPromptLocal.value = true;
  emit("copyPrompt");
}

const autoStatus = computed(() => {
  const b = props.bridge;
  if (!b) {
    return "";
  }
  if (b.submitted) {
    return "全流程：已打开 Chat、粘贴并尝试自动发送；正在等回传。";
  }
  if (b.pasted) {
    return "已打开 Chat 并粘贴提示词；若未发出请在 Chat 里按发送。";
  }
  if (b.openedChat && (b.copied || copiedPromptLocal.value)) {
    return "已打开 Chat，提示词在剪贴板；请在输入框 Ctrl+V 后发送。";
  }
  if (b.openedChat) {
    return "已打开 Chat；请点「复制提示词」再粘贴发送。";
  }
  if (b.copied || copiedPromptLocal.value) {
    return "未能自动打开 Chat；提示词已在剪贴板，请手动打开后粘贴。";
  }
  return "自动唤起未完成；请用下方按钮复制后手动操作。";
});
</script>

<template>
  <div v-if="open" class="mr-dialog-mask" @click.self="!busy && emit('close')">
    <div class="mr-dialog card ai-resolve-dialog" role="dialog" aria-label="AI 选边规则">
      <div class="mr-dialog-head">
        <h3>AI 选边 · 选择规则</h3>
        <button type="button" class="btn secondary" :disabled="busy" @click="emit('close')">
          关闭
        </button>
      </div>
      <p class="muted">
        全流程：复制提示词 → 打开 Cursor Chat/Agent → 粘贴（尽量自动发送）→ Agent 把结果写回文件。
        需要 Agent 模式；任一环节失败时，用右侧「复制」按钮或「异常操作说明」手动兜底。
      </p>
      <ul class="ai-rule-list">
        <li v-for="r in AI_RESOLVE_RULES" :key="r.id">
          <label class="ai-rule-item">
            <input
              type="checkbox"
              :checked="selected.includes(r.id)"
              :disabled="busy"
              @change="toggle(r.id)"
            />
            <span class="ai-rule-text">
              <strong>{{ r.title }}</strong>
              <small>{{ r.desc }}</small>
            </span>
          </label>
        </li>
      </ul>
      <p v-if="preferConflict" class="error-inline">「偏我的」与「偏线上」不可同时勾选</p>
      <p v-else-if="!canConfirm && !busy && !error" class="muted">
        请至少勾选：偏我的 / 偏线上 / 新覆盖旧 之一
      </p>
      <label>
        额外说明（可选，优先于下方规则）
        <textarea
          v-model="extraNotes"
          rows="2"
          :disabled="busy"
          placeholder="例如：pom.xml 版本跟线上…"
        />
      </label>

      <div v-if="busy" class="ai-progress" aria-live="polite">
        <div class="ai-progress-head">
          <span class="ai-progress-label">{{ progressLabel || "AI 选边中…" }}</span>
          <span class="ai-progress-pct">{{ pct }}%</span>
        </div>
        <span class="status-bar" :style="{ '--pct': `${pct}%` }" aria-hidden="true" />
      </div>

      <div v-if="bridge && busy" class="ai-bridge-box">
        <div class="ai-bridge-title">
          <span class="ai-bridge-dot" aria-hidden="true" />
          正在等待 Cursor Chat 回传
        </div>
        <p
          v-if="bridge.batchTotal && bridge.batchTotal > 1"
          class="muted"
          style="margin: 0 0 6px"
        >
          自动分批：第 {{ bridge.batchIndex }}/{{ bridge.batchTotal }} 批（本批完成后会继续下一批）
        </p>
        <p class="muted" style="margin: 0">{{ autoStatus }}</p>
        <p v-if="bridge.resultFile" class="muted" style="margin: 6px 0 0">
          结果文件（Agent 写这里即完成）：<code>{{ bridge.resultFile }}</code>
        </p>
        <p class="muted" style="margin: 6px 0 0">
          备用端口：<code>{{ bridge.callbackUrl }}</code>
        </p>
        <p v-if="bridge.conflictsFile" class="muted" style="margin: 6px 0 0">
          冲突数据文件：<code>{{ bridge.conflictsFile }}</code>
        </p>
        <div class="ai-error-actions" style="margin-top: 8px">
          <button type="button" class="btn secondary tiny" @click="onCopyPrompt">
            {{ copiedPromptLocal || bridge.copied ? "已复制提示词" : "复制提示词" }}
          </button>
          <button
            v-if="bridge.resultFile"
            type="button"
            class="btn secondary tiny"
            @click="copyResultFile"
          >
            {{ copiedResultLocal ? "已复制结果文件路径" : "复制结果文件路径" }}
          </button>
          <button type="button" class="btn secondary tiny" @click="copyCallbackUrl">
            {{ copiedUrlLocal ? "已复制回调 URL" : "复制回调 URL" }}
          </button>
          <button type="button" class="btn secondary tiny" @click="showOps = !showOps">
            {{ showOps ? "收起操作说明" : "异常操作说明" }}
          </button>
          <button type="button" class="btn secondary tiny" @click="emit('cancelBridge')">
            取消等待
          </button>
        </div>
        <ol v-if="showOps" class="config-steps" style="margin: 8px 0 0; padding-left: 18px">
          <li>若 Chat 未打开：手动打开 Cursor Chat，切到 Agent 模式（要能读写文件）。</li>
          <li>点「复制提示词」→ 在 Chat 输入框 Ctrl+V → 发送。</li>
          <li>Agent 先 Read 冲突数据 JSON，裁决后把结果 JSON 写入上面的结果文件即完成。</li>
          <li>Agent 若停在 MCP feedback 等确认工具上：催它继续写结果文件，确认本身不算交付。</li>
          <li>仍无回传：输出面板选「Git Insight」看日志，或 Reload Window 后重试。</li>
        </ol>
        <p class="muted" style="margin: 8px 0 0">
          扩展只认两条通道：Agent 写结果文件，或 POST 到备用端口。普通 Ask 会话两条都做不到，请用 Agent 模式。
        </p>
      </div>

      <div v-if="error && !busy" class="ai-error-box" role="alert">
        <div class="ai-error-title">AI 选边失败</div>
        <pre class="ai-error-text">{{ error }}</pre>
        <div class="ai-error-actions">
          <button type="button" class="btn secondary tiny" @click="copyError">
            {{ copiedErr ? "已复制报错" : "复制报错" }}
          </button>
          <button type="button" class="btn secondary tiny" @click="onCopyPrompt">
            复制提示词
          </button>
          <button type="button" class="btn secondary tiny" @click="showOps = !showOps">
            {{ showOps ? "收起操作说明" : "异常操作说明" }}
          </button>
        </div>
        <ol v-if="showOps" class="config-steps" style="margin: 8px 0 0; padding-left: 18px">
          <li>Reload Window 后重试「开始 AI 选边」。</li>
          <li>手动打开 Chat（Agent 模式），粘贴提示词并发送。</li>
          <li>分批时某批失败只会把该批标成待定，其余批次的裁决仍然保留。</li>
          <li>输出面板选「Git Insight」查看宿主日志。</li>
        </ol>
      </div>

      <div class="mr-dialog-actions">
        <button
          type="button"
          class="btn secondary"
          :disabled="busy && !bridge"
          @click="bridge && busy ? emit('cancelBridge') : emit('close')"
        >
          {{ bridge && busy ? "取消等待" : "取消" }}
        </button>
        <button type="button" class="btn" :disabled="!canConfirm" @click="onConfirm">
          <span v-if="busy" class="btn-spinner" aria-hidden="true" />
          {{ busy ? "等待回传中…" : error ? "重试 AI 选边" : "开始 AI 选边" }}
        </button>
      </div>
    </div>
  </div>
</template>
