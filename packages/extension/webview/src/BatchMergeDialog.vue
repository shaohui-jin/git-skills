<script setup lang="ts">
/**
 * 批量合并确认对话框：干跑预演结果 + 合入清单微调。
 *
 * 干跑在对话框打开时自动跑（零副作用）；干净才允许执行。
 * 每行可排除勾选、上移/下移（后续拖拽的先导），任何调整自动重跑干跑——
 * 顺序变了，前缀冲突的组合就变了，旧预演不能继续用。
 */
import { computed, ref, watch } from "vue";
import type {
  BatchMergePlanResult,
  BatchPlanStep,
} from "./types";

const props = defineProps<{
  open: boolean;
  into: string;
  /** 干跑结果；null = 还在跑 */
  plan: BatchMergePlanResult | null;
  /** 干跑或实跑进行中 */
  busy: boolean;
  /** 实跑中（禁用一切操作） */
  running: boolean;
  /** 实跑错误（sha 护栏触发等），展示并允许重跑干跑 */
  runError: string | null;
}>();

const emit = defineEmits<{
  /** 用户调整了清单（排除/顺序），要求重跑干跑 */
  (e: "replan", entries: Array<{ from: string; resolved?: boolean }>): void;
  /** 确认执行 */
  (
    e: "run",
    payload: {
      into: string;
      batchBranch: string;
      items: BatchMergePlanResult["items"];
    },
  ): void;
  (e: "cancel"): void;
}>();

interface RowState {
  from: string;
  /** 保持干跑解析出的源信息，replan 后 core 会重新解析 */
  sourceKind: BatchPlanStep["sourceKind"];
  source: string;
  excluded: boolean;
}

const rows = ref<RowState[]>([]);

watch(
  () => props.plan,
  (plan) => {
    rows.value = (plan?.items ?? []).map((item, idx) => ({
      from: item.from,
      sourceKind: plan?.steps[idx]?.sourceKind ?? item.sourceKind,
      source: item.source,
      excluded: false,
    }));
  },
  { immediate: true },
);

/** 清单有任何调整就重跑干跑：顺序/集合变了，冲突组合就变了 */
watch(
  rows,
  () => {
    if (!props.open || props.busy || props.running) {
      return;
    }
    const plan = props.plan;
    if (!plan) {
      return;
    }
    const current = rows.value.map((r) => r.from);
    const planned = plan.items.map((i) => i.from);
    if (
      current.length === planned.length &&
      current.every((f, i) => f === planned[i])
    ) {
      return;
    }
    // 已解决的格子继续按已解决参与（干跑仍会重新解析源）
    const resolvedSet = new Set(
      plan.items.filter((i) => i.sourceKind !== "branch").map((i) => i.from),
    );
    emit("replan", current.map((from) => ({ from, resolved: resolvedSet.has(from) })));
  },
  { deep: true },
);

function move(index: number, delta: -1 | 1): void {
  const target = index + delta;
  const list = rows.value;
  if (target < 0 || target >= list.length) {
    return;
  }
  const [row] = list.splice(index, 1);
  if (row) {
    list.splice(target, 0, row);
  }
}

const SOURCE_TEXT: Record<string, string> = {
  branch: "原分支",
  "temp-local": "临时分支 · 本地",
  "temp-remote": "临时分支 · 远端",
};

const blockedInfo = computed(() => {
  const plan = props.plan;
  if (!plan || plan.clean) {
    return null;
  }
  const step = plan.steps.find((s) => s.outcome === "conflicts" || s.outcome === "error");
  if (!step) {
    return null;
  }
  return {
    from: step.from,
    reason: plan.blockedReason ?? "干跑发现冲突",
    paths: plan.blockedPaths.length > 0 ? plan.blockedPaths : step.conflictPaths,
  };
});

const excludedCount = computed(() => rows.value.filter((r) => r.excluded).length);
const activeCount = computed(() => rows.value.length - excludedCount.value);

const changedFilesWarn = computed(() => {
  const n = props.plan?.changedFiles;
  return typeof n === "number" && n > 50 ? n : null;
});

const canRun = computed(
  () =>
    props.open &&
    !!props.plan &&
    props.plan.clean &&
    !props.busy &&
    !props.running &&
    activeCount.value > 0,
);

function onRun(): void {
  const plan = props.plan;
  if (!plan || !canRun.value) {
    return;
  }
  const active = new Set(rows.value.filter((r) => !r.excluded).map((r) => r.from));
  const items = plan.items.filter((i) => active.has(i.from));
  emit("run", {
    into: plan.into,
    batchBranch: plan.batchBranch,
    items,
  });
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="mr-dialog-mask" @click.self="emit('cancel')">
      <div class="mr-dialog batch-modal" role="dialog" aria-modal="true">
        <header class="mr-dialog-head">
          <h3>一键处理合并并推送</h3>
          <button class="modal-x" type="button" :disabled="running" @click="emit('cancel')">
            ×
          </button>
        </header>

        <div class="modal-body">
          <p class="hint">
            目标 <code>{{ into }}</code>
            <template v-if="plan">
              · 批量分支 <code>{{ plan.batchBranch }}</code>
            </template>
          </p>

          <!-- 干跑中 -->
          <div v-if="!plan && busy" class="batch-dryrun">
            <span class="btn-spinner" aria-hidden="true" />
            <span>干跑预演中（merge-tree，零副作用）…</span>
          </div>

          <template v-else-if="plan">
            <!-- 干跑冲突 -->
            <div v-if="blockedInfo" class="batch-blocked">
              <p class="hint hint--danger">
                {{ blockedInfo.reason }}
              </p>
              <p class="hint">
                可排除「{{ blockedInfo.from }}」或调整顺序后重跑；排除/移动会自动重新预演。
              </p>
              <ul v-if="blockedInfo.paths.length" class="matrix-paths">
                <li v-for="p in blockedInfo.paths" :key="p" :title="p">{{ p }}</li>
              </ul>
            </div>

            <!-- 单 MR 过大预警 -->
            <p v-if="changedFilesWarn" class="hint hint--danger">
              单个总 MR 将包含约 {{ changedFilesWarn }} 个文件的改动，请留意评审负担。
            </p>

            <p v-for="w in plan.warnings" :key="w" class="hint">{{ w }}</p>

            <div class="batch-list-head">
              <span>合入清单（从上到下依次合入）</span>
              <span v-if="excludedCount > 0" class="hint">
                已排除 {{ excludedCount }} / {{ rows.length }}
              </span>
            </div>
            <ul class="batch-list">
              <li v-for="(row, idx) in rows" :key="row.from" class="batch-row">
                <label class="batch-row-check">
                  <input v-model="row.excluded" type="checkbox" :disabled="running" />
                </label>
                <span class="batch-row-n mono">{{ idx + 1 }}</span>
                <span class="batch-row-name" :title="row.from">{{ row.from }}</span>
                <span class="batch-row-src" :title="row.source">
                  {{ SOURCE_TEXT[row.sourceKind] ?? row.sourceKind }}
                  <template v-if="plan.items[idx]?.sourceSha">
                    · {{ shortSha(plan.items[idx]!.sourceSha) }}
                  </template>
                </span>
                <span class="batch-row-outcome">
                  <template v-if="plan.steps[idx]?.outcome === 'up-to-date'">
                    已包含
                  </template>
                </span>
                <span class="batch-row-move">
                  <button
                    class="btn tiny secondary"
                    type="button"
                    :disabled="running || idx === 0"
                    title="上移"
                    @click="move(idx, -1)"
                  >
                    ↑
                  </button>
                  <button
                    class="btn tiny secondary"
                    type="button"
                    :disabled="running || idx === rows.length - 1"
                    title="下移"
                    @click="move(idx, 1)"
                  >
                    ↓
                  </button>
                </span>
              </li>
            </ul>

            <p class="hint">
              执行流程：独立 worktree 逐个 merge → 单次推送批量分支。主工作区不切换分支；
              中途出现干跑未预测到的冲突会立即中止并清理。
            </p>
            <p v-if="runError" class="hint hint--danger">{{ runError }}</p>
          </template>

          <div v-else class="empty">等待干跑预演…</div>
        </div>

        <footer class="batch-foot">
          <span v-if="plan && plan.clean && activeCount > 0" class="hint">
            干跑通过 · {{ activeCount }} 个分支将依次合入
          </span>
          <span class="modal-foot-spacer" />
          <button class="btn secondary" type="button" :disabled="running" @click="emit('cancel')">
            取消
          </button>
          <button
            class="btn"
            type="button"
            :disabled="!canRun"
            :title="plan && !plan.clean ? '干跑存在冲突，先调整清单' : ''"
            @click="onRun"
          >
            {{ running ? "执行中…" : "确认执行" }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>
