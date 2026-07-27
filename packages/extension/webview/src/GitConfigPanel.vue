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
}>();

const method = ref<GitInsightConfigView["mrMethod"]>(null);
const githubToken = ref("");
const gitlabToken = ref("");
const githubChecking = ref(false);
const gitlabChecking = ref(false);

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
  ([c]) => {
    if (!c) {
      return;
    }
    method.value = c.mrMethod ?? suggestDefaultMethod();
    githubToken.value = c.githubToken ?? "";
    gitlabToken.value = c.gitlabToken ?? "";
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

const platform = computed(() => props.cliStatus?.platformHint ?? "unknown");

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

const neededKind = computed((): "gh" | "glab" | null => {
  if (platform.value === "gitlab") {
    return "glab";
  }
  if (platform.value === "github") {
    return "gh";
  }
  return null;
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

function githubFormatOk(token: string): boolean {
  const t = token.trim();
  return /^(ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,}|gho_[A-Za-z0-9]{36}|ghu_[A-Za-z0-9]{36}|ghs_[A-Za-z0-9]{36}|ghr_[A-Za-z0-9]{36})$/.test(
    t,
  );
}

function gitlabFormatOk(token: string): boolean {
  return /^glpat-[A-Za-z0-9_\-]{20,}$/.test(token.trim());
}

const tokenReady = computed(() => {
  if (platform.value === "github") {
    return !!githubToken.value.trim() && (props.githubTokenStatus?.ok ?? false);
  }
  if (platform.value === "gitlab") {
    return !!gitlabToken.value.trim() && (props.gitlabTokenStatus?.ok ?? false);
  }
  return (
    (githubToken.value.trim() && props.githubTokenStatus?.ok) ||
    (gitlabToken.value.trim() && props.gitlabTokenStatus?.ok) ||
    false
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
      desc: "填写后失焦/回车自动校验并保存；GitLab 必须以 glpat- 开头",
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
});

function persistConfig(): void {
  if (props.previewMode) {
    return;
  }
  emit("save", {
    mrMethod: method.value,
    githubToken: githubToken.value,
    gitlabToken: gitlabToken.value,
  });
}

function selectMethod(id: GitInsightConfigView["mrMethod"]): void {
  if (props.busy || props.previewMode) {
    return;
  }
  method.value = id;
  persistConfig();
}

function onGithubInput(): void {
  emit("clearTokenValidation", "github");
}

function onGitlabInput(): void {
  emit("clearTokenValidation", "gitlab");
}

function triggerValidate(platform: "github" | "gitlab"): void {
  if (props.busy || props.previewMode) {
    return;
  }
  const token = platform === "github" ? githubToken.value.trim() : gitlabToken.value.trim();
  if (!token) {
    emit("clearTokenValidation", platform);
    persistConfig();
    return;
  }
  if (platform === "github" && !githubFormatOk(token)) {
    // 仍持久化，宿主校验会返回格式错误状态
  }
  if (platform === "gitlab" && !gitlabFormatOk(token)) {
    // 同上
  }
  if (platform === "github") {
    githubChecking.value = true;
  } else {
    gitlabChecking.value = true;
  }
  emit("validateToken", {
    platform,
    githubToken: githubToken.value,
    gitlabToken: gitlabToken.value,
    persist: true,
    mrMethod: method.value,
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
      <h3>Git / MR 配置</h3>
      <p class="muted">
        选择「一键申请 MR」使用的方式（切换即自动保存）。首次进入：本机有 gh/glab 默认选
        A，否则默认选 D。存储位置：
        <code class="mono">{{ configPath || "扩展全局配置（各仓库共用）" }}</code>
      </p>
      <p v-if="previewMode" class="mr-warn">预览模式可查看选项，但不会写入扩展配置。</p>
      <p v-if="!methodReady && methodReadyReason" class="mr-warn">{{ methodReadyReason }}</p>
      <p v-else-if="methodReady" class="muted" style="color: var(--ok)">当前方式已就绪</p>
    </div>

    <div class="config-split">
      <div class="card config-split-main">
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
              <label>
                <span class="token-label-row">
                  <span>GitHub Token（repo / pull request 权限）</span>
                  <span
                    v-if="githubTitleStatus"
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
                </span>
                <input
                  v-model="githubToken"
                  type="password"
                  autocomplete="off"
                  :disabled="busy || previewMode"
                  placeholder="ghp_… 或 github_pat_…"
                  @input="onGithubInput"
                  @blur="triggerValidate('github')"
                  @keydown.enter.prevent="triggerValidate('github')"
                />
              </label>
              <label>
                <span class="token-label-row">
                  <span>GitLab Token（必须以 glpat- 开头）</span>
                  <span
                    v-if="gitlabTitleStatus"
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
                </span>
                <input
                  v-model="gitlabToken"
                  type="password"
                  autocomplete="off"
                  :disabled="busy || previewMode"
                  placeholder="glpat-…"
                  @input="onGitlabInput"
                  @blur="triggerValidate('gitlab')"
                  @keydown.enter.prevent="triggerValidate('gitlab')"
                />
              </label>
              <p class="muted" style="margin: 0">
                失焦或回车后自动校验并写入扩展全局配置；有效期为中国时间（年/月/日
                时:分:秒）。
              </p>
            </div>
          </div>
        </div>

        <div class="btn-row config-actions">
          <button type="button" class="btn secondary" :disabled="busy" @click="emit('refresh')">
            重新检测 CLI
          </button>
        </div>
      </div>

      <aside class="card config-split-side">
        <h3>使用顺序</h3>
        <ol class="config-steps">
          <li>在本页选好 MR 方式（自动保存）</li>
          <li>「合并预演」中完成冲突选择</li>
          <li>点击「一键解决并推送」</li>
          <li>成功后才可点击「一键申请 MR」</li>
        </ol>
      </aside>
    </div>
  </div>
</template>
