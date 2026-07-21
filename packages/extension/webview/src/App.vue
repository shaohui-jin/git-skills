<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import BranchTreeSelect from "./BranchTreeSelect.vue";
import GraphView from "./GraphView.vue";
import MarkdownView from "./MarkdownView.vue";
import type {
  BranchGraph,
  ConflictBlameResult,
  ConflictFile,
  ConflictHunk,
  HostMessage,
  TabId,
} from "./types";
import { getVsCodeApi, isDemoMode } from "./vscode";

function short(sha: string): string {
  return sha.slice(0, 7);
}

function fileHunks(f: ConflictFile, all: ConflictHunk[]): ConflictHunk[] {
  return f.hunks.length > 0 ? f.hunks : all.filter((h) => h.path === f.path);
}

const vscode = getVsCodeApi();
const demoMode = isDemoMode();

const tab = ref<TabId>("graph");
const cwd = ref<string | null>(null);
const pathInput = ref("");
const branches = ref<string[]>([]);
const into = ref("");
const from = ref("");
const busy = ref(false);
const busyLabel = ref("");
const error = ref<string | null>(null);
const status = ref("准备就绪");
const previewMode = ref(false);

const graph = ref<BranchGraph | null>(null);
const graphReport = ref("");
const preview = ref<ConflictBlameResult | null>(null);
const previewReport = ref("");

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
    return;
  }
  if (msg.type === "error") {
    error.value = msg.message;
    status.value = msg.message;
    return;
  }
  if (msg.type === "workspace") {
    cwd.value = msg.cwd;
    branches.value = msg.branches;
    previewMode.value = !!msg.previewMode;
    if (msg.cwd) {
      pathInput.value = msg.cwd;
    }
    if (msg.error) {
      error.value = msg.error;
      status.value = msg.error;
    } else {
      error.value = null;
      status.value = msg.cwd ? `仓库：${msg.cwd}` : "未检测到仓库，请选择或输入目录";
      if (into.value && !msg.branches.includes(into.value)) {
        into.value = "";
      }
      if (from.value && !msg.branches.includes(from.value)) {
        from.value = "";
      }
      if (!into.value) {
        into.value = msg.branches.find((b) => !b.includes("/")) ?? msg.branches[0] ?? "";
      }
      if (!from.value) {
        from.value = msg.branches.find((b) => b !== into.value) ?? "";
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
    status.value = `分支图已更新（${msg.data.nodes.length} 节点）`;
    error.value = null;
    return;
  }
  if (msg.type === "previewResult") {
    preview.value = msg.data;
    previewReport.value = msg.report;
    if (msg.data.unrelatedHistories || msg.data.outcome === "unrelated") {
      status.value = "合并预演：无关历史（无共同祖先）";
      error.value = "两条分支没有共同祖先，详见报告";
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
  // 分支图与侧栏 into/from 无关：始终加载全库 tip 图；默认 fetch
  vscode.postMessage({ type: "graph" });
}

function runPreview() {
  // 默认 fetch（不传 noFetch）
  vscode.postMessage({
    type: "preview",
    into: into.value,
    from: from.value,
  });
}
</script>

<template>
  <div class="app">
    <div v-if="demoMode" class="demo-banner">
      当前为<strong>离线样例</strong>（无真实 git）。请本地运行 <code>pnpm preview</code>。
    </div>
    <header class="topbar">
      <div class="topbar-path">
        <input
          v-model="pathInput"
          class="path"
          type="text"
          :title="cwd ?? pathInput"
          :placeholder="
            demoMode
              ? '离线样例 — 无真实 git'
              : '本机路径，或 GitHub：owner/repo / https://github.com/owner/repo'
          "
          :disabled="demoMode"
          @keyup.enter="openByPath"
        />
        <button class="btn secondary" :disabled="busy || demoMode" @click="openByPath">打开</button>
        <button
          class="btn secondary"
          :disabled="busy || demoMode"
          title="系统目录对话框（本地预览可用；云端请填 GitHub 地址）"
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
          :disabled="busy || !cwd"
          @click="loadGraph"
        >
          加载分支图
        </button>
        <button
          v-else
          class="btn"
          :disabled="busy || !cwd || !into || !from"
          @click="runPreview"
        >
          开始预演
        </button>
      </div>
    </header>

    <div class="status" :class="{ error: !!error }">
      {{ busy ? busyLabel || "处理中…" : status }}
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
          <div v-if="preview" class="panel-stack panel-stack--split">
            <div class="preview-main">
              <div class="card">
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

              <div
                v-if="preview.unrelatedHistories || preview.outcome === 'unrelated'"
                class="card"
              >
                <p>
                  两条分支没有共同祖先（<code>git merge-base</code> 失败）。完整说明见右侧报告。
                </p>
              </div>

              <div v-else-if="preview.clean" class="card">
                <p>
                  无冲突，可以将 <code>{{ preview.from }}</code> 合入
                  <code>{{ preview.into }}</code>。
                </p>
              </div>

              <template v-if="!preview.clean && preview.conflictFiles.length > 0">
                <div class="card">
                  <h3>冲突文件</h3>
                  <ul>
                    <li v-for="f in preview.conflictFiles" :key="f.path" class="mono">
                      {{ f.path }}
                    </li>
                  </ul>
                </div>

                <div
                  v-for="f in preview.conflictFiles"
                  :key="`detail-${f.path}`"
                  class="card conflict-card"
                >
                  <h3 class="mono">{{ f.path }}</h3>

                  <div
                    v-for="(h, idx) in fileHunks(f, preview.blamed ?? [])"
                    :key="`${f.path}-h-${idx}`"
                    class="hunk"
                  >
                    <div class="mono">
                      目标行 {{ h.oursRange[0] }}-{{ h.oursRange[1] }} · 待合并行
                      {{ h.theirsRange[0] }}-{{ h.theirsRange[1] }}
                    </div>
                    <div class="hunk-cols">
                      <div>
                        <div class="muted">目标侧写入</div>
                        <ul>
                          <li v-for="c in h.oursCommits" :key="c.sha" class="mono">
                            {{ short(c.sha) }} {{ c.author }}{{ c.pr ? ` ${c.pr}` : "" }}
                            {{ c.message ?? "" }}
                          </li>
                        </ul>
                      </div>
                      <div>
                        <div class="muted">待合并侧写入</div>
                        <ul>
                          <li v-for="c in h.theirsCommits" :key="c.sha" class="mono">
                            {{ short(c.sha) }} {{ c.author }}{{ c.pr ? ` ${c.pr}` : "" }}
                            {{ c.message ?? "" }}
                          </li>
                        </ul>
                      </div>
                    </div>
                  </div>

                  <div class="conflict-body">
                    <div class="muted">冲突内容</div>
                    <pre v-if="f.conflictContent" class="conflict-pre">{{ f.conflictContent }}</pre>
                    <p v-else class="muted">未能生成冲突标记文本</p>
                  </div>
                </div>
              </template>
            </div>

            <div class="card card--report card--report-fill">
              <h3>完整报告</h3>
              <div class="report-scroll">
                <MarkdownView :source="previewReport" />
              </div>
            </div>
          </div>
          <div v-else class="empty empty--fill">选择目标 / 待合并分支后点击「开始预演」</div>
        </template>
      </section>
    </div>
  </div>
</template>
