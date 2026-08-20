<script setup lang="ts">
/**
 * 矩阵预演：一屏看清「这批分支两两合起来会怎样」，以及「按什么顺序合最省事」。
 *
 * 属图纸层：网格底、等宽字、硬边。格子只显示结论 + 冲突文件数，
 * 正文要看时点开右侧详情——批量场景不生成冲突正文，点「去预演」才走单对完整流程。
 */
import { computed, ref, watch } from "vue";
import BranchTreeSelect from "./BranchTreeSelect.vue";
import type {
  MergeSurveyCell,
  MergeSurveyResult,
  PairProgress,
  SuggestOrderResult,
  SurveyOutcome,
} from "./types";
import type { BranchOption } from "./graph/branchTree";

const props = defineProps<{
  branches: BranchOption[];
  survey: MergeSurveyResult | null;
  order: SuggestOrderResult | null;
  busy: boolean;
  /** 每一对走到哪了（已推临时分支 / 已提 MR）；用来把进度标回格子上 */
  progress: PairProgress[];
}>();

const emit = defineEmits<{
  (e: "survey", payload: { intos: string[]; froms: string[] }): void;
  (e: "order", payload: { into: string; branches: string[] }): void;
  (
    e: "goPreview",
    payload: {
      into: string;
      from: string;
      /** 整批待办，让预演页能显示「第几 / 共几」并支持上一条下一条 */
      queue: Array<{ into: string; from: string }>;
    },
  ): void;
  /** 对某一格直接申请 MR，不用绕回预演页；带上 sha 好记住这一格的进度 */
  (
    e: "createMr",
    payload: {
      into: string;
      from: string;
      intoSha: string;
      fromSha: string;
      /** 由矩阵定死，见 createMrFor */
      sourceBranch?: string;
    },
  ): void;
  (e: "openUrl", url: string): void;
}>();

const intos = ref<string[]>([]);
const froms = ref<string[]>([]);
const picking = ref<"into" | "from">("into");
const intoPickValue = ref<string[]>([]);
const fromPickValue = ref<string[]>([]);
/** 按当前模式读写对应的 v-model ref */
const pickValue = computed({
  get: () => (picking.value === "into" ? intoPickValue.value : fromPickValue.value),
  set: (v: string[]) => {
    if (picking.value === "into") {
      intoPickValue.value = v;
    } else {
      fromPickValue.value = v;
    }
  },
});
const activeCell = ref<MergeSurveyCell | null>(null);

const OUTCOME_TEXT: Record<SurveyOutcome, string> = {
  clean: "干净",
  conflicts: "冲突",
  unrelated: "无共祖",
  same: "同名",
  error: "失败",
};

/** BranchTreeSelect multi 模式 confirm */
function onPickedConfirm(values: string[]): void {
  if (values.length === 0) {
    return;
  }
  const bucket = picking.value === "into" ? intos : froms;
  const merged = new Set([...bucket.value, ...values]);
  bucket.value = [...merged];
}

function drop(kind: "into" | "from", name: string): void {
  const bucket = kind === "into" ? intos : froms;
  bucket.value = bucket.value.filter((b) => b !== name);
  // 同步清除下拉选项中的选中状态
  if (kind === "into") {
    intoPickValue.value = intoPickValue.value.filter((b) => b !== name);
  } else {
    fromPickValue.value = fromPickValue.value.filter((b) => b !== name);
  }
}

const canRun = computed(
  () => !props.busy && intos.value.length > 0 && froms.value.length > 0,
);
const canOrder = computed(
  () => !props.busy && intos.value.length === 1 && froms.value.length > 1,
);

function runSurvey(): void {
  if (!canRun.value) {
    return;
  }
  emit("survey", { intos: [...intos.value], froms: [...froms.value] });
}

function runOrder(): void {
  const into = intos.value[0];
  if (!canOrder.value || !into) {
    return;
  }
  emit("order", { into, branches: [...froms.value] });
}

function pairKey(intoRef: string, fromRef: string): string {
  return `${intoRef}\u0000${fromRef}`;
}

/** 表格按结果里的行列渲染，而不是当前选择 —— 改了选择但没重跑时，表格仍对应旧结果 */
const resultIntos = computed(() => [
  ...new Set((props.survey?.cells ?? []).map((c) => c.into)),
]);

const rows = computed(() => {
  const cells = props.survey?.cells ?? [];
  const index = new Map(cells.map((c) => [pairKey(c.into, c.from), c]));
  const resultFroms = [...new Set(cells.map((c) => c.from))];
  return resultFroms.map((from) => ({
    from,
    cells: resultIntos.value.map((into) => ({
      into,
      cell: index.get(pairKey(into, from)) ?? null,
    })),
  }));
});

const progressIndex = computed(
  () => new Map(props.progress.map((p) => [pairKey(p.into, p.from), p])),
);

/**
 * 这一格的进度记录。
 *
 * 注意「已处理」不等于「现在合得进去」：一键解决产出的是临时分支，
 * from 本身没动，重跑 merge-tree 照样冲突。所以这是一个独立状态，
 * 只有两侧 sha 与当时一致才算数——sha 变了那条临时分支就落后了。
 *
 * 只是本次会话的记账，不是「有没有解决过」的唯一依据，见 tempBranchFor。
 */
function progressFor(cell: MergeSurveyCell): PairProgress | undefined {
  const hit = progressIndex.value.get(pairKey(cell.into, cell.from));
  return hit && hit.intoSha === cell.intoSha && hit.fromSha === cell.fromSha
    ? hit
    : undefined;
}

/**
 * 一格在整条链路上走到哪了。两条路径汇到同一个终点：
 *
 *   冲突 → 已处理（临时分支已推）→ 已提 MR
 *   干净 ────────────────────────→ 已提 MR
 *
 * browser 方式只是打开创建页，提没提我们看不见，所以单列一档，
 * 既不当没做（别再催），也不谎称已提交。
 */
type Stage = "open" | "ready" | "local" | "resolved" | "page" | "mr";

interface TempBranchInfo {
  name: string;
  pushed: boolean;
  /** 本次会话刚产出、且两侧 sha 与当时一致，才敢说它是新鲜的 */
  fresh: boolean;
}

/**
 * 这一对的临时分支：先认本次会话的记录，没有就退回 git 里查到的。
 *
 * 光认内存记录是不够的——它挨不过面板重建、推送失败和 ref 移动导致的作废，
 * 于是「上次已经解决过」和「从没碰过」在矩阵里长得一模一样。分支存不存在
 * 则是可查的事实。代价是查到的分支不知道是基于哪个提交建的，所以标 fresh
 * 区分开，别让人以为它一定跟得上当前两侧。
 *
 * 只有冲突格子认这条兜底。干净格子压根不需要临时分支（直接拿 from 提 MR），
 * 仓库里恰好躺着一条同名 `merge/*`——多半是早先试出来的——不该改变它的档位，
 * 更不该把它推进「未推送」这种走不下去的档。
 */
function tempBranchFor(cell: MergeSurveyCell): TempBranchInfo | undefined {
  const rec = progressFor(cell);
  if (rec?.tempBranch) {
    return { name: rec.tempBranch, pushed: true, fresh: true };
  }
  if (cell.outcome !== "conflicts" || !cell.tempBranch) {
    return undefined;
  }
  return { name: cell.tempBranch.name, pushed: cell.tempBranch.remote, fresh: false };
}

function stageOf(cell: MergeSurveyCell): Stage {
  const mr = progressFor(cell)?.mr;
  if (mr) {
    return mr.via === "browser" ? "page" : "mr";
  }
  const temp = tempBranchFor(cell);
  if (temp) {
    // 只在本地、没推上去：MR 提不了，得先补一次推送
    return temp.pushed ? "resolved" : "local";
  }
  return cell.outcome === "clean" ? "ready" : "open";
}

/** 空串表示「照常显示 outcome」——open / ready 两档本来就该显示「冲突」「干净」 */
const STAGE_TEXT: Record<Stage, string> = {
  open: "",
  ready: "",
  local: "未推送",
  resolved: "已处理",
  page: "已开创建页",
  mr: "已提 MR",
};

/** 只有真正走过链路的三档才改格子配色；open / ready 保持 outcome 本来的样子 */
function stageClass(cell: MergeSurveyCell): string {
  const stage = stageOf(cell);
  return STAGE_TEXT[stage] ? `is-${stage}` : "";
}

/** ✓ = 已处理待提 MR，↗ = 已经提过了，! = 只在本地还没推 */
function stageMark(cell: MergeSurveyCell): string {
  const stage = stageOf(cell);
  if (!STAGE_TEXT[stage]) {
    return "";
  }
  if (stage === "local") {
    return "!";
  }
  return stage === "resolved" ? "✓" : "↗";
}

/** 表格里所有格子，按行列顺序排平 */
const allCells = computed(() =>
  rows.value.flatMap((row) =>
    row.cells
      .map((c) => c.cell)
      .filter((cell): cell is MergeSurveyCell => !!cell),
  ),
);

function toPairs(cells: MergeSurveyCell[]): Array<{ into: string; from: string }> {
  return cells.map((c) => ({ into: c.into, from: c.from }));
}

/** 逐条处理只管冲突格子：干净的没什么可解决的 */
const conflictCells = computed(() =>
  allCells.value.filter((c) => c.outcome === "conflicts"),
);

/** 队列一律按 stageOf 分档，跟格子上显示的状态同源，免得计数和格子对不上 */
const conflictQueue = computed(() => toPairs(conflictCells.value));

/** 还没解决的，外加解决了但没推上去的——后者也得回预演页重来一次 */
function stillPending(cell: MergeSurveyCell): boolean {
  const stage = stageOf(cell);
  return stage === "open" || stage === "local";
}

const pendingQueue = computed(() => toPairs(conflictCells.value.filter(stillPending)));

/**
 * 还没提过 MR、现在就能提的格子；批处理的最后一段。
 *
 * 冲突走完解决拿到临时分支（resolved），干净的本来就能直接提（ready），两条
 * 路径在这里合流，按矩阵顺序从上往下排——冲突清完之后还得挨个点开干净格子，
 * 等于走到一半没路了。
 *
 * 仍然不收 local：那条临时分支没推上远端，提不了。
 */
const mrCells = computed(() =>
  allCells.value.filter((c) => {
    const stage = stageOf(c);
    return stage === "resolved" || stage === "ready";
  }),
);

const mrQueue = computed(() => toPairs(mrCells.value));

const doneCount = computed(
  () => conflictCells.value.filter((c) => !stillPending(c)).length,
);
/** 实际提过 MR 的格子数，干净的和冲突的一起算 */
const mrDoneCount = computed(
  () => allCells.value.filter((c) => ["mr", "page"].includes(stageOf(c))).length,
);

function cellTitle(cell: MergeSurveyCell): string {
  const stage = stageOf(cell);
  if (stage === "open" || stage === "ready") {
    return cell.error || `${cell.from} → ${cell.into}`;
  }
  const temp = tempBranchFor(cell);
  const source = temp ? `临时分支 ${temp.name}` : `直接用 ${cell.from}`;
  const note =
    stage === "local"
      ? "只在本地，还没推送，暂时提不了 MR"
      : stage === "resolved"
        ? "还没申请 MR"
        : stage === "page"
          ? "创建页已打开，请确认是否已提交"
          : `MR：${progressFor(cell)?.mr?.url ?? "已创建"}`;
  return `${source} · ${note}`;
}

function goPreview(pair: { into: string; from: string }): void {
  emit("goPreview", { ...pair, queue: conflictQueue.value });
}

/**
 * 源分支这里就定死，不交给 core 去猜。
 *
 * core 猜不到的是「这一格是干净直合还是解决过冲突」：它只会按 (into, from)
 * 算出临时分支名，存在就用。仓库里躺着一条早先试出来的同名 `merge/*` 时，
 * 一个说好了「直接用 from」的干净格子会被悄悄换成那条陈旧分支去提 MR。
 */
function createMrFor(cell: MergeSurveyCell): void {
  emit("createMr", {
    into: cell.into,
    from: cell.from,
    intoSha: cell.intoSha,
    fromSha: cell.fromSha,
    sourceBranch: stageOf(cell) === "ready" ? cell.from : tempBranchFor(cell)?.name,
  });
}

/** 批处理的下一步：先把冲突全解决，再从上往下逐条申请 MR */
function nextAction(): void {
  const pending = pendingQueue.value[0];
  if (pending) {
    goPreview(pending);
    return;
  }
  const needsMr = mrCells.value[0];
  if (needsMr) {
    createMrFor(needsMr);
  }
}

const nextActionText = computed(() => {
  if (pendingQueue.value.length > 0) {
    return doneCount.value > 0
      ? `处理下一条（剩 ${pendingQueue.value.length}）`
      : "开始逐条处理";
  }
  return mrQueue.value.length > 1
    ? `申请 MR（剩 ${mrQueue.value.length}）`
    : "申请 MR";
});

const nextActionHint = computed(() => {
  if (pendingQueue.value.length > 0) {
    const next = pendingQueue.value[0];
    return `去预演并解决：${next.from} → ${next.into}`;
  }
  const cell = mrCells.value[0];
  if (!cell) {
    return "";
  }
  const source = stageOf(cell) === "ready" ? cell.from : tempBranchFor(cell)?.name;
  return `用 ${source} 申请 MR：${cell.from} → ${cell.into}`;
});

function goPreviewActive(): void {
  const cell = activeCell.value;
  if (cell) {
    goPreview({ into: cell.into, from: cell.from });
  }
}

const activeProgress = computed(() =>
  activeCell.value ? progressFor(activeCell.value) : undefined,
);
const activeStage = computed<Stage>(() =>
  activeCell.value ? stageOf(activeCell.value) : "open",
);
const activeTemp = computed(() =>
  activeCell.value ? tempBranchFor(activeCell.value) : undefined,
);
const activeMrUrl = computed(() => activeProgress.value?.mr?.url ?? "");

function createMrActive(): void {
  if (activeCell.value) {
    createMrFor(activeCell.value);
  }
}

const summary = computed(() => {
  const cells = props.survey?.cells ?? [];
  return {
    total: cells.length,
    clean: cells.filter((c) => c.outcome === "clean").length,
    conflicts: cells.filter((c) => c.outcome === "conflicts").length,
    files: new Set(cells.flatMap((c) => c.conflictPaths)).size,
  };
});

const orderTotal = computed(() => props.order?.best.order.length ?? 0);
const orderImproved = computed(
  () =>
    !!props.order && props.order.best.cleanPrefix > props.order.baseline.cleanPrefix,
);

function shortRef(name: string): string {
  return name.length > 28 ? `…${name.slice(-27)}` : name;
}

watch(
  () => props.survey,
  () => {
    activeCell.value = null;
  },
);
</script>

<template>
  <div class="matrix">
    <div class="matrix-setup">
      <div class="matrix-setup-row">
        <div class="matrix-picker">
          <div class="seg" role="group">
            <button
              class="seg-btn"
              :class="{ active: picking === 'into' }"
              type="button"
              @click="picking = 'into'"
            >
              线上目标
            </button>
            <button
              class="seg-btn"
              :class="{ active: picking === 'from' }"
              type="button"
              @click="picking = 'from'"
            >
              我的分支
            </button>
          </div>
          <BranchTreeSelect
            v-model="pickValue"
            :branches="branches"
            :remote-only="picking === 'into'"
            :disabled="busy"
            :multi="true"
            :placeholder="picking === 'into' ? '选择线上目标…' : '选择待合入分支…'"
            @confirm="onPickedConfirm"
          />
        </div>
        <div class="matrix-setup-actions">
          <button class="btn" type="button" :disabled="!canRun" @click="runSurvey">
            跑矩阵
          </button>
          <button
            class="btn secondary"
            type="button"
            :disabled="!canOrder"
            :title="
              canOrder ? '推演最佳合入顺序' : '需要 1 个线上目标 + 2 个以上我的分支'
            "
            @click="runOrder"
          >
            算顺序
          </button>
        </div>
      </div>

      <div class="matrix-chips">
        <div class="matrix-chip-line">
          <span class="matrix-chip-label mono online">INTO</span>
          <span v-if="intos.length === 0" class="hint">未选</span>
          <button
            v-for="b in intos"
            :key="`i-${b}`"
            class="chip chip--online"
            type="button"
            title="移除"
            @click="drop('into', b)"
          >
            {{ shortRef(b) }}<span class="chip-x" aria-hidden="true">×</span>
          </button>
        </div>
        <div class="matrix-chip-line">
          <span class="matrix-chip-label mono mine">FROM</span>
          <span v-if="froms.length === 0" class="hint">未选</span>
          <button
            v-for="b in froms"
            :key="`f-${b}`"
            class="chip chip--mine"
            type="button"
            title="移除"
            @click="drop('from', b)"
          >
            {{ shortRef(b) }}<span class="chip-x" aria-hidden="true">×</span>
          </button>
        </div>
      </div>
    </div>

    <div v-if="survey" class="matrix-body">
      <div class="matrix-grid-wrap">
        <div class="matrix-stats">
          <span class="stat-pill" :class="summary.conflicts === 0 ? 'ok' : 'warn'">
            <strong>{{ summary.clean }}</strong> / {{ summary.total }} 干净
          </span>
          <span v-if="summary.conflicts > 0" class="stat-pill warn">
            <strong>{{ summary.conflicts }}</strong> 组冲突
          </span>
          <span v-if="doneCount > 0" class="stat-pill ok" title="已产出临时分支">
            已处理 <strong>{{ doneCount }}</strong>
          </span>
          <span v-if="mrDoneCount > 0" class="stat-pill ok">
            已提 MR <strong>{{ mrDoneCount }}</strong>
          </span>
          <span v-if="summary.files > 0" class="stat-pill">
            涉及 <strong>{{ summary.files }}</strong> 个文件
          </span>
          <span class="stat-pill">{{ survey.fetched ? "已 fetch" : "未 fetch" }}</span>
          <button
            v-if="pendingQueue.length > 0 || mrQueue.length > 0"
            class="btn"
            type="button"
            :disabled="busy"
            :title="nextActionHint"
            @click="nextAction"
          >
            {{ nextActionText }}
          </button>
        </div>

        <div class="matrix-scroll">
          <table class="matrix-table">
            <thead>
              <tr>
                <th class="matrix-corner mono">FROM \ INTO</th>
                <th v-for="i in resultIntos" :key="i" class="matrix-col-head" :title="i">
                  {{ shortRef(i) }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in rows" :key="row.from">
                <th class="matrix-row-head" :title="row.from">
                  {{ shortRef(row.from) }}
                </th>
                <td v-for="c in row.cells" :key="c.into" class="matrix-td">
                  <button
                    v-if="c.cell"
                    class="matrix-cell"
                    :class="[`matrix-cell--${c.cell.outcome}`, stageClass(c.cell)]"
                    type="button"
                    :title="cellTitle(c.cell)"
                    @click="activeCell = c.cell"
                  >
                    <span class="matrix-cell-text">
                      {{ STAGE_TEXT[stageOf(c.cell)] || OUTCOME_TEXT[c.cell.outcome] }}
                    </span>
                    <span v-if="stageMark(c.cell)" class="matrix-cell-n" aria-hidden="true">
                      {{ stageMark(c.cell) }}
                    </span>
                    <span v-else-if="c.cell.conflictPaths.length > 0" class="matrix-cell-n">
                      {{ c.cell.conflictPaths.length }}
                    </span>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <aside class="matrix-detail">
        <template v-if="activeCell">
          <h4 class="matrix-detail-title mono">
            <span class="mine">{{ shortRef(activeCell.from) }}</span>
            <span class="matrix-detail-arrow" aria-hidden="true">→</span>
            <span class="online">{{ shortRef(activeCell.into) }}</span>
          </h4>
          <p class="hint">
            {{ OUTCOME_TEXT[activeCell.outcome] }}
            <template v-if="activeCell.conflictPaths.length > 0">
              · {{ activeCell.conflictPaths.length }} 个文件
            </template>
          </p>
          <p v-if="activeCell.error" class="hint hint--danger">{{ activeCell.error }}</p>

          <!-- 干净且还没提过：这一格不用解决，直接就能提 MR -->
          <div v-if="activeStage === 'ready'" class="matrix-done">
            <p class="hint">
              这一对能干净合入，不用解决冲突，直接用
              <code>{{ shortRef(activeCell.from) }}</code> 提 MR 就行。
            </p>
            <button class="btn" type="button" :disabled="busy" @click="createMrActive">
              申请 MR
            </button>
          </div>

          <div v-else-if="activeStage !== 'open'" class="matrix-done">
            <span class="stat-pill ok">{{ STAGE_TEXT[activeStage] }}</span>
            <p v-if="activeTemp" class="hint">
              临时分支 <code>{{ activeTemp.name }}</code>
              {{ activeTemp.pushed ? "已推送。" : "只存在于本地。" }}
            </p>

            <!-- 没推上去就没法提 MR，只能回预演页重跑一次推送 -->
            <template v-if="activeStage === 'local'">
              <p class="hint">
                这条分支没推上远端，暂时提不了 MR。回预演页重跑一次「一键解决并推送」，
                或自己 <code>git push</code> 它。
              </p>
            </template>
            <template v-else-if="activeStage === 'resolved'">
              <p class="hint">
                <template v-if="activeTemp && !activeTemp.fresh">
                  这条分支是之前留下的，不保证基于两侧最新提交；拿不准就先「再看一遍预演」重解一次。
                </template>
                <template v-else>下一步：用这条临时分支申请 MR。</template>
              </p>
              <button class="btn" type="button" :disabled="busy" @click="createMrActive">
                申请 MR
              </button>
            </template>
            <template v-else>
              <p class="hint">
                {{
                  activeStage === "page"
                    ? "创建页已打开，请确认是否已在浏览器里提交。"
                    : "MR 已创建。"
                }}
              </p>
              <button
                v-if="activeMrUrl"
                class="btn secondary"
                type="button"
                @click="emit('openUrl', activeMrUrl)"
              >
                {{ activeStage === "page" ? "重新打开创建页" : "打开 MR" }}
              </button>
            </template>

            <p v-if="activeCell.outcome === 'conflicts'" class="hint">
              这一格底下仍是冲突：一键解决改的是临时分支，<code>{{
                shortRef(activeCell.from)
              }}</code>
              本身没动，要等 MR 合入、重跑矩阵才会变干净。
            </p>
          </div>

          <ul v-if="activeCell.conflictPaths.length > 0" class="matrix-paths">
            <li v-for="p in activeCell.conflictPaths" :key="p" :title="p">{{ p }}</li>
          </ul>
          <button
            v-if="activeCell.outcome === 'conflicts'"
            class="btn secondary"
            type="button"
            @click="goPreviewActive"
          >
            {{ activeTemp ? "再看一遍预演" : "去完整预演" }}
          </button>
        </template>

        <template v-else-if="order">
          <h4 class="matrix-detail-title mono">MERGE ORDER</h4>
          <p class="hint">
            建议顺序可连续干净合入
            <strong>{{ order.best.cleanPrefix }} / {{ orderTotal }}</strong>
            <template v-if="orderImproved">
              （原顺序 {{ order.baseline.cleanPrefix }}）
            </template>
          </p>
          <ol class="matrix-order">
            <li
              v-for="(s, idx) in order.best.steps"
              :key="`${s.from}-${idx}`"
              class="matrix-order-step"
              :class="`is-${s.outcome}`"
            >
              <span class="matrix-order-n mono">{{ idx + 1 }}</span>
              <span class="matrix-order-name" :title="s.from">{{ shortRef(s.from) }}</span>
              <span v-if="s.conflictPaths.length > 0" class="matrix-order-n2">
                {{ s.conflictPaths.length }}
              </span>
            </li>
            <li
              v-for="(name, idx) in order.best.order.slice(order.best.steps.length)"
              :key="`rest-${name}-${idx}`"
              class="matrix-order-step is-pending"
            >
              <span class="matrix-order-n mono">
                {{ order.best.steps.length + idx + 1 }}
              </span>
              <span class="matrix-order-name" :title="name">{{ shortRef(name) }}</span>
            </li>
          </ol>
          <p v-if="order.best.blockedAt" class="hint">
            从 <code>{{ order.best.blockedAt }}</code> 开始需要人工处理<template
              v-if="order.best.blockedReason"
              >：{{ order.best.blockedReason }}</template
            >。
          </p>
          <ul v-if="order.best.blockedPaths.length > 0" class="matrix-paths">
            <li v-for="p in order.best.blockedPaths" :key="p" :title="p">{{ p }}</li>
          </ul>
        </template>

        <p v-else class="hint">点格子看冲突文件，或点「算顺序」推演合入次序。</p>
      </aside>
    </div>

    <div v-else class="empty empty--fill">
      选好线上目标与我的分支，点「跑矩阵」一次看完所有组合。
    </div>
  </div>
</template>
