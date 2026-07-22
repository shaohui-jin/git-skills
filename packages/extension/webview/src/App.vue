<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import BranchTreeSelect from "./BranchTreeSelect.vue";
import ConflictResolvePanel from "./ConflictResolvePanel.vue";
import GraphView from "./GraphView.vue";
import MarkdownView from "./MarkdownView.vue";
import { normalizeBranches, type BranchOption } from "./graph/branchTree";
import type {
  BranchGraph,
  ConflictBlameResult,
  HostMessage,
  TabId,
} from "./types";
import { getVsCodeApi } from "./vscode";

function short(sha: string): string {
  return sha.slice(0, 7);
}

const vscode = getVsCodeApi();

const tab = ref<TabId>("graph");
const cwd = ref<string | null>(null);
const pathInput = ref("");
const branches = ref<BranchOption[]>([]);
const into = ref("");
const from = ref("");
const busy = ref(false);
const busyLabel = ref("");
const busyPercent = ref<number | null>(null);
/** 当前主操作，用于按钮上的 loading 文案 */
const loadingAction = ref<"graph" | "preview" | "">("");
const error = ref<string | null>(null);
const status = ref("准备就绪");
const previewMode = ref(false);

const graph = ref<BranchGraph | null>(null);
const graphReport = ref("");
const preview = ref<ConflictBlameResult | null>(null);

function onHostMessage(event: MessageEvent<HostMessage>) {
  const msg = event.data;
  if (!msg || typeof msg !== "object" || !("type" in msg)) {
    return;
  }

  if (msg.type === "focusTab") {
    tab.value = msg.tab === "preview" ? "preview" : "graph";
    return;
  }
  if (msg.type === "busy") {
    busy.value = msg.busy;
    busyLabel.value = msg.label ?? "";
    if (typeof msg.percent === "number") {
      busyPercent.value = msg.percent;
    }
    if (!msg.busy) {
      loadingAction.value = "";
      busyPercent.value = null;
    }
    return;
  }
  if (msg.type === "progress") {
    busy.value = true;
    busyLabel.value = msg.label;
    busyPercent.value = msg.percent;
    return;
  }
  if (msg.type === "error") {
    error.value = msg.message;
    status.value = msg.message;
    loadingAction.value = "";
    return;
  }
  if (msg.type === "workspace") {
    cwd.value = msg.cwd;
    branches.value = normalizeBranches(msg.branches);
    previewMode.value = !!msg.previewMode;
    if (msg.cwd) {
      pathInput.value = msg.cwd;
    }
    if (msg.error) {
      error.value = msg.error;
      status.value = msg.error;
    } else {
      error.value = null;
      const localCount = msg.branches.filter((b) => !b.remote).length;
      const remoteCount = msg.branches.length - localCount;
      status.value = msg.cwd
        ? `仓库：${msg.cwd}（本地 ${localCount} / 远程 ${remoteCount}）`
        : "未检测到仓库，请选择或输入目录";
      const names = msg.branches.map((b) => b.name);
      if (into.value && !names.includes(into.value)) {
        into.value = "";
      }
      if (from.value && !names.includes(from.value)) {
        from.value = "";
      }
      if (!into.value) {
        into.value =
          msg.branches.find((b) => !b.remote)?.name ?? msg.branches[0]?.name ?? "";
      }
      if (!from.value) {
        from.value =
          msg.branches.find((b) => b.name !== into.value)?.name ?? "";
      }
    }
    return;
  }
  if (msg.type === "fetchResult") {
    status.value = msg.data.ok
      ? `Fetch 成功（${msg.data.remote}）`
      : `Fetch 失败：${msg.data.stderr || "见报告"}`;
    error.value = msg.data.ok ? null : msg.data.stderr || "fetch 失败";
    return;
  }
  if (msg.type === "graphResult") {
    graph.value = msg.data;
    graphReport.value = msg.report;
    status.value = msg.data.truncated
      ? `分支图已更新（${msg.data.nodes.length} 节点，已截断）`
      : `分支图已更新（${msg.data.nodes.length} 节点，全量）`;
    error.value = null;
    loadingAction.value = "";
    busyPercent.value = null;
    return;
  }
  if (msg.type === "previewResult") {
    preview.value = msg.data;
    loadingAction.value = "";
    busyPercent.value = null;
    if (msg.data.unrelatedHistories || msg.data.outcome === "unrelated") {
      status.value = "合并预演：无关历史（无共同祖先）";
      error.value = "两条分支没有共同祖先";
    } else if (msg.data.clean) {
      status.value = "可干净合并";
      error.value = null;
    } else {
      status.value = `合并预演：${msg.data.conflictFiles.length} 个冲突文件`;
      error.value = `存在冲突（${msg.data.conflictFiles.length}）`;
    }
    return;
  }
}

onMounted(() => {
  window.addEventListener("message", onHostMessage as EventListener);
  vscode.postMessage({ type: "ready" });
});

onUnmounted(() => {
  window.removeEventListener("message", onHostMessage as EventListener);
});

function openByPath() {
  const path = pathInput.value.trim();
  if (!path) {
    error.value = "请输入本机路径或 GitHub 仓库（owner/repo）";
    return;
  }
  vscode.postMessage({ type: "setCwd", path });
}

function pickFolder() {
  vscode.postMessage({ type: "pickFolder" });
}

function loadGraph() {
  busy.value = true;
  busyLabel.value = "正在加载全量分支图…";
  busyPercent.value = 0;
  loadingAction.value = "graph";
  vscode.postMessage({ type: "graph", maxNodes: 0 });
}

function runPreview() {
  busy.value = true;
  busyLabel.value = "合并预演中…";
  busyPercent.value = 0;
  loadingAction.value = "preview";
  vscode.postMessage({
    type: "preview",
    into: into.value,
    from: from.value,
  });
}

function actionButtonText(kind: "graph" | "preview"): string {
  if (loadingAction.value !== kind) {
    return kind === "graph" ? "加载分支图" : "开始预演";
  }
  const pct =
    busyPercent.value != null && busyPercent.value >= 0
      ? `${busyPercent.value}%`
      : "";
  if (kind === "graph") {
    return pct ? `加载中 ${pct}` : "加载中…";
  }
  return pct ? `预演中 ${pct}` : "预演中…";
}

function statusBusyText(): string {
  const pct =
    busyPercent.value != null && busyPercent.value >= 0
      ? ` ${busyPercent.value}%`
      : "";
  return `${busyLabel.value || "处理中…"}${pct}`;
}
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="topbar-path">
        <input
          v-model="pathInput"
          class="path"
          type="text"
          :title="cwd ?? pathInput"
          placeholder="本机路径，或 GitHub：owner/repo / https://github.com/owner/repo"
          @keyup.enter="openByPath"
        />
        <button class="btn secondary" :disabled="busy" @click="openByPath">打开</button>
        <button
          class="btn secondary"
          :disabled="busy"
          title="系统目录对话框（不依赖浏览器 HTTPS）"
          @click="pickFolder"
        >
          浏览…
        </button>
      </div>
      <div class="topbar-actions">
        <button
          class="btn secondary"
          :disabled="busy || !cwd"
          @click="vscode.postMessage({ type: 'refreshWorkspace' })"
        >
          刷新分支
        </button>
        <button
          class="btn secondary"
          :disabled="busy || !cwd"
          title="手动再 fetch 一次（加载图/预演已默认 fetch）"
          @click="vscode.postMessage({ type: 'fetch' })"
        >
          Fetch
        </button>
        <button
          v-if="tab === 'graph'"
          class="btn"
          :class="{ loading: loadingAction === 'graph' }"
          :disabled="busy || !cwd"
          :title="loadingAction === 'graph' ? busyLabel : undefined"
          @click="loadGraph"
        >
          <span v-if="loadingAction === 'graph'" class="btn-spinner" aria-hidden="true" />
          {{ actionButtonText("graph") }}
        </button>
        <button
          v-else
          class="btn"
          :class="{ loading: loadingAction === 'preview' }"
          :disabled="busy || !cwd || !into || !from"
          :title="loadingAction === 'preview' ? busyLabel : undefined"
          @click="runPreview"
        >
          <span v-if="loadingAction === 'preview'" class="btn-spinner" aria-hidden="true" />
          {{ actionButtonText("preview") }}
        </button>
      </div>
    </header>

    <div class="status" :class="{ error: !!error }">
      <template v-if="busy">
        <span>{{ statusBusyText() }}</span>
        <span
          v-if="busyPercent != null"
          class="status-bar"
          :style="{ '--pct': `${busyPercent}%` }"
          aria-hidden="true"
        />
      </template>
      <template v-else>{{ status }}</template>
    </div>

    <div class="tabs">
      <button class="tab" :class="{ active: tab === 'graph' }" @click="tab = 'graph'">分支图</button>
      <button class="tab" :class="{ active: tab === 'preview' }" @click="tab = 'preview'">
        合并预演
      </button>
    </div>

    <div class="main" :class="{ 'main--full': tab === 'graph' }">
      <aside v-if="tab === 'preview'" class="sidebar">
        <label>
          目标分支 (--into)
          <BranchTreeSelect
            v-model="into"
            :branches="branches"
            :disabled="busy || !cwd"
            placeholder="选择目标分支…"
          />
        </label>
        <label>
          待合并分支 (--from)
          <BranchTreeSelect
            v-model="from"
            :branches="branches"
            :disabled="busy || !cwd"
            placeholder="选择待合并分支…"
          />
        </label>
        <p class="hint">选择两分支后点顶部「开始预演」：冲突文件、正文与来源溯源。</p>
      </aside>

      <section class="content">
        <template v-if="tab === 'graph'">
          <div v-if="graph" class="panel-stack panel-stack--split">
            <div class="card card--viz">
              <h3>可视化</h3>
              <GraphView :graph="graph" />
            </div>
            <div class="card card--report">
              <h3>报告</h3>
              <div class="report-scroll">
                <MarkdownView :source="graphReport" />
              </div>
            </div>
          </div>
          <div v-else class="empty empty--fill">打开仓库后，点顶部「加载分支图」</div>
        </template>

        <template v-if="tab === 'preview'">
          <div v-if="preview" class="preview-host">
            <!-- 正常：纵向全宽 -->
            <div
              v-if="preview.clean || preview.conflictFiles.length === 0"
              class="preview-pane preview-pane--clean"
            >
              <div class="card preview-summary">
                <h3>
                  合并预演结果
                  <span
                    class="badge"
                    :class="
                      preview.clean
                        ? 'ok'
                        : preview.unrelatedHistories || preview.outcome === 'unrelated'
                          ? 'warn'
                          : 'danger'
                    "
                  >
                    {{
                      preview.unrelatedHistories || preview.outcome === "unrelated"
                        ? "无关历史"
                        : preview.clean
                          ? "可干净合并"
                          : `${preview.conflictFiles.length} 个冲突`
                    }}
                  </span>
                </h3>
                <p class="mono">
                  {{ preview.into }} ({{ short(preview.intoSha) }}) ← {{ preview.from }} ({{
                    short(preview.fromSha)
                  }})
                </p>
                <p class="mono">
                  merge-base:
                  {{ preview.mergeBase ? short(preview.mergeBase) : "（无共同祖先）" }}
                </p>
              </div>
              <div class="card preview-desc">
                <p v-if="preview.unrelatedHistories || preview.outcome === 'unrelated'">
                  两条分支没有共同祖先（<code>git merge-base</code> 失败）。常见原因：历史被替换，或来自不同根提交。
                </p>
                <p v-else-if="preview.clean">
                  无冲突，可以将 <code>{{ preview.from }}</code> 合入
                  <code>{{ preview.into }}</code>。
                </p>
                <p v-else>未检测到可解析的冲突文件内容。</p>
              </div>
            </div>

            <!-- 有冲突：上 7:3 摘要+解决头，下 文件列表+解决区 -->
            <ConflictResolvePanel
              v-else-if="cwd"
              :files="preview.conflictFiles"
              :cwd="cwd"
              :into="preview.into"
              :from="preview.from"
            >
              <template #summary>
                <div class="card preview-summary">
                  <h3>
                    合并预演结果
                    <span class="badge danger">{{ preview.conflictFiles.length }} 个冲突</span>
                  </h3>
                  <p class="mono">
                    {{ preview.into }} ({{ short(preview.intoSha) }}) ← {{ preview.from }} ({{
                      short(preview.fromSha)
                    }})
                  </p>
                  <p class="mono">
                    merge-base:
                    {{ preview.mergeBase ? short(preview.mergeBase) : "（无共同祖先）" }}
                  </p>
                </div>
              </template>
            </ConflictResolvePanel>
          </div>
          <div v-else class="empty empty--fill">选择目标 / 待合并分支后点击「开始预演」</div>
        </template>
      </section>
    </div>
  </div>
</template>
