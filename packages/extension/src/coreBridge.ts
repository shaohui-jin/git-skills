import {
  applyStashedResolve,
  buildBranchGraph,
  createMergeRequest,
  crossPairs,
  detectMrPlatform,
  fetchRemote,
  listRemotes,
  normalizeRemoteWebUrl,
  prepareCreateMr,
  probePlatform,
  rehearseMerge,
  reportFetch,
  reportGraph,
  reportMergeOrder,
  reportMergeRehearsal,
  reportMergeSurvey,
  resolveDefaultRemote,
  suggestMergeOrder,
  surveyMerges,
  resolveRepoRoot,
  runGit,
  graphToMermaid,
  mergeToMermaid,
  titleSideStatus,
  validateGithubToken,
  validateGitlabToken,
  GitError,
  type TokenPlatform,
  type TokenValidateResult,
} from "@shaohui_jin/git-insight-core";
import type { CliStatusPayload, HostMessage, WebviewRequest } from "./protocol.js";
import {
  bundledCliPath,
  checkBundledCli,
  checkSystemCli,
  downloadBundledCli,
} from "./cliBundle.js";
import {
  configPath,
  type ConfigMemento,
  isMrMethodReady,
  loadUserConfig,
  resolveDefaultMrMethod,
  saveUserConfig,
} from "./gitConfigStore.js";
import {
  ensureRemoteRepo,
  isRemoteOnlyMode,
  looksLikeRemoteRepo,
} from "./remoteRepo.js";

export interface BranchOption {
  /** 短名（无 remote 前缀）：main、feature/x */
  name: string;
  /** 是否来自 refs/remotes */
  remote: boolean;
  /** 远程名，仅 remote=true 时有值，如 origin */
  remoteName?: string;
  /** git 操作身份：本地为短名；远程为 origin/main */
  gitRef: string;
}

/**
 * 列出全部本地/远程分支，不做数量截断。
 * 不改写磁盘 refs；UI 用 name 建树，ops 用 gitRef，MR 用 name。
 */
export async function listBranchNames(cwd: string): Promise<BranchOption[]> {
  const { stdout } = await runGit(cwd, [
    "for-each-ref",
    "--format=%(refname)%00%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ]);
  const names: BranchOption[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    const [refname, shortName] = line.split("\0");
    if (!refname || !shortName) {
      continue;
    }
    // 跳过远程默认 HEAD（short 常为裸 "origin"，不是真实分支）
    if (refname.endsWith("/HEAD") || /^refs\/remotes\/[^/]+\/HEAD$/.test(refname)) {
      continue;
    }
    if (refname.startsWith("refs/heads/")) {
      // short 即为本地短名（可含 /）
      names.push({
        name: shortName,
        remote: false,
        gitRef: shortName,
      });
      continue;
    }
    const m = refname.match(/^refs\/remotes\/([^/]+)\/(.+)$/);
    if (m) {
      const remoteName = m[1]!;
      const branchPath = m[2]!;
      names.push({
        name: branchPath,
        remote: true,
        remoteName,
        gitRef: `${remoteName}/${branchPath}`,
      });
    }
  }
  return names;
}

export async function resolveWorkspaceCwd(folderPath?: string): Promise<string | null> {
  if (!folderPath) {
    return null;
  }
  try {
    return await resolveRepoRoot(folderPath);
  } catch {
    return null;
  }
}

async function workspacePayload(
  cwd: string | null,
  previewMode?: boolean,
  error?: string,
): Promise<HostMessage> {
  if (!cwd) {
    return {
      type: "workspace",
      cwd: null,
      branches: [],
      error: error ?? "未打开 Git 仓库，请选择或输入目录",
      previewMode,
    };
  }
  try {
    const branches = await listBranchNames(cwd);
    return { type: "workspace", cwd, branches, previewMode };
  } catch (err) {
    return {
      type: "workspace",
      cwd,
      branches: [],
      error: err instanceof Error ? err.message : String(err),
      previewMode,
    };
  }
}

/**
 * Handle requests that do not need a folder picker.
 * `setCwd` returns the new cwd via workspace message; caller should persist it.
 */
function cliPairOk(
  platformHint: "github" | "gitlab" | "unknown",
  gh: { installed: boolean; loggedIn: boolean },
  glab: { installed: boolean; loggedIn: boolean },
): boolean {
  if (platformHint === "github") {
    return gh.installed && gh.loggedIn;
  }
  if (platformHint === "gitlab") {
    return glab.installed && glab.loggedIn;
  }
  return (gh.installed && gh.loggedIn) || (glab.installed && glab.loggedIn);
}

function emptyCliStatus(configuredDefaultRemote?: string | null): CliStatusPayload {
  return {
    platformHint: "unknown",
    remoteWebOrigin: null,
    remotes: [],
    defaultRemote: configuredDefaultRemote?.trim() || "origin",
    systemGh: { installed: false, loggedIn: false },
    systemGlab: { installed: false, loggedIn: false },
    bundledGh: { installed: false, loggedIn: false },
    bundledGlab: { installed: false, loggedIn: false },
    systemCliOk: false,
    bundledCliOk: false,
  };
}

async function buildCliStatus(
  repoRoot: string,
  cliStorageDir: string | undefined,
  configuredDefaultRemote?: string | null,
): Promise<CliStatusPayload> {
  const remotes = repoRoot ? await listRemotes(repoRoot) : [];
  const remoteNames = remotes.map((r) => r.name);
  const defaultRemote = resolveDefaultRemote(configuredDefaultRemote, remoteNames);
  const defaultInfo = remotes.find((r) => r.name === defaultRemote);
  const remoteUrl = defaultInfo?.fetchUrl || defaultInfo?.pushUrl || "";
  let platformHint = detectMrPlatform(remoteUrl);
  // 同步检测不到时尝试异步探测（访问 API 判断是否为 GitLab）
  if (platformHint === "unknown" && remoteUrl) {
    platformHint = await probePlatform(remoteUrl);
  }
  const web = normalizeRemoteWebUrl(remoteUrl);
  let remoteWebOrigin: string | null = null;
  if (web) {
    try {
      remoteWebOrigin = new URL(web).origin;
    } catch {
      remoteWebOrigin = null;
    }
  }
  const emptyCli = { installed: false, loggedIn: false };
  const [systemGh, systemGlab, bundledGh, bundledGlab] = await Promise.all([
    checkSystemCli(repoRoot, "gh"),
    checkSystemCli(repoRoot, "glab"),
    cliStorageDir
      ? checkBundledCli(cliStorageDir, "gh", repoRoot)
      : Promise.resolve(emptyCli),
    cliStorageDir
      ? checkBundledCli(cliStorageDir, "glab", repoRoot)
      : Promise.resolve(emptyCli),
  ]);
  return {
    platformHint,
    remoteWebOrigin,
    remotes,
    defaultRemote,
    systemGh,
    systemGlab,
    bundledGh,
    bundledGlab,
    systemCliOk: cliPairOk(platformHint, systemGh, systemGlab),
    bundledCliOk: cliPairOk(platformHint, bundledGh, bundledGlab),
  };
}

/**
 * cliStatus 探测缓存：`auth status` 会拿本地凭据打 GitHub/GitLab API，
 * 受限网络下可能挂到超时，避免每次 ready/refresh/getGitConfig 都重跑 4 组探测。
 */
const cliStatusCache = new Map<
  string,
  { at: number; payload: CliStatusPayload }
>();
const CLI_STATUS_TTL_MS = 30_000;

/** 下载 CLI / 登录等改变状态的操作后调用，让下一次探测拿到真实结果 */
export function invalidateCliStatusCache(): void {
  cliStatusCache.clear();
}

async function buildCliStatusCached(
  repoRoot: string,
  cliStorageDir: string | undefined,
  configuredDefaultRemote?: string | null,
): Promise<CliStatusPayload> {
  const key = `${repoRoot}|${cliStorageDir ?? ""}|${configuredDefaultRemote ?? ""}`;
  const hit = cliStatusCache.get(key);
  if (hit && Date.now() - hit.at < CLI_STATUS_TTL_MS) {
    return hit.payload;
  }
  const payload = await buildCliStatus(
    repoRoot,
    cliStorageDir,
    configuredDefaultRemote,
  );
  cliStatusCache.set(key, { at: Date.now(), payload });
  return payload;
}

async function remoteUrlForDefault(
  repoRoot: string,
  configuredDefaultRemote?: string | null,
): Promise<string> {
  const remotes = await listRemotes(repoRoot);
  const name = resolveDefaultRemote(
    configuredDefaultRemote,
    remotes.map((r) => r.name),
  );
  const info = remotes.find((r) => r.name === name);
  return info?.fetchUrl || info?.pushUrl || "";
}

async function resolveOpRemote(
  cwd: string,
  explicit: string | undefined,
  loadCfg: () => Promise<{ defaultRemote?: string }>,
): Promise<string> {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  const cfg = await loadCfg();
  const remotes = await listRemotes(cwd);
  return resolveDefaultRemote(
    cfg.defaultRemote,
    remotes.map((r) => r.name),
  );
}

/** 方案 C：按指定平台或远程倾向校验 Token */
async function validateTokenForRepo(
  repoRoot: string,
  tokens: { githubToken?: string; gitlabToken?: string },
  platform?: TokenPlatform,
  configuredDefaultRemote?: string | null,
): Promise<TokenValidateResult> {
  const originUrl = await remoteUrlForDefault(repoRoot, configuredDefaultRemote);
  const hint = platform ?? detectMrPlatform(originUrl);
  if (hint === "github") {
    return validateGithubToken(tokens.githubToken ?? "");
  }
  if (hint === "gitlab") {
    const web = normalizeRemoteWebUrl(originUrl) || "https://gitlab.com";
    return validateGitlabToken(tokens.gitlabToken ?? "", web);
  }
  if (tokens.githubToken?.trim()) {
    return validateGithubToken(tokens.githubToken);
  }
  if (tokens.gitlabToken?.trim()) {
    const web = normalizeRemoteWebUrl(originUrl) || "https://gitlab.com";
    return validateGitlabToken(tokens.gitlabToken, web);
  }
  return {
    platform: "github",
    formatOk: false,
    formatMessage: "请先填写 Token",
    apiChecked: false,
    apiOk: false,
    statusLabel: "格式错误",
    ok: false,
    error: "请先填写 Token",
  };
}

function tokenResultPayload(result: TokenValidateResult) {
  return {
    ...result,
    summary: titleSideStatus(result),
    titleStatus: titleSideStatus(result),
  };
}

/**
 * 顶部状态条的忙碌文案。返回 undefined 表示这个请求快到不值得显示进度。
 * 宿主与浏览器预览服务共用，避免两边各写一条越来越长的三元链。
 */
export function busyLabelForRequest(req: WebviewRequest): string | undefined {
  switch (req.type) {
    case "fetch":
      return "正在 Fetch…";
    case "graph":
      return "正在加载全量分支图…";
    case "preview":
    case "blame":
      return "合并预演中…";
    case "survey":
      return "批量预演中…";
    case "mergeOrder":
      return "推演合并顺序中…";
    case "applyResolve":
      return req.files?.length ? "一键解决并推送…" : "正在推送临时分支…";
    case "prepareCreateMr":
      return "准备申请 MR（识别平台 / 拉取成员）…";
    case "createMr":
      return "正在创建 MR…";
    case "downloadCli":
      return "正在下载 CLI 到扩展目录…";
    case "validateToken":
      return "正在校验 Token…";
    case "saveGitConfig":
      return req.config.mrMethod === "token" ? "保存配置并校验 Token…" : undefined;
    case "setCwd":
      return "正在打开仓库…";
    default:
      return undefined;
  }
}

/** 这些请求会流式上报进度，值得把 onProgress 接上 */
export function requestStreamsProgress(req: WebviewRequest): boolean {
  switch (req.type) {
    case "graph":
    case "preview":
    case "blame":
    case "survey":
    case "mergeOrder":
    case "applyResolve":
    case "downloadCli":
    case "validateToken":
      return true;
    case "saveGitConfig":
      return req.config.mrMethod === "token";
    default:
      return false;
  }
}

export async function handleWebviewRequest(
  req: WebviewRequest,
  cwd: string | null,
  options?: {
    previewMode?: boolean;
    onProgress?: (update: { percent: number; label: string }) => void;
    /** 分段下发：消息产生即推给 webview，不等整个请求处理完 */
    onPartial?: (msg: HostMessage) => Promise<void>;
    /** 扩展 globalStorage，用于 B：下载 CLI */
    cliStorageDir?: string;
    /** 扩展 globalState：Token / MR 方式全仓库共用 */
    configMemento?: ConfigMemento;
  },
): Promise<{ messages: HostMessage[]; cwd?: string | null }> {
  const previewMode = options?.previewMode;
  const onProgress = options?.onProgress;
  const onPartial = options?.onPartial;
  const cliStorageDir = options?.cliStorageDir;
  const configMemento = options?.configMemento;

  const loadCfg = async () => {
    if (!configMemento) {
      throw new Error("扩展配置存储不可用");
    }
    return loadUserConfig(configMemento, cwd, cliStorageDir);
  };
  const saveCfg = async (config: Awaited<ReturnType<typeof loadUserConfig>>) => {
    if (!configMemento) {
      throw new Error("扩展配置存储不可用");
    }
    return saveUserConfig(configMemento, config, cliStorageDir);
  };
  const cfgPath = () => configPath(cliStorageDir);

  if (req.type === "ready" || req.type === "refreshWorkspace") {
    const wsMsg = await workspacePayload(cwd, previewMode);
    // 分支列表不等 CLI 探测：受限网络下 auth status 挂住时，
    // 用户也该先看到仓库与分支，配置状态稍后到达。
    if (onPartial) {
      await onPartial(wsMsg);
    }
    const messages: HostMessage[] = onPartial ? [] : [wsMsg];
    if (cwd && configMemento) {
      try {
        const config = await loadCfg();
        let cfg = config;
        const cliStatus = await buildCliStatusCached(
          cwd,
          cliStorageDir,
          cfg.defaultRemote,
        );
        if (cliStatus.remotes.length > 0) {
          const resolved = cliStatus.defaultRemote;
          if ((cfg.defaultRemote || "").trim() !== resolved) {
            cfg = await saveCfg({ ...cfg, defaultRemote: resolved });
          }
        }
        // 从未选过 MR 方式：有本机 gh/glab → A，否则 → D
        if (cfg.mrMethod == null) {
          const mrMethod = resolveDefaultMrMethod({
            platformHint: cliStatus.platformHint,
            systemGhInstalled: cliStatus.systemGh.installed,
            systemGlabInstalled: cliStatus.systemGlab.installed,
          });
          cfg = await saveCfg({ ...cfg, mrMethod });
        }
        const ready = isMrMethodReady(cfg, cliStatus);
        messages.push({
          type: "gitConfigResult",
          config: cfg,
          cliStatus,
          configPath: cfgPath(),
          methodReady: ready.ok,
          methodReadyReason: ready.reason,
        });
      } catch {
        // ignore config bootstrap errors
      }
    }
    return { messages };
  }

  if (req.type === "setCwd") {
    const path = req.path?.trim();
    if (!path) {
      return {
        messages: [
          {
            type: "error",
            message: isRemoteOnlyMode()
              ? "请输入 GitHub 仓库（owner/repo 或 https://github.com/owner/repo）"
              : "请输入仓库目录路径或 GitHub 仓库地址",
            code: "USAGE",
          },
        ],
      };
    }

    if (looksLikeRemoteRepo(path)) {
      try {
        let token: string | undefined;
        if (configMemento) {
          try {
            const cfg = await loadUserConfig(configMemento, null, cliStorageDir);
            token = cfg.githubToken?.trim() || undefined;
          } catch {
            token = undefined;
          }
        }
        const resolved = await ensureRemoteRepo(path, token);
        return {
          messages: [await workspacePayload(resolved, previewMode)],
          cwd: resolved,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          messages: [
            { type: "error", message, code: "REMOTE_CLONE_FAILED" },
            await workspacePayload(null, previewMode, message),
          ],
          cwd: null,
        };
      }
    }

    if (isRemoteOnlyMode()) {
      return {
        messages: [
          {
            type: "error",
            message:
              "云端预览仅支持 GitHub 仓库地址（例如 vuejs/core 或 https://github.com/vuejs/core）",
            code: "REMOTE_ONLY",
          },
          await workspacePayload(
            null,
            previewMode,
            "云端模式不支持本机路径",
          ),
        ],
        cwd: null,
      };
    }

    const resolved = await resolveWorkspaceCwd(path);
    if (!resolved) {
      return {
        messages: [
          {
            type: "error",
            message: `路径不是 Git 仓库（或无法访问）：${path}`,
            code: "NOT_GIT_REPO",
          },
          await workspacePayload(null, previewMode, `路径不是 Git 仓库：${path}`),
        ],
        cwd: null,
      };
    }
    return {
      messages: [await workspacePayload(resolved, previewMode)],
      cwd: resolved,
    };
  }

  if (req.type === "pickFolder") {
    // Host-specific: preview server / extension handle before calling here
    return {
      messages: [
        {
          type: "error",
          message: "当前宿主未实现目录选择",
          code: "UNSUPPORTED",
        },
      ],
    };
  }

  if (req.type === "getGitConfig") {
    const config = await loadCfg();
    let cfg = config;
    const cliStatus = cwd
      ? await buildCliStatusCached(cwd, cliStorageDir, cfg.defaultRemote)
      : emptyCliStatus(cfg.defaultRemote);
    if (cwd && cliStatus.remotes.length > 0) {
      const resolved = cliStatus.defaultRemote;
      if ((cfg.defaultRemote || "").trim() !== resolved) {
        cfg = await saveCfg({ ...cfg, defaultRemote: resolved });
      }
    }
    if (cfg.mrMethod == null) {
      const mrMethod = resolveDefaultMrMethod({
        platformHint: cliStatus.platformHint,
        systemGhInstalled: cliStatus.systemGh.installed,
        systemGlabInstalled: cliStatus.systemGlab.installed,
      });
      cfg = await saveCfg({ ...cfg, mrMethod });
    }
    const ready = isMrMethodReady(cfg, cliStatus);
    return {
      messages: [
        {
          type: "gitConfigResult",
          config: cfg,
          cliStatus,
          configPath: cfgPath(),
          methodReady: ready.ok,
          methodReadyReason: ready.reason,
        },
      ],
    };
  }

  if (req.type === "saveGitConfig") {
    const prev = await loadCfg();
    const saved = await saveCfg({
      ...prev,
      mrMethod: req.config.mrMethod,
      githubToken: req.config.githubToken ?? "",
      gitlabToken: req.config.gitlabToken ?? "",
      defaultRemote:
        req.config.defaultRemote?.trim() || prev.defaultRemote || "origin",
      aiApiBaseUrl: req.config.aiApiBaseUrl ?? prev.aiApiBaseUrl ?? "",
      aiApiKey: req.config.aiApiKey ?? prev.aiApiKey ?? "",
      aiModel: req.config.aiModel ?? prev.aiModel ?? "",
    });
    const cliStatus = cwd
      ? await buildCliStatusCached(cwd, cliStorageDir, saved.defaultRemote)
      : emptyCliStatus(saved.defaultRemote);
    const ready = isMrMethodReady(saved, cliStatus);
    return {
      messages: [
        {
          type: "gitConfigResult",
          config: saved,
          cliStatus,
          configPath: cfgPath(),
          methodReady: ready.ok,
          methodReadyReason: ready.reason,
        },
      ],
    };
  }

  if (!cwd) {
    return {
      messages: [
        {
          type: "error",
          message: "未打开 Git 仓库，请先选择或输入目录",
          code: "NO_REPO",
        },
      ],
    };
  }

  try {
    if (req.type === "fetch") {
      const remote = await resolveOpRemote(cwd, req.remote, loadCfg);
      const data = await fetchRemote(cwd, remote, onProgress);
      return {
        messages: [
          { type: "fetchResult", data, report: reportFetch(data) },
          await workspacePayload(cwd, previewMode),
        ],
      };
    }

    if (req.type === "graph") {
      // 网页/扩展默认全量（maxNodes: 0）；CLI 仍默认 200
      const maxNodes = req.maxNodes === undefined ? 0 : req.maxNodes;
      const remote = await resolveOpRemote(cwd, undefined, loadCfg);
      const data = await buildBranchGraph({
        cwd,
        into: req.into,
        from: req.from,
        fetch: !req.noFetch,
        maxNodes,
        remote,
        onProgress,
      });
      return {
        messages: [
          {
            type: "graphResult",
            data,
            report: reportGraph(data),
            mermaid: graphToMermaid(data),
          },
        ],
      };
    }

    // preview / blame 均走完整「合并预演」（冲突正文 + 溯源）
    if (req.type === "preview" || req.type === "blame") {
      if (!req.into || !req.from) {
        return {
          messages: [
            {
              type: "error",
              message: "请填写线上目标分支与我的分支",
              code: "USAGE",
            },
          ],
        };
      }
      const remote = await resolveOpRemote(cwd, undefined, loadCfg);
      const data = await rehearseMerge({
        cwd,
        into: req.into,
        from: req.from,
        fetch: !req.noFetch,
        remote,
        onProgress,
      });
      return {
        messages: [
          {
            type: "previewResult",
            data,
            report: reportMergeRehearsal(data),
            mermaid: mergeToMermaid(data),
          },
        ],
      };
    }

    if (req.type === "survey") {
      const intos = (req.intos ?? []).filter(Boolean);
      const froms = (req.froms ?? []).filter(Boolean);
      if (intos.length === 0 || froms.length === 0) {
        return {
          messages: [
            {
              type: "error",
              message: "矩阵预演需要至少一个线上目标与一个我的分支",
              code: "USAGE",
            },
          ],
        };
      }
      const remote = await resolveOpRemote(cwd, undefined, loadCfg);
      const data = await surveyMerges({
        cwd,
        pairs: crossPairs(intos, froms),
        fetch: !req.noFetch,
        remote,
        onProgress,
      });
      return {
        messages: [{ type: "surveyResult", data, report: reportMergeSurvey(data) }],
      };
    }

    if (req.type === "mergeOrder") {
      const branches = (req.branches ?? []).filter(Boolean);
      if (!req.into || branches.length === 0) {
        return {
          messages: [
            {
              type: "error",
              message: "顺序推演需要线上目标与至少一个待合入分支",
              code: "USAGE",
            },
          ],
        };
      }
      const remote = await resolveOpRemote(cwd, undefined, loadCfg);
      const data = await suggestMergeOrder({
        cwd,
        into: req.into,
        branches,
        fetch: !req.noFetch,
        remote,
        onProgress,
      });
      return {
        messages: [{ type: "mergeOrderResult", data, report: reportMergeOrder(data) }],
      };
    }

    if (req.type === "applyResolve") {
      if (previewMode) {
        return {
          messages: [
            {
              type: "error",
              message: "预览模式不支持写仓库 / 推送，请在扩展中打开真实仓库后操作",
              code: "PREVIEW_READONLY",
            },
          ],
        };
      }
      if (!req.into || !req.from) {
        return {
          messages: [
            {
              type: "error",
              message: "请填写线上目标分支与我的分支",
              code: "USAGE",
            },
          ],
        };
      }
      // files 可为空：干净合并（如同名 master→origin/master）仅推临时分支
      const remote = await resolveOpRemote(cwd, req.remote, loadCfg);
      const data = await applyStashedResolve({
        cwd,
        into: req.into,
        from: req.from,
        files: req.files ?? [],
        remote,
        push: req.push,
        tempBranch: req.tempBranch,
        onProgress,
      });
      return {
        messages: [
          {
            type: "applyResolveResult",
            tempBranch: data.tempBranch,
            commitSha: data.commitSha,
            pushed: data.pushed,
            createMrUrl: data.createMrUrl,
            messages: data.messages,
            into: data.into,
            from: data.from,
            intoSha: data.intoSha,
            fromSha: data.fromSha,
            previousBranch: data.previousBranch,
            usedWorktree: data.usedWorktree,
          },
          await workspacePayload(cwd, previewMode),
        ],
      };
    }

    if (req.type === "validateToken") {
      void onProgress?.({ percent: 40, label: "校验 Token…" });
      const platform = req.platform;
      const cfgForToken = await loadCfg();
      const checked = await validateTokenForRepo(
        cwd,
        {
          githubToken: req.githubToken,
          gitlabToken: req.gitlabToken,
        },
        platform,
        cfgForToken.defaultRemote,
      );
      const payload = tokenResultPayload(checked);
      const messages: HostMessage[] = [{ type: "tokenValidateResult", ...payload }];
      // 校验后落盘；方案 C 的就绪态以本次校验为准
      if (req.persist) {
        const prev = await loadCfg();
        const saved = await saveCfg({
          ...prev,
          mrMethod: req.mrMethod ?? prev.mrMethod,
          githubToken: req.githubToken ?? prev.githubToken ?? "",
          gitlabToken: req.gitlabToken ?? prev.gitlabToken ?? "",
        });
        const cliStatus = await buildCliStatusCached(
          cwd,
          cliStorageDir,
          saved.defaultRemote,
        );
        let ready = isMrMethodReady(saved, cliStatus);
        if (saved.mrMethod === "token") {
          ready = checked.ok
            ? { ok: true }
            : { ok: false, reason: payload.titleStatus || payload.summary };
        }
        messages.push({
          type: "gitConfigResult",
          config: saved,
          cliStatus,
          configPath: cfgPath(),
          methodReady: ready.ok,
          methodReadyReason: ready.reason,
          tokenValidation: payload,
        });
      }
      return { messages };
    }

    if (req.type === "downloadCli") {
      if (!cliStorageDir) {
        return {
          messages: [
            {
              type: "error",
              message: "扩展存储目录不可用，无法下载 CLI",
              code: "NO_STORAGE",
            },
          ],
        };
      }
      const path = await downloadBundledCli(cliStorageDir, req.kind, (label) => {
        void onProgress?.({ percent: 50, label });
      });
      invalidateCliStatusCache();
      const config = await loadCfg();
      const cliStatus = await buildCliStatus(
        cwd,
        cliStorageDir,
        config.defaultRemote,
      );
      const ready = isMrMethodReady(config, cliStatus);
      const st = req.kind === "glab" ? cliStatus.bundledGlab : cliStatus.bundledGh;
      const loginHint = st.loggedIn
        ? "登录状态：已登录"
        : "登录状态：未登录（请在选项 B 内点「登录」）";
      return {
        messages: [
          {
            type: "downloadCliResult",
            kind: req.kind,
            path,
            messages: [`已下载 ${req.kind} → ${path}`, loginHint],
          },
          {
            type: "gitConfigResult",
            config,
            cliStatus,
            configPath: cfgPath(),
            methodReady: ready.ok,
            methodReadyReason: ready.reason,
          },
        ],
      };
    }

    if (req.type === "prepareCreateMr") {
      if (previewMode) {
        return {
          messages: [
            {
              type: "error",
              message: "预览模式不支持创建 MR，请在扩展中打开真实仓库后操作",
              code: "PREVIEW_READONLY",
            },
          ],
        };
      }
      const config = await loadCfg();
      const cliStatus = await buildCliStatusCached(
        cwd,
        cliStorageDir,
        config.defaultRemote,
      );
      const ready = isMrMethodReady(config, cliStatus);
      if (!ready.ok) {
        return {
          messages: [
            {
              type: "error",
              message: ready.reason || "请先在「Git 配置」中完成 MR 方式配置",
              code: "MR_CONFIG_REQUIRED",
            },
          ],
        };
      }
      const kind = cliStatus.platformHint === "gitlab" ? "glab" : "gh";
      const cliPath =
        config.mrMethod === "download-cli" && cliStorageDir
          ? bundledCliPath(cliStorageDir, kind)
          : undefined;
      const token =
        config.mrMethod === "token"
          ? cliStatus.platformHint === "gitlab"
            ? config.gitlabToken
            : config.githubToken
          : undefined;
      const remote = await resolveOpRemote(cwd, req.remote, loadCfg);
      const data = await prepareCreateMr({
        cwd,
        into: req.into,
        from: req.from,
        sourceBranch: req.sourceBranch,
        remote,
        method: config.mrMethod,
        cliPath,
        token,
      });
      return {
        messages: [
          {
            type: "prepareCreateMrResult",
            platform: data.platform,
            cli: data.cli,
            sourceBranch: data.sourceBranch,
            targetBranch: data.targetBranch,
            title: data.title,
            candidates: data.candidates,
            createMrUrl: data.createMrUrl,
            messages: data.messages,
            cliError: data.cliError,
            method: config.mrMethod,
          },
        ],
      };
    }

    if (req.type === "createMr") {
      if (previewMode) {
        return {
          messages: [
            {
              type: "error",
              message: "预览模式不支持创建 MR，请在扩展中打开真实仓库后操作",
              code: "PREVIEW_READONLY",
            },
          ],
        };
      }
      const config = await loadCfg();
      const cliStatus = await buildCliStatusCached(
        cwd,
        cliStorageDir,
        config.defaultRemote,
      );
      const ready = isMrMethodReady(config, cliStatus);
      if (!ready.ok) {
        return {
          messages: [
            {
              type: "error",
              message: ready.reason || "请先在「Git 配置」中完成 MR 方式配置",
              code: "MR_CONFIG_REQUIRED",
            },
          ],
        };
      }
      const kind = cliStatus.platformHint === "gitlab" ? "glab" : "gh";
      const cliPath =
        config.mrMethod === "download-cli" && cliStorageDir
          ? bundledCliPath(cliStorageDir, kind)
          : undefined;
      const token =
        config.mrMethod === "token"
          ? cliStatus.platformHint === "gitlab"
            ? config.gitlabToken
            : config.githubToken
          : undefined;
      const remote = await resolveOpRemote(cwd, req.remote, loadCfg);
      const data = await createMergeRequest({
        cwd,
        sourceBranch: req.sourceBranch,
        targetBranch: req.targetBranch,
        title: req.title,
        body: req.body,
        reviewers: req.reviewers,
        remote,
        method: config.mrMethod,
        cliPath,
        token,
      });
      return {
        messages: [
          {
            type: "createMrResult",
            platform: data.platform,
            via: data.via,
            url: data.url,
            sourceBranch: data.sourceBranch,
            targetBranch: data.targetBranch,
            messages: data.messages,
          },
        ],
      };
    }

    return {
      messages: [{ type: "error", message: "未知请求", code: "UNKNOWN" }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof GitError ? err.code : "UNKNOWN";
    return { messages: [{ type: "error", message, code }] };
  }
}
