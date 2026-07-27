<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import BranchTreeSelect from "./BranchTreeSelect.vue";
import ConflictResolvePanel from "./ConflictResolvePanel.vue";
import CreateMrDialog, { type MrDialogDraft } from "./CreateMrDialog.vue";
import GitConfigPanel from "./GitConfigPanel.vue";
import GraphView from "./GraphView.vue";
import MarkdownView from "./MarkdownView.vue";
import type {
  AiResolveHunkResult,
  AiResolveRequestPayload,
} from "./conflict/aiResolveTypes";
import type { AiBridgeView } from "./AiResolveDialog.vue";
import { normalizeBranches, type BranchOption } from "./graph/branchTree";
import { overviewReport, pathReport } from "./graph/branchPathReport";
import type {
  BranchGraph,
  CliStatusPayload,
  ConflictBlameResult,
  GitInsightConfigView,
  HostMessage,
  TabId,
  TokenValidateView,
} from "./types";
import { getVsCodeApi } from "./vscode";

function short(sha: string): string {
  return sha.slice(0, 7);
}

function onApplyResolve(payload: {
  into: string;
  from: string;
  files: Array<{ path: string; resolvedContent: string }>;
  push: boolean;
}): void {
  loadingAction.value = "preview";
  vscode.postMessage({
    type: "applyResolve",
    into: payload.into,
    from: payload.from,
    files: payload.files,
    push: payload.push,
  });
}

const MAX_AI_HUNK_CHARS = 4000;

function truncateAiText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}\n…(已截断，共 ${text.length} 字)`;
}

/** 只截断单块文本，不再丢弃超限 hunk；宿主侧按批数/字符自动分批 */
function shrinkAiPayload(payload: AiResolveRequestPayload): AiResolveRequestPayload {
  const hunks = payload.hunks.map((h) => ({
    ...h,
    leftText: truncateAiText(h.leftText, MAX_AI_HUNK_CHARS),
    rightText: truncateAiText(h.rightText, MAX_AI_HUNK_CHARS),
    baseText: truncateAiText(h.baseText, Math.floor(MAX_AI_HUNK_CHARS / 2)),
    oursCommits: h.oursCommits.slice(0, 6),
    theirsCommits: h.theirsCommits.slice(0, 6),
  }));
  return { ...payload, hunks };
}

/** 等待宿主 pong；用于确认扩展宿主已加载且通道可用 */
function waitForPong(nonce: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMsg);
      reject(
        new Error(
          "宿主 ping 无响应。扩展宿主可能不是 0.1.1+，或面板连到了旧实例。\n" +
            "请：命令面板 → Developer: Reload Window，再打开 Git Insight 重试。\n" +
            "也可查看：查看 → 输出 → 下拉选「Git Insight」。",
        ),
      );
    }, timeoutMs);
    function onMsg(ev: MessageEvent): void {
      const msg = ev.data as HostMessage;
      if (msg?.type === "pong" && msg.nonce === nonce) {
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        resolve(msg.extensionVersion || "unknown");
      }
    }
    window.addEventListener("message", onMsg);
  });
}

function toPlainJson<T>(value: T): T {
  // postMessage 只能传结构化克隆数据；Vue reactive Proxy 会触发 DataCloneError
  return JSON.parse(JSON.stringify(value)) as T;
}

async function onAiResolve(payload: AiResolveRequestPayload): Promise<void> {
  aiBusy.value = true;
  aiProgressPercent.value = 0;
  aiProgressLabel.value = "检测宿主通道（ping）…";
  aiError.value = null;
  aiBridge.value = null;
  aiResultHunks.value = null;
  status.value = "AI 选边中…";
  error.value = null;
  if (aiWatchdog) {
    clearTimeout(aiWatchdog);
  }

  const nonce = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    vscode.postMessage(toPlainJson({ type: "ping" as const, nonce }));
    const ver = await waitForPong(nonce, 5_000);
    aiProgressPercent.value = 2;
    aiProgressLabel.value = `宿主已连通（v${ver}），发送冲突数据…`;
    status.value = aiProgressLabel.value;

    const slim = shrinkAiPayload(payload);
    aiProgressLabel.value = `宿主已连通（v${ver}），发送 ${slim.hunks.length} 个冲突块…`;
    status.value = aiProgressLabel.value;

    aiWatchdog = setTimeout(() => {
      if (aiBusy.value && (aiProgressPercent.value ?? 0) < 3) {
        aiBusy.value = false;
        aiError.value =
          "已 ping 通宿主，但 AI 请求无回执（可能被载荷拦截）。\n" +
          "请打开：查看 → 输出 →「Git Insight」，把日志复制给我。";
        status.value = "AI 选边失败：无回执";
        error.value = aiError.value;
      }
    }, 12_000);

    const msg = toPlainJson({
      type: "aiResolveConflicts" as const,
      into: slim.into,
      from: slim.from,
      rules: slim.rules,
      extraNotes: slim.extraNotes,
      hunks: slim.hunks,
    });
    vscode.postMessage(msg);
  } catch (err) {
    aiBusy.value = false;
    const raw = err instanceof Error ? err.message : String(err);
    aiError.value = /DataCloneError|could not be cloned/i.test(raw)
      ? `发送失败：消息里含无法克隆的数据（多为 Vue 响应式对象）。\n原始错误：${raw}`
      : raw;
    status.value = "AI 选边失败";
    error.value = aiError.value;
  }
}

function onRequestCreateMr(payload: { into: string; from: string }): void {
  if (!canCreateMr.value) {
    error.value = createMrBlockReason.value;
    status.value = createMrBlockReason.value;
    return;
  }
  mrBusy.value = true;
  vscode.postMessage({
    type: "prepareCreateMr",
    into: payload.into,
    from: payload.from,
    sourceBranch: lastTempBranch.value || undefined,
  });
}

function submitCreateMr(payload: {
  sourceBranch: string;
  targetBranch: string;
  title: string;
  reviewers: string[];
}): void {
  mrBusy.value = true;
  vscode.postMessage({
    type: "createMr",
    sourceBranch: payload.sourceBranch,
    targetBranch: payload.targetBranch,
    title: payload.title,
    reviewers: payload.reviewers,
  });
}

function openExternalUrl(url: string): void {
  vscode.postMessage({ type: "openExternal", url });
}

const vscode = getVsCodeApi();

const tab = ref<TabId>("config");
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
/** 服务端中文报告（备用）；画布交互以 overview / path 为准 */
const graphReport = ref("");
const selectedPath = ref<{ tipName: string; chain: string[] } | null>(null);
const preview = ref<ConflictBlameResult | null>(null);
/** 最近一次一键解决产生的临时分支，供申请 MR 默认源分支 */
const lastTempBranch = ref<string | null>(null);
const aiBusy = ref(false);
const aiProgressPercent = ref<number | null>(null);
const aiProgressLabel = ref("");
const aiResultToken = ref(0);
const aiResultHunks = ref<AiResolveHunkResult[] | null>(null);
const aiError = ref<string | null>(null);
const aiBridge = ref<AiBridgeView | null>(null);
let aiWatchdog: ReturnType<typeof setTimeout> | null = null;

function clearAiWatchdog(): void {
  if (aiWatchdog) {
    clearTimeout(aiWatchdog);
    aiWatchdog = null;
  }
}
/** 一键解决并推送是否已成功（与 into/from 绑定） */
const resolvePushDone = ref<{ into: string; from: string; tempBranch: string } | null>(
  null,
);
const mrDialogOpen = ref(false);
const mrDraft = ref<MrDialogDraft | null>(null);
const mrBusy = ref(false);

const gitConfig = ref<GitInsightConfigView | null>(null);
const cliStatus = ref<CliStatusPayload | null>(null);
const gitConfigPath = ref("");
const methodReady = ref(false);
const methodReadyReason = ref<string | undefined>(undefined);
const githubTokenStatus = ref<TokenValidateView | null>(null);
const gitlabTokenStatus = ref<TokenValidateView | null>(null);
/** 进入页面后对已有 Token 的预校验去重键 */
let lastTokenPrecheckKey = "";

const createMrBlockReason = computed(() => {
  if (previewMode.value) {
    return "预览模式不支持申请 MR";
  }
  if (!methodReady.value) {
    return methodReadyReason.value || "请先在「Git 配置」中选择并保存可用的 MR 方式";
  }
  // 有冲突时：必须先一键解决并推送；干净合并可直接申请（源=from）
  const hasConflicts =
    !!preview.value &&
    !preview.value.clean &&
    (preview.value.conflictFiles?.length ?? 0) > 0;
  if (hasConflicts) {
    if (
      !resolvePushDone.value ||
      resolvePushDone.value.into !== into.value ||
      resolvePushDone.value.from !== from.value
    ) {
      return "请先完成「一键解决并推送」后再申请 MR";
    }
  }
  return "";
});

const canCreateMr = computed(() => !createMrBlockReason.value);

const displayGraphReport = computed(() => {
  if (!graph.value) {
    return graphReport.value;
  }
  if (selectedPath.value) {
    return pathReport(graph.value, selectedPath.value.chain, selectedPath.value.tipName);
  }
  return overviewReport(graph.value);
});

function onGraphSelect(payload: { tipName: string; chain: string[] } | null): void {
  selectedPath.value = payload;
}

function onHostMessage(event: MessageEvent<HostMessage>) {
  const msg = event.data;
  if (!msg || typeof msg !== "object" || !("type" in msg)) {
    return;
  }

  if (msg.type === "focusTab") {
    tab.value =
      msg.tab === "preview" ? "preview" : msg.tab === "config" ? "config" : "graph";
    return;
  }
  if (msg.type === "busy") {
    busy.value = msg.busy;
    busyLabel.value = msg.label ?? "";
    if (typeof msg.percent === "number") {
      busyPercent.value = msg.percent;
    }
    if (aiBusy.value) {
      if (msg.label) {
        aiProgressLabel.value = msg.label;
      }
      if (typeof msg.percent === "number") {
        aiProgressPercent.value = msg.percent;
      }
      if (!msg.busy && aiProgressPercent.value != null && aiProgressPercent.value < 100) {
        // 宿主结束 busy；若尚未收到 result，保持 aiBusy 等 result/error
      }
    }
    if (!msg.busy) {
      loadingAction.value = "";
      busyPercent.value = null;
    }
    return;
  }
  if (msg.type === "pong") {
    // waitForPong 的独立 listener 会处理；此处忽略
    return;
  }
  if (msg.type === "progress") {
    busy.value = true;
    busyLabel.value = msg.label;
    busyPercent.value = msg.percent;
    if (aiBusy.value) {
      clearAiWatchdog();
      aiProgressLabel.value = msg.label || "AI 选边中…";
      aiProgressPercent.value = msg.percent;
      status.value = `${aiProgressLabel.value} ${Math.round(msg.percent)}%`;
    }
    return;
  }
  if (msg.type === "aiResolveBridgeReady") {
    clearAiWatchdog();
    aiBridge.value = {
      port: msg.port,
      callbackUrl: msg.callbackUrl,
      prompt: msg.prompt,
      promptFile: msg.promptFile,
      conflictsFile: msg.conflictsFile,
      openedChat: msg.openedChat,
      copied: msg.copied,
      pasted: msg.pasted,
      submitted: msg.submitted,
      batchIndex: msg.batchIndex,
      batchTotal: msg.batchTotal,
    };
    const batchPrefix =
      msg.batchTotal && msg.batchTotal > 1
        ? `第 ${msg.batchIndex ?? "?"}/${msg.batchTotal} 批 · `
        : "";
    if (msg.submitted) {
      aiProgressLabel.value = `${batchPrefix}已自动发送，监听 ${msg.callbackUrl}`;
    } else if (msg.pasted) {
      aiProgressLabel.value = `${batchPrefix}已粘贴到 Chat，监听 ${msg.callbackUrl}`;
    } else if (msg.copied) {
      aiProgressLabel.value = `${batchPrefix}已复制提示词，监听 ${msg.callbackUrl}`;
    } else {
      aiProgressLabel.value = `${batchPrefix}请复制提示词，监听 ${msg.callbackUrl}`;
    }
    aiProgressPercent.value = 30;
    status.value = aiProgressLabel.value;
    return;
  }
  if (msg.type === "aiResolveConflictsResult") {
    clearAiWatchdog();
    aiBusy.value = false;
    aiBridge.value = null;
    aiProgressPercent.value = 100;
    aiProgressLabel.value = "完成";
    aiResultHunks.value = msg.hunks;
    aiResultToken.value += 1;
    aiError.value = null;
    status.value = msg.model ? `AI 选边完成（${msg.model}）` : "AI 选边完成";
    busy.value = false;
    busyPercent.value = null;
    return;
  }
  if (msg.type === "error") {
    error.value = msg.message;
    status.value = msg.message;
    loadingAction.value = "";
    mrBusy.value = false;
    if (aiBusy.value) {
      clearAiWatchdog();
      aiBusy.value = false;
      aiBridge.value = null;
      aiError.value = msg.message;
      aiProgressPercent.value = null;
      aiProgressLabel.value = "";
    }
    return;
  }
  if (msg.type === "workspace") {
    if (cwd.value !== msg.cwd) {
      lastTokenPrecheckKey = "";
      githubTokenStatus.value = null;
      gitlabTokenStatus.value = null;
    }
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
    selectedPath.value = null;
    const tips = msg.data.tips.length;
    const fetchNote =
      msg.data.fetched === false
        ? "（未 fetch）"
        : msg.data.fetchOk === false
          ? "（fetch 失败，可能与线上不一致）"
          : msg.data.fetched
            ? "（已 fetch）"
            : "";
    status.value = msg.data.truncated
      ? `分支图已更新（${tips} 个分支 tip，提交元数据已截断）${fetchNote}`
      : `分支图已更新（${tips} 个分支 tip）${fetchNote}`;
    error.value =
      msg.data.fetched && msg.data.fetchOk === false
        ? msg.data.fetchError || "Fetch 失败，分支图可能落后于线上"
        : null;
    loadingAction.value = "";
    busyPercent.value = null;
    return;
  }
  if (msg.type === "applyResolveResult") {
    lastTempBranch.value = msg.tempBranch;
    if (msg.pushed) {
      resolvePushDone.value = {
        into: msg.into,
        from: msg.from,
        tempBranch: msg.tempBranch,
      };
      into.value = msg.into;
      from.value = msg.from;
    }
    status.value = [
      `一键解决完成：${msg.tempBranch}`,
      `commit ${short(msg.commitSha)}`,
      msg.pushed ? "已推送" : "未推送",
      msg.usedWorktree
        ? msg.previousBranch
          ? `主分支仍为 ${msg.previousBranch}`
          : "主工作区未切换"
        : null,
      msg.pushed ? "现在可以「一键申请 MR」" : "未推送成功，暂不可申请 MR",
    ]
      .filter(Boolean)
      .join(" · ");
    error.value = null;
    return;
  }
  if (msg.type === "gitConfigResult") {
    gitConfig.value = msg.config;
    cliStatus.value = msg.cliStatus;
    gitConfigPath.value = msg.configPath;
    methodReady.value = msg.methodReady;
    methodReadyReason.value = msg.methodReadyReason;
    if (msg.tokenValidation) {
      const v = msg.tokenValidation;
      if (v.platform === "github") {
        githubTokenStatus.value = v;
      } else {
        gitlabTokenStatus.value = v;
      }
      // 校验结果驱动 C 方案就绪态（比「仅有 token 文本」更准）
      if (msg.config.mrMethod === "token") {
        methodReady.value = v.ok;
        methodReadyReason.value = v.ok ? undefined : v.titleStatus || v.summary;
      }
    }
    status.value = methodReady.value
      ? `Git 配置已就绪（${msg.config.mrMethod ?? "未选"}）`
      : methodReadyReason.value || "请完善 Git 配置";
    maybePrecheckTokens(msg.config, msg.cliStatus);
    return;
  }
  if (msg.type === "tokenValidateResult") {
    const view: TokenValidateView = {
      ok: msg.ok,
      platform: msg.platform,
      formatOk: msg.formatOk,
      formatMessage: msg.formatMessage,
      apiChecked: msg.apiChecked,
      apiOk: msg.apiOk,
      login: msg.login,
      expiresAt: msg.expiresAt,
      expiresMessage: msg.expiresMessage,
      statusLabel: msg.statusLabel,
      error: msg.error,
      summary: msg.summary,
      titleStatus: msg.titleStatus,
    };
    if (msg.platform === "github") {
      githubTokenStatus.value = view;
    } else {
      gitlabTokenStatus.value = view;
    }
    if (gitConfig.value?.mrMethod === "token") {
      const plat = cliStatus.value?.platformHint;
      const relevant =
        plat === "gitlab"
          ? msg.platform === "gitlab"
          : plat === "github"
            ? msg.platform === "github"
            : true;
      if (relevant) {
        methodReady.value = msg.ok;
        methodReadyReason.value = msg.ok ? undefined : msg.titleStatus || msg.summary;
      }
    }
    status.value = msg.titleStatus || msg.summary;
    error.value = msg.ok ? null : msg.titleStatus || msg.summary;
    return;
  }
  if (msg.type === "downloadCliResult") {
    status.value = msg.messages.join(" · ") || `已下载 ${msg.kind}`;
    return;
  }
  if (msg.type === "prepareCreateMrResult") {
    mrBusy.value = false;
    mrDraft.value = {
      platform: msg.platform,
      cli: msg.cli,
      method: msg.method,
      sourceBranch: msg.sourceBranch,
      targetBranch: msg.targetBranch,
      title: msg.title,
      candidates: msg.candidates,
      createMrUrl: msg.createMrUrl,
      messages: msg.messages,
      cliError: msg.cliError,
    };
    mrDialogOpen.value = true;
    status.value = msg.method
      ? `已准备申请 MR（${msg.platform} / ${msg.method}）`
      : msg.cliError || "请检查 Git 配置";
    return;
  }
  if (msg.type === "createMrResult") {
    mrBusy.value = false;
    mrDialogOpen.value = false;
    status.value = [
      `MR 已创建：${msg.sourceBranch} → ${msg.targetBranch}`,
      msg.url ?? "",
    ]
      .filter(Boolean)
      .join(" · ");
    error.value = null;
    return;
  }
  if (msg.type === "previewResult") {
    preview.value = msg.data;
    // 换了一对分支预演时，需重新走一键推送才能申请 MR
    if (
      resolvePushDone.value &&
      (resolvePushDone.value.into !== msg.data.into ||
        resolvePushDone.value.from !== msg.data.from)
    ) {
      resolvePushDone.value = null;
    }
    into.value = msg.data.into;
    from.value = msg.data.from;
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

function saveGitConfig(payload: {
  mrMethod: GitInsightConfigView["mrMethod"];
  githubToken: string;
  gitlabToken: string;
  aiApiBaseUrl?: string;
  aiApiKey?: string;
  aiModel?: string;
}): void {
  vscode.postMessage({
    type: "saveGitConfig",
    config: payload,
  });
}

function validateToken(payload: {
  platform: "github" | "gitlab";
  githubToken: string;
  gitlabToken: string;
  persist: boolean;
  mrMethod: GitInsightConfigView["mrMethod"];
}): void {
  vscode.postMessage({
    type: "validateToken",
    platform: payload.platform,
    githubToken: payload.githubToken,
    gitlabToken: payload.gitlabToken,
    persist: payload.persist,
    mrMethod: payload.mrMethod,
  });
}

function clearTokenValidation(platform: "github" | "gitlab"): void {
  if (platform === "github") {
    githubTokenStatus.value = null;
  } else {
    gitlabTokenStatus.value = null;
  }
}

/** 进入配置时：若已有对应 Token，自动校验一次 */
function maybePrecheckTokens(
  config: GitInsightConfigView,
  status: CliStatusPayload,
): void {
  if (previewMode.value) {
    return;
  }
  const plat = status.platformHint;
  const gh = config.githubToken?.trim() ?? "";
  const gl = config.gitlabToken?.trim() ?? "";
  let platform: "github" | "gitlab" | null = null;
  let token = "";
  if (plat === "github" && gh) {
    platform = "github";
    token = gh;
  } else if (plat === "gitlab" && gl) {
    platform = "gitlab";
    token = gl;
  } else if (plat === "unknown") {
    if (gh) {
      platform = "github";
      token = gh;
    } else if (gl) {
      platform = "gitlab";
      token = gl;
    }
  }
  if (!platform || !token) {
    return;
  }
  const key = `${cwd.value ?? ""}|${platform}|${token}`;
  if (key === lastTokenPrecheckKey) {
    return;
  }
  // 已有成功校验结果则跳过
  if (platform === "github" && githubTokenStatus.value?.ok) {
    lastTokenPrecheckKey = key;
    return;
  }
  if (platform === "gitlab" && gitlabTokenStatus.value?.ok) {
    lastTokenPrecheckKey = key;
    return;
  }
  lastTokenPrecheckKey = key;
  validateToken({
    platform,
    githubToken: config.githubToken ?? "",
    gitlabToken: config.gitlabToken ?? "",
    persist: true,
    mrMethod: config.mrMethod,
  });
}

function refreshGitConfig(): void {
  vscode.postMessage({ type: "getGitConfig" });
}

function downloadCli(kind: "gh" | "glab"): void {
  vscode.postMessage({ type: "downloadCli", kind });
}

function cliAuthLogin(payload: { scope: "system" | "bundled"; kind: "gh" | "glab" }): void {
  vscode.postMessage({ type: "cliAuthLogin", ...payload });
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
      <button class="tab" :class="{ active: tab === 'config' }" @click="tab = 'config'">
        Git 配置
      </button>
      <button class="tab" :class="{ active: tab === 'graph' }" @click="tab = 'graph'">分支图</button>
      <button class="tab" :class="{ active: tab === 'preview' }" @click="tab = 'preview'">
        合并预演
      </button>
    </div>

    <div class="main" :class="{ 'main--full': tab === 'graph' || tab === 'config' }">
      <aside v-if="tab === 'preview'" class="sidebar">
        <label>
          目标分支（线上 / 合入目标）
          <BranchTreeSelect
            v-model="into"
            :branches="branches"
            :disabled="busy || !cwd"
            placeholder="选择线上目标分支，如 test…"
          />
        </label>
        <label>
          我的分支（待提交 / 待合入）
          <BranchTreeSelect
            v-model="from"
            :branches="branches"
            :disabled="busy || !cwd"
            placeholder="选择你要提交的功能分支…"
          />
        </label>
        <p class="hint">
          业务含义：把「我的分支」合进「线上目标」。选好后点顶部「开始预演」。
        </p>
      </aside>

      <section class="content">
        <template v-if="tab === 'config'">
          <GitConfigPanel
            :config="gitConfig"
            :cli-status="cliStatus"
            :config-path="gitConfigPath"
            :method-ready="methodReady"
            :method-ready-reason="methodReadyReason"
            :github-token-status="githubTokenStatus"
            :gitlab-token-status="gitlabTokenStatus"
            :busy="busy || mrBusy"
            :preview-mode="previewMode"
            @save="saveGitConfig"
            @validate-token="validateToken"
            @clear-token-validation="clearTokenValidation"
            @refresh="refreshGitConfig"
            @download-cli="downloadCli"
            @cli-auth-login="cliAuthLogin"
          />
        </template>

        <template v-if="tab === 'graph'">
          <div v-if="graph" class="panel-stack panel-stack--split">
            <div class="card card--viz">
              <h3>可视化（仅分支）</h3>
              <GraphView :graph="graph" @select="onGraphSelect" />
            </div>
            <div class="card card--report">
              <h3>{{ selectedPath ? "链路报告" : "总览报告" }}</h3>
              <div class="report-scroll">
                <MarkdownView :source="displayGraphReport" />
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
                  线上 {{ preview.into }} ({{ short(preview.intoSha) }}) ← 我的
                  {{ preview.from }} ({{ short(preview.fromSha) }})
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
                  无冲突，可以将我的分支 <code>{{ preview.from }}</code> 合入线上
                  <code>{{ preview.into }}</code>。
                </p>
                <p v-else>未检测到可解析的冲突文件内容。</p>
                <div v-if="preview.clean && !previewMode" class="btn-row" style="margin-top: 10px">
                  <button
                    type="button"
                    class="btn"
                    :disabled="busy || mrBusy || !canCreateMr"
                    :title="createMrBlockReason || '申请 MR'"
                    @click="onRequestCreateMr({ into: preview.into, from: preview.from })"
                  >
                    一键申请 MR
                  </button>
                  <span v-if="createMrBlockReason" class="muted">{{ createMrBlockReason }}</span>
                </div>
              </div>
            </div>

            <!-- 有冲突：上 7:3 摘要+解决头，下 文件列表+解决区 -->
            <ConflictResolvePanel
              v-else-if="cwd"
              :files="preview.conflictFiles"
              :cwd="cwd"
              :into="preview.into"
              :from="preview.from"
              :preview-mode="previewMode"
              :can-create-mr="canCreateMr"
              :create-mr-block-reason="createMrBlockReason"
              :ai-busy="aiBusy"
              :ai-progress-percent="aiProgressPercent"
              :ai-progress-label="aiProgressLabel"
              :ai-result-token="aiResultToken"
              :ai-result-hunks="aiResultHunks"
              :ai-error="aiError"
              :ai-bridge="aiBridge"
              @apply-resolve="onApplyResolve"
              @request-create-mr="onRequestCreateMr"
              @ai-resolve="onAiResolve"
              @ai-copy-prompt="vscode.postMessage({ type: 'aiResolveCopyPrompt' })"
              @ai-cancel-bridge="
                vscode.postMessage({ type: 'aiResolveCancelBridge' });
                aiBusy = false;
                aiBridge = null;
              "
              @ai-submit-paste="
                (t) => vscode.postMessage({ type: 'aiResolveSubmitPaste', text: t })
              "
              @clear-ai-error="
                aiError = null;
                aiBridge = null;
                aiProgressLabel = '';
                aiProgressPercent = null;
              "
            >
              <template #summary>
                <div class="card preview-summary">
                  <h3>
                    合并预演结果
                    <span class="badge danger">{{ preview.conflictFiles.length }} 个冲突</span>
                  </h3>
                  <p class="mono">
                    线上 {{ preview.into }} ({{ short(preview.intoSha) }}) ← 我的
                    {{ preview.from }} ({{ short(preview.fromSha) }})
                  </p>
                  <p class="mono">
                    merge-base:
                    {{ preview.mergeBase ? short(preview.mergeBase) : "（无共同祖先）" }}
                  </p>
                </div>
              </template>
            </ConflictResolvePanel>
          </div>
          <div v-else class="empty empty--fill">
            选择线上目标分支与我的分支后，点击「开始预演」
          </div>
        </template>
      </section>
    </div>

    <CreateMrDialog
      :open="mrDialogOpen"
      :draft="mrDraft"
      :busy="mrBusy || busy"
      @close="mrDialogOpen = false"
      @submit="submitCreateMr"
      @open-url="openExternalUrl"
    />
  </div>
</template>
