import {
  applyStashedResolve,
  buildBranchGraph,
  createMergeRequest,
  detectMrPlatform,
  fetchRemote,
  listRemotes,
  normalizeRemoteWebUrl,
  prepareCreateMr,
  rehearseMerge,
  reportFetch,
  reportGraph,
  reportMergeRehearsal,
  resolveDefaultRemote,
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
} from "@git-insight/core";
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
  const platformHint = detectMrPlatform(remoteUrl);
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

export async function handleWebviewRequest(
  req: WebviewRequest,
  cwd: string | null,
  options?: {
    previewMode?: boolean;
    onProgress?: (update: { percent: number; label: string }) => void;
    /** 扩展 globalStorage，用于 B：下载 CLI */
    cliStorageDir?: string;
    /** 扩展 globalState：Token / MR 方式全仓库共用 */
    configMemento?: ConfigMemento;
  },
): Promise<{ messages: HostMessage[]; cwd?: string | null }> {
  const previewMode = options?.previewMode;
  const onProgress = options?.onProgress;
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
    const messages: HostMessage[] = [await workspacePayload(cwd, previewMode)];
    if (cwd && configMemento) {
      try {
        const config = await loadCfg();
        let cfg = config;
        const cliStatus = await buildCliStatus(
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
      ? await buildCliStatus(cwd, cliStorageDir, cfg.defaultRemote)
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
      ? await buildCliStatus(cwd, cliStorageDir, saved.defaultRemote)
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
        const cliStatus = await buildCliStatus(
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
      const cliStatus = await buildCliStatus(
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
      const cliStatus = await buildCliStatus(
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
