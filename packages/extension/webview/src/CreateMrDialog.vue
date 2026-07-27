<script setup lang="ts">
import { computed, ref, watch } from "vue";

export interface MrDialogCandidate {
  username: string;
  name?: string;
  role?: string;
}

export interface MrDialogDraft {
  platform: "github" | "gitlab" | "unknown";
  cli: "gh" | "glab" | null;
  /** 当前 Git 配置中的 MR 方式 */
  method: "cli" | "download-cli" | "token" | "browser" | null;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  candidates: MrDialogCandidate[];
  createMrUrl: string | null;
  messages: string[];
  cliError?: string;
}

const props = defineProps<{
  open: boolean;
  draft: MrDialogDraft | null;
  busy?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  submit: [
    payload: {
      sourceBranch: string;
      targetBranch: string;
      title: string;
      reviewers: string[];
    },
  ];
  openUrl: [url: string];
}>();

const sourceBranch = ref("");
const targetBranch = ref("");
const title = ref("");
const selected = ref<string[]>([]);
const filter = ref("");

watch(
  () => props.draft,
  (d) => {
    if (!d) {
      return;
    }
    sourceBranch.value = d.sourceBranch;
    targetBranch.value = d.targetBranch;
    title.value = d.title;
    selected.value = [];
    filter.value = "";
  },
  { immediate: true },
);

const filteredCandidates = computed(() => {
  const q = filter.value.trim().toLowerCase();
  const list = props.draft?.candidates ?? [];
  if (!q) {
    return list;
  }
  return list.filter(
    (c) =>
      c.username.toLowerCase().includes(q) ||
      (c.name && c.name.toLowerCase().includes(q)),
  );
});

const platformLabel = computed(() => {
  const p = props.draft?.platform;
  if (p === "github") {
    return "GitHub PR";
  }
  if (p === "gitlab") {
    return "GitLab MR";
  }
  return "未知平台";
});

const canSubmit = computed(() => {
  const m = props.draft?.method;
  if (m === "browser" || m === "token") {
    return true;
  }
  // cli / download-cli
  return !!props.draft?.cli;
});

const submitLabel = computed(() => {
  if (props.busy) {
    return "创建中…";
  }
  const m = props.draft?.method;
  if (m === "browser") {
    return "打开创建页";
  }
  if (m === "token") {
    return "用 Token 创建";
  }
  return `用 ${props.draft?.cli || "CLI"} 创建`;
});

function toggle(user: string): void {
  if (selected.value.includes(user)) {
    selected.value = selected.value.filter((x) => x !== user);
  } else {
    selected.value = [...selected.value, user];
  }
}

function submit(): void {
  emit("submit", {
    sourceBranch: sourceBranch.value.trim(),
    targetBranch: targetBranch.value.trim(),
    title: title.value.trim(),
    reviewers: [...selected.value],
  });
}
</script>

<template>
  <div v-if="open && draft" class="mr-dialog-mask" @click.self="emit('close')">
    <div class="mr-dialog card" role="dialog" aria-label="一键申请 MR">
      <div class="mr-dialog-head">
        <h3>一键申请 {{ platformLabel }}</h3>
        <button type="button" class="btn secondary tiny" :disabled="busy" @click="emit('close')">
          关闭
        </button>
      </div>

      <p v-if="draft.cliError && draft.method !== 'browser' && draft.method !== 'token'" class="mr-warn">
        {{ draft.cliError }}
        <template v-if="draft.createMrUrl">
          ；仍可
          <button type="button" class="linkish" @click="emit('openUrl', draft.createMrUrl!)">
            打开浏览器创建页
          </button>
        </template>
      </p>
      <p v-else class="muted">
        <template v-if="draft.method === 'browser'">将打开预填分支的创建页，请在浏览器中提交。</template>
        <template v-else-if="draft.method === 'token'">将使用扩展全局 Token 调用 API 创建。</template>
        <template v-else>
          使用 <code>{{ draft.cli || "CLI" }}</code> 创建。可多选评审人后提交。
        </template>
      </p>

      <label>
        我的分支 / 源（source）
        <input v-model="sourceBranch" type="text" :disabled="busy" />
      </label>
      <label>
        线上目标 / 目标（target）
        <input v-model="targetBranch" type="text" :disabled="busy" />
      </label>
      <label>
        标题
        <input v-model="title" type="text" :disabled="busy" />
      </label>

      <div class="mr-reviewers">
        <div class="mr-reviewers-head">
          <span>评审人 / 有合并相关权限的成员（{{ selected.length }} 已选）</span>
          <input
            v-model="filter"
            class="mr-filter"
            type="text"
            placeholder="筛选用户名…"
            :disabled="busy || !draft.candidates.length"
          />
        </div>
        <div v-if="!draft.candidates.length" class="muted mr-empty">
          未能拉取成员列表（权限不足或 CLI 未就绪）。仍可直接创建，或打开浏览器页手选。
        </div>
        <ul v-else class="mr-candidate-list">
          <li v-for="c in filteredCandidates" :key="c.username">
            <label class="mr-candidate">
              <input
                type="checkbox"
                :checked="selected.includes(c.username)"
                :disabled="busy"
                @change="toggle(c.username)"
              />
              <span class="mono">{{ c.username }}</span>
              <span v-if="c.name && c.name !== c.username" class="muted">{{ c.name }}</span>
              <span v-if="c.role" class="mr-role">{{ c.role }}</span>
            </label>
          </li>
        </ul>
      </div>

      <div class="mr-dialog-actions">
        <button
          v-if="draft.createMrUrl"
          type="button"
          class="btn secondary"
          :disabled="busy"
          @click="emit('openUrl', draft.createMrUrl!)"
        >
          仅打开创建页
        </button>
        <button
          type="button"
          class="btn"
          :disabled="busy || !canSubmit || !sourceBranch.trim() || !targetBranch.trim()"
          @click="submit"
        >
          {{ submitLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
