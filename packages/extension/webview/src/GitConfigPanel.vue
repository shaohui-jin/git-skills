<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { CliStatusPayload, GitInsightConfigView, TokenValidateView } from "./types";

const props = defineProps<{
  config: GitInsightConfigView | null;
  cliStatus: CliStatusPayload | null;
  configPath: string;
  methodReady: boolean;
  methodReadyReason?: string;
  githubTokenStatus?: TokenValidateView | null;
  gitlabTokenStatus?: TokenValidateView | null;
  busy?: boolean;
  previewMode?: boolean;
}>();

const emit = defineEmits<{
  save: [
    payload: {
      mrMethod: GitInsightConfigView["mrMethod"];
      githubToken: string;
      gitlabToken: string;
      defaultRemote: string;
      aiApiBaseUrl: string;
      aiApiKey: string;
      aiModel: string;
    },
  ];
  validateToken: [
    payload: {
      platform: "github" | "gitlab";
      githubToken: string;
      gitlabToken: string;
      persist: boolean;
      mrMethod: GitInsightConfigView["mrMethod"];
    },
  ];
  clearTokenValidation: [platform: "github" | "gitlab"];
  downloadCli: [kind: "gh" | "glab"];
  cliAuthLogin: [payload: { scope: "system" | "bundled"; kind: "gh" | "glab" }];
  refresh: [];
  openUrl: [url: string];
}>();

const method = ref<GitInsightConfigView["mrMethod"]>(null);
const githubToken = ref("");
const gitlabToken = ref("");
const defaultRemote = ref("origin");
const aiApiBaseUrl = ref("https://api.openai.com/v1");
const aiApiKey = ref("");
const aiModel = ref("gpt-4o-mini");
const githubChecking = ref(false);
const gitlabChecking = ref(false);

const remoteList = computed(() => props.cliStatus?.remotes ?? []);
const hasRepoRemotes = computed(() => remoteList.value.length > 0);
const aiSectionOpen = ref(false);

const selectedRemoteInfo = computed(() => {
  const name = defaultRemote.value.trim();
  return remoteList.value.find((r) => r.name === name) ?? remoteList.value[0] ?? null;
});

const selectedRemoteUrl = computed(() => {
  const r = selectedRemoteInfo.value;
  if (!r) {
    return "";
  }
  return r.fetchUrl || r.pushUrl || "";
});

/** 与宿主一致：未选过时，有本机 gh/glab → A，否则 → D */
function suggestDefaultMethod(): NonNullable<GitInsightConfigView["mrMethod"]> {
  const s = props.cliStatus;
  if (!s) {
    return "browser";
  }
  const hint = s.platformHint;
  if (hint === "github" && s.systemGh.installed) {
    return "cli";
  }
  if (hint === "gitlab" && s.systemGlab.installed) {
    return "cli";
  }
  if (hint === "unknown" && (s.systemGh.installed || s.systemGlab.installed)) {
    return "cli";
  }
  return "browser";
}

watch(
  () => [props.config, props.cliStatus] as const,
  ([c, status]) => {
    if (!c) {
      return;
    }
    method.value = c.mrMethod ?? suggestDefaultMethod();
    githubToken.value = c.githubToken ?? "";
    gitlabToken.value = c.gitlabToken ?? "";
    defaultRemote.value =
      status?.defaultRemote || c.defaultRemote?.trim() || "origin";
    aiApiBaseUrl.value = c.aiApiBaseUrl ?? "https://api.openai.com/v1";
    aiApiKey.value = c.aiApiKey ?? "";
    aiModel.value = c.aiModel ?? "gpt-4o-mini";
  },
  { immediate: true },
);

watch(
  () => props.githubTokenStatus,
  () => {
    githubChecking.value = false;
  },
);
watch(
  () => props.gitlabTokenStatus,
  () => {
    gitlabChecking.value = false;
  },
);

/** 用户手动选择的平台覆盖（仅在自动探测为 unknown 时显示选择器） */
const manualPlatform = ref<"github" | "gitlab" | null>(null);

/** 生效的平台：手动选择优先，否则用自动探测结果 */
const platform = computed(() => {
  return manualPlatform.value ?? props.cliStatus?.platformHint ?? "unknown";
});

function setManualPlatform(p: "github" | "gitlab"): void {
  manualPlatform.value = p;
}

function cliStatusText(c: { installed: boolean; loggedIn: boolean } | undefined): string {
  if (!c?.installed) {
    return "未安装";
  }
  return c.loggedIn ? "已登录" : "已安装未登录";
}

function bundledStatusText(c: { installed: boolean; loggedIn: boolean } | undefined): string {
  if (!c?.installed) {
    return "未下载";
  }
  return c.loggedIn ? "已登录" : "已下载未登录";
}

const neededKind = computed((): "gh" | "glab" | "both" | null => {
  if (platform.value === "gitlab") {
    return "glab";
  }
  if (platform.value === "github") {
    return "gh";
  }
  // unknown 时返回 both，让用户选择下载哪个 CLI
  return "both";
});

const systemTarget = computed(() => {
  const s = props.cliStatus;
  if (!s) {
    return null;
  }
  if (neededKind.value === "gh") {
    return { kind: "gh" as const, ...s.systemGh };
  }
  if (neededKind.value === "glab") {
    return { kind: "glab" as const, ...s.systemGlab };
  }
  // both：unknown 时优先选已安装的
  if (s.systemGh.installed && !s.systemGh.loggedIn) {
    return { kind: "gh" as const, ...s.systemGh };
  }
  if (s.systemGlab.installed && !s.systemGlab.loggedIn) {
    return { kind: "glab" as const, ...s.systemGlab };
  }
  if (s.systemGh.installed) {
    return { kind: "gh" as const, ...s.systemGh };
  }
  if (s.systemGlab.installed) {
    return { kind: "glab" as const, ...s.systemGlab };
  }
  return null;
});

const bundledTarget = computed(() => {
  const s = props.cliStatus;
  if (!s) {
    return null;
  }
  if (neededKind.value === "gh") {
    return { kind: "gh" as const, ...s.bundledGh };
  }
  if (neededKind.value === "glab") {
    return { kind: "glab" as const, ...s.bundledGlab };
  }
  // both：unknown 时优先选已下载的
  if (s.bundledGh.installed && !s.bundledGh.loggedIn) {
    return { kind: "gh" as const, ...s.bundledGh };
  }
  if (s.bundledGlab.installed && !s.bundledGlab.loggedIn) {
    return { kind: "glab" as const, ...s.bundledGlab };
  }
  if (s.bundledGh.installed) {
    return { kind: "gh" as const, ...s.bundledGh };
  }
  if (s.bundledGlab.installed) {
    return { kind: "glab" as const, ...s.bundledGlab };
  }
  return null;
});

const githubEnabled = computed(
  () => platform.value === "github" || platform.value === "unknown",
);
const gitlabEnabled = computed(
  () => platform.value === "gitlab" || platform.value === "unknown",
);

function githubTokenCreateUrl(): string {
  return "https://github.com/settings/tokens/new?scopes=repo&description=Git%20Insight";
}

function gitlabTokenCreateUrl(): string {
  const origin = props.cliStatus?.remoteWebOrigin?.trim() || "https://gitlab.com";
  return `${origin.replace(/\/+$/, "")}/-/user_settings/personal_access_tokens`;
}

function openTokenCreatePage(which: "github" | "gitlab"): void {
  emit("openUrl", which === "github" ? githubTokenCreateUrl() : gitlabTokenCreateUrl());
}

/** C 可用：对应平台 Token 校验通过（校验中不算就绪） */
const tokenReady = computed(() => {
  if (platform.value === "github") {
    return !githubChecking.value && props.githubTokenStatus?.ok === true;
  }
  if (platform.value === "gitlab") {
    return !gitlabChecking.value && props.gitlabTokenStatus?.ok === true;
  }
  return (
    (!githubChecking.value && props.githubTokenStatus?.ok === true) ||
    (!gitlabChecking.value && props.gitlabTokenStatus?.ok === true)
  );
});

const options = computed(() => {
  const s = props.cliStatus;
  return [
    {
      id: "cli" as const,
      title: "A. 本机已安装的 gh / glab",
      desc: "优先使用 PATH 中已登录的 CLI（推荐）",
      ready: !!s?.systemCliOk,
      detail: s
        ? `gh: ${cliStatusText(s.systemGh)}；glab: ${cliStatusText(s.systemGlab)}`
        : "",
    },
    {
      id: "download-cli" as const,
      title: "B. 下载 CLI 到扩展目录",
      desc: "首次使用时下载到 Cursor 扩展存储，不占用系统 PATH",
      ready: !!s?.bundledCliOk,
      detail: s
        ? `扩展内 gh: ${bundledStatusText(s.bundledGh)}；glab: ${bundledStatusText(s.bundledGlab)}`
        : "",
    },
    {
      id: "token" as const,
      title: "C. Token（API）",
      desc:
        platform.value === "github"
          ? "仅可填写 GitHub Token；修改后触发校验并保存"
          : platform.value === "gitlab"
            ? "仅可填写 GitLab Token（须 glpat- 前缀）；修改后触发校验并保存"
            : "远程平台未识别，可填写任一 Token；修改后触发校验并保存",
      ready: !!tokenReady.value,
      detail: `当前远程倾向：${platform.value}`,
    },
    {
      id: "browser" as const,
      title: "D. 仅打开浏览器创建页",
      desc: "不自动建单，打开预填分支的网页由你提交",
      ready: true,
      detail: "无需 CLI / Token",
    },
  ];
  // 当平台为 unknown 时，在选项列表末尾追加平台选择说明
  if (platform.value === "unknown" && s) {
    options.push({
      id: "__platform_picker" as any,
      title: "远程平台识别",
      desc: "未能自动识别远程平台，请手动选择",
      ready: true,
      detail: "",
    });
  }
  return options;
});

function persistConfig(): void {
  if (props.previewMode) {
    return;
  }
  emit("save", {
    mrMethod: method.value,
    githubToken: githubToken.value,
    gitlabToken: gitlabToken.value,
    defaultRemote: defaultRemote.value.trim() || "origin",
    aiApiBaseUrl: aiApiBaseUrl.value,
    aiApiKey: aiApiKey.value,
    aiModel: aiModel.value,
  });
}

function onDefaultRemoteChange(): void {
  persistConfig();
}

function selectMethod(id: GitInsightConfigView["mrMethod"]): void {
  if (props.busy || props.previewMode) {
    return;
  }
  method.value = id;
  persistConfig();
}

/** input 的 change：值变更且失焦后触发（非逐键），避免过于频繁 */
function onTokenChange(which: "github" | "gitlab"): void {
  if (which === "github" && !githubEnabled.value) {
    return;
  }
  if (which === "gitlab" && !gitlabEnabled.value) {
    return;
  }
  triggerValidate(which);
}

function triggerValidate(which: "github" | "gitlab"): void {
  if (props.busy || props.previewMode) {
    return;
  }
  const token = which === "github" ? githubToken.value.trim() : gitlabToken.value.trim();
  if (!token) {
    emit("clearTokenValidation", which);
    persistConfig();
    return;
  }
  if (which === "github") {
    githubChecking.value = true;
  } else {
    gitlabChecking.value = true;
  }
  emit("validateToken", {
    platform: which,
    githubToken: githubToken.value,
    gitlabToken: gitlabToken.value,
    persist: true,
    mrMethod: method.value === "token" ? "token" : method.value,
  });
}

const githubTitleStatus = computed(() => {
  if (githubChecking.value) {
    return "校验中…";
  }
  return props.githubTokenStatus?.titleStatus || "";
});

const gitlabTitleStatus = computed(() => {
  if (gitlabChecking.value) {
    return "校验中…";
  }
  return props.gitlabTokenStatus?.titleStatus || "";
});
</script>

<template>
  <div class="config-panel">
    <div class="card config-header">
      <div class="config-header-row">
        <h3>Git / MR 配置</h3>
        <span v-if="methodReady" class="config-ready-pill">已就绪</span>
        <span v-else-if="methodReadyReason" class="config-ready-pill warn">未就绪</span>
      </div>
      <p class="muted config-header-meta">
        切换 MR 方式即保存 · 首次：有 gh/glab 默认 A，否则 D ·
        <code class="mono">{{ configPath || "扩展全局配置" }}</code>
      </p>
      <p v-if="previewMode" class="mr-warn">预览模式可查看选项，但不会写入扩展配置。</p>
      <p v-if="!methodReady && methodReadyReason" class="mr-warn">{{ methodReadyReason }}</p>
    </div>

    <div class="config-split">
      <div class="card config-split-main">
        <div
          class="default-remote-bar"
          :title="'用于 fetch、分支图合并、MR 短名剥前缀、CLI 未传 --remote'"
        >
          <span class="default-remote-label">默认远程</span>
          <template v-if="hasRepoRemotes">
            <select
              v-model="defaultRemote"
              class="mono default-remote-select"
              :disabled="busy || previewMode"
              @change="onDefaultRemoteChange"
            >
              <option v-for="r in remoteList" :key="r.name" :value="r.name">
                {{ r.name }}
              </option>
            </select>
            <span
              class="mono muted default-remote-url"
              :title="selectedRemoteUrl"
            >{{ selectedRemoteUrl || "—" }}</span>
          </template>
          <span v-else class="mr-warn default-remote-empty">
            未打开仓库或无 remote，请先在顶部打开仓库路径
          </span>
        </div>

        <h3>MR 方式（四选一）</h3>
        <div
          v-for="opt in options"
          :key="opt.id"
          class="config-option"
          :class="{ active: method === opt.id, disabled: busy }"
          role="button"
          tabindex="0"
          @click="selectMethod(opt.id)"
          @keydown.enter.prevent="selectMethod(opt.id)"
        >
          <div class="config-option-head">
            <input
              v-model="method"
              type="radio"
              name="mrMethod"
              :value="opt.id"
              :disabled="busy || previewMode"
              @change="persistConfig()"
              @click.stop
            />
            <div class="config-option-title">
              {{ opt.title }}
              <span class="badge" :class="opt.ready ? 'ok' : 'warn'">{{
                opt.ready ? "可用" : "未就绪"
              }}</span>
            </div>
          </div>
          <div class="config-option-body">
            <div class="muted">{{ opt.desc }}</div>
            <div v-if="opt.detail" class="mono config-option-detail">{{ opt.detail }}</div>

            <div
              v-if="method === 'cli' && opt.id === 'cli'"
              class="config-inline"
              @click.stop
            >
              <template v-if="systemTarget?.installed && !systemTarget.loggedIn">
                <p class="mr-warn" style="margin: 0">
                  本机 {{ systemTarget.kind }} 已安装但未登录，登录后才能申请 MR。
                </p>
                <div class="btn-row">
                  <button
                    type="button"
                    class="btn"
                    :disabled="busy || previewMode"
                    @click="
                      emit('cliAuthLogin', { scope: 'system', kind: systemTarget.kind })
                    "
                  >
                    登录 {{ systemTarget.kind }}
                  </button>
                  <button
                    type="button"
                    class="btn secondary"
                    :disabled="busy"
                    @click="emit('refresh')"
                  >
                    重新检测登录状态
                  </button>
                </div>
              </template>
              <template v-else-if="!systemTarget?.installed">
                <p class="muted" style="margin: 0">
                  未检测到本机 CLI。请先安装
                  <code class="mono">gh</code> /
                  <code class="mono">glab</code>，或改选 B / C / D。
                </p>
              </template>
              <template v-else>
                <p class="muted" style="margin: 0; color: var(--ok)">本机 CLI 已登录。</p>
              </template>
            </div>

            <div
              v-if="method === 'download-cli' && opt.id === 'download-cli'"
              class="config-inline"
              @click.stop
            >
              <div class="btn-row">
                <!-- unknown 时显示两个下载按钮让用户选择 -->
                <template v-if="neededKind === 'both'">
                  <button
                    type="button"
                    class="btn secondary"
                    :disabled="busy || previewMode"
                    @click="emit('downloadCli', 'gh')"
                  >
                    {{ bundledTarget?.kind === 'gh' && bundledTarget.installed ? "重新下载 gh" : "下载 gh" }}
                  </button>
                  <button
                    type="button"
                    class="btn secondary"
                    :disabled="busy || previewMode"
                    @click="emit('downloadCli', 'glab')"
                  >
                    {{ bundledTarget?.kind === 'glab' && bundledTarget.installed ? "重新下载 glab" : "下载 glab" }}
                  </button>
                </template>
                <template v-else>
                  <button
                    type="button"
                    class="btn secondary"
                    :disabled="busy || previewMode || !neededKind"
                    @click="neededKind && emit('downloadCli', neededKind)"
                  >
                    {{
                      bundledTarget?.installed
                        ? `重新下载 ${neededKind || "CLI"}`
                        : `下载 ${neededKind || "CLI"} 到扩展目录`
                    }}
                  </button>
                </template>
                <button
                  v-if="bundledTarget?.installed && !bundledTarget.loggedIn"
                  type="button"
                  class="btn"
                  :disabled="busy || previewMode"
                  @click="
                    emit('cliAuthLogin', {
                      scope: 'bundled',
                      kind: bundledTarget.kind,
                    })
                  "
                >
                  登录扩展内 {{ bundledTarget.kind }}
                </button>
                <button
                  type="button"
                  class="btn secondary"
                  :disabled="busy"
                  @click="emit('refresh')"
                >
                  检测登录状态
                </button>
              </div>
              <p v-if="bundledTarget?.installed && !bundledTarget.loggedIn" class="mr-warn">
                已下载但未登录：请点「登录」，在终端完成后再点「检测登录状态」。
              </p>
              <p v-else-if="bundledTarget?.loggedIn" class="muted" style="color: var(--ok)">
                扩展内 CLI 已登录。
              </p>
              <p v-else class="muted">下载完成后会自动检测登录状态；未登录可点上方按钮唤起登录。</p>
            </div>

            <div
              v-if="method === 'token' && opt.id === 'token'"
              class="config-tokens config-inline"
              @click.stop
            >
              <div class="token-create-row">
                <button
                  type="button"
                  class="btn secondary tiny"
                  :disabled="busy || previewMode || !githubEnabled"
                  @click="openTokenCreatePage('github')"
                >
                  打开 GitHub 创建 Token 页面
                </button>
              </div>
              <label :class="{ 'token-disabled': !githubEnabled }">
                <span class="token-label-row">
                  <span>GitHub Token（repo / pull request 权限）</span>
                  <span
                    v-if="githubEnabled && githubTitleStatus"
                    class="token-title-status"
                    :class="
                      githubChecking
                        ? 'muted'
                        : githubTokenStatus?.ok
                          ? 'ok'
                          : 'bad'
                    "
                    >{{ githubTitleStatus }}</span
                  >
                  <span v-else-if="!githubEnabled" class="token-title-status muted"
                    >当前远程为 GitLab，已禁用</span
                  >
                </span>
                <input
                  v-model="githubToken"
                  type="password"
                  autocomplete="off"
                  :disabled="busy || previewMode || !githubEnabled"
                  placeholder="ghp_… 或 github_pat_…"
                  @change="onTokenChange('github')"
                />
              </label>
              <div class="token-create-row">
                <button
                  type="button"
                  class="btn secondary tiny"
                  :disabled="busy || previewMode || !gitlabEnabled"
                  @click="openTokenCreatePage('gitlab')"
                >
                  打开 GitLab 创建 Token 页面
                </button>
              </div>
              <label :class="{ 'token-disabled': !gitlabEnabled }">
                <span class="token-label-row">
                  <span>GitLab Token（必须以 glpat- 开头）</span>
                  <span
                    v-if="gitlabEnabled && gitlabTitleStatus"
                    class="token-title-status"
                    :class="
                      gitlabChecking
                        ? 'muted'
                        : gitlabTokenStatus?.ok
                          ? 'ok'
                          : 'bad'
                    "
                    >{{ gitlabTitleStatus }}</span
                  >
                  <span v-else-if="!gitlabEnabled" class="token-title-status muted"
                    >当前远程为 GitHub，已禁用</span
                  >
                </span>
                <input
                  v-model="gitlabToken"
                  type="password"
                  autocomplete="off"
                  :disabled="busy || previewMode || !gitlabEnabled"
                  placeholder="glpat-…"
                  @change="onTokenChange('gitlab')"
                />
              </label>
              <p class="muted" style="margin: 0">
                Token 变更并确认后（change）自动校验并保存；有效期为中国时间（年/月/日
                时:分:秒）。
              </p>
            </div>

            <!-- 手动选择平台（仅在自动探测为 unknown 时显示） -->
            <div
              v-if="opt.id === '__platform_picker'"
              class="config-inline"
              @click.stop
            >
              <p class="muted" style="margin: 0 0 6px 0">
                未能自动识别远程平台。请选择你使用的平台，此后选项 A/B/C 将按所选平台生效。
              </p>
              <div class="seg" role="group" aria-label="选择远程平台">
                <button
                  type="button"
                  class="seg-btn"
                  :class="{ active: manualPlatform === 'github' }"
                  :disabled="busy || previewMode"
                  @click="setManualPlatform('github')"
                >GitHub</button>
                <button
                  type="button"
                  class="seg-btn"
                  :class="{ active: manualPlatform === 'gitlab' }"
                  :disabled="busy || previewMode"
                  @click="setManualPlatform('gitlab')"
                >GitLab</button>
              </div>
              <p v-if="manualPlatform" class="muted" style="margin: 4px 0 0 0; color: var(--ok)">
                已选择：{{ manualPlatform === 'github' ? 'GitHub' : 'GitLab' }}。选项将按此平台生效。
              </p>
            </div>
          </div>
        </div>

        <div class="btn-row config-actions">
          <button type="button" class="btn secondary" :disabled="busy" @click="emit('refresh')">
            重新检测 CLI
          </button>
        </div>

        <div class="ai-section">
          <button
            type="button"
            class="ai-section-toggle"
            :aria-expanded="aiSectionOpen"
            @click="aiSectionOpen = !aiSectionOpen"
          >
            <span class="tree-caret">{{ aiSectionOpen ? "▾" : "▸" }}</span>
            AI 选边（模型）
            <span class="muted ai-section-hint">可选 · 默认折叠</span>
          </button>
          <div v-if="aiSectionOpen" class="ai-section-body">
            <p class="muted">
              Cursor 的 <code>vscode.lm</code> 经常拿不到模型。可配置 OpenAI 兼容接口作为回退（官方
              API / 代理 / 本地 Ollama 等）。优先用宿主模型；没有时自动用下面配置。
            </p>
            <label>
              Base URL
              <input
                v-model="aiApiBaseUrl"
                type="text"
                :disabled="busy || previewMode"
                placeholder="https://api.openai.com/v1"
                @change="persistConfig"
              />
            </label>
            <label>
              API Key（本地 Ollama 可留空）
              <input
                v-model="aiApiKey"
                type="password"
                autocomplete="off"
                :disabled="busy || previewMode"
                placeholder="sk-… 或留空"
                @change="persistConfig"
              />
            </label>
            <label>
              模型名
              <input
                v-model="aiModel"
                type="text"
                :disabled="busy || previewMode"
                placeholder="gpt-4o-mini"
                @change="persistConfig"
              />
            </label>
            <p class="muted" style="margin: 0">
              示例 Ollama：Base URL = <code>http://127.0.0.1:11434/v1</code>，模型 =
              <code>qwen2.5-coder</code>，Key 留空。
            </p>
          </div>
        </div>
      </div>

      <aside class="card config-split-side">
        <h3>使用顺序</h3>
        <ol class="config-steps">
          <li>
            <span class="config-step-n">1</span>
            在本页选好 MR 方式（自动保存）；需要 AI 选边时填好上方模型接口
          </li>
          <li>
            <span class="config-step-n">2</span>
            「合并预演」选线上目标 + 我的分支，完成冲突选边（可 AI）
          </li>
          <li>
            <span class="config-step-n">3</span>
            点击「一键解决并推送」（把我的合进线上并推送）
          </li>
          <li>
            <span class="config-step-n">4</span>
            成功后才可点击「一键申请 MR」
          </li>
        </ol>
      </aside>
    </div>
  </div>
</template>
