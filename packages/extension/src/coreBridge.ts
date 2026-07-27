import {
  applyStashedResolve,
  buildBranchGraph,
  createMergeRequest,
  detectMrPlatform,
  fetchRemote,
  normalizeRemoteWebUrl,
  prepareCreateMr,
  rehearseMerge,
  reportFetch,
  reportGraph,
  reportMergeRehearsal,
  resolveRepoRoot,
  runGit,
  graphToMermaid,
  mergeToMermaid,
  summarizeTokenValidation,
  validateGithubToken,
  validateGitlabToken,
  GitError,
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
  name: string;
  remote: boolean;
}

/**
 * 列出全部本地/远程分支，不做数量截断。
 * 本地分支用 refs/heads 判定（名称可含 `/`，不能按 `/` 误判为远程）。
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
      names.push({ name: shortName, remote: false });
      continue;
    }
    if (/^refs\/remotes\/[^/]+\/.+/.test(refname)) {
      names.push({ name: shortName, remote: true });
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

async function buildCliStatus(
  repoRoot: string,
  cliStorageDir: string | undefined,
): Promise<CliStatusPayload> {
  const remote = await runGit(repoRoot, ["remote", "get-url", "origin"], {
    allowFail: true,
  });
  const platformHint = detectMrPlatform(remote.stdout.trim());
  const systemGh = await checkSystemCli(repoRoot, "gh");
  const systemGlab = await checkSystemCli(repoRoot, "glab");
  const bundledGh = cliStorageDir
    ? await checkBundledCli(cliStorageDir, "gh", repoRoot)
    : { installed: false, loggedIn: false };
  const bundledGlab = cliStorageDir
    ? await checkBundledCli(cliStorageDir, "glab", repoRoot)
    : { installed: false, loggedIn: false };
  return {
    platformHint,
    systemGh,
    systemGlab,
    bundledGh,
    bundledGlab,
    systemCliOk: cliPairOk(platformHint, systemGh, systemGlab),
    bundledCliOk: cliPairOk(platformHint, bundledGh, bundledGlab),
  };
}

async function remoteOrigin(repoRoot: string): Promise<string> {
  const remote = await runGit(repoRoot, ["remote", "get-url", "origin"], {
    allowFail: true,
  });
  return remote.stdout.trim();
}

/** 方案 C：按当前远程平台校验 Token 格式 + API 有效性/有效期 */
async function validateTokenForRepo(
  repoRoot: string,
  tokens: { githubToken?: string; gitlabToken?: string },
): Promise<TokenValidateResult> {
  const originUrl = await remoteOrigin(repoRoot);
  const platform = detectMrPlatform(originUrl);
  if (platform === "github") {
    return validateGithubToken(tokens.githubToken ?? "");
  }
  if (platform === "gitlab") {
    const web = normalizeRemoteWebUrl(originUrl) || "https://gitlab.com";
    return validateGitlabToken(tokens.gitlabToken ?? "", web);
  }
  // 平台未知：优先校已填写的一侧
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
    ok: false,
    error: "无法识别远程平台，且未填写 Token",
  };
}

function tokenResultPayload(result: TokenValidateResult) {
  return {
    ...result,
    summary: summarizeTokenValidation(result),
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
    return loadUserConfig(configMemento, cwd);
  };
  const saveCfg = async (config: Awaited<ReturnType<typeof loadUserConfig>>) => {
    if (!configMemento) {
      throw new Error("扩展配置存储不可用");
    }
    return saveUserConfig(configMemento, config);
  };

  if (req.type === "ready" || req.type === "refreshWorkspace") {
    const messages: HostMessage[] = [await workspacePayload(cwd, previewMode)];
    if (cwd && configMemento) {
      try {
        const config = await loadCfg();
        const cliStatus = await buildCliStatus(cwd, cliStorageDir);
        // 从未选过 MR 方式：有本机 gh/glab → A，否则 → D
        let cfg = config;
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
          configPath: configPath(),
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
        const resolved = await ensureRemoteRepo(path);
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
      const data = await fetchRemote(cwd, req.remote ?? "origin");
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
      const data = await buildBranchGraph({
        cwd,
        into: req.into,
        from: req.from,
        fetch: !req.noFetch,
        maxNodes,
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
              message: "请填写目标分支与待合并分支",
              code: "USAGE",
            },
          ],
        };
      }
      const data = await rehearseMerge({
        cwd,
        into: req.into,
        from: req.from,
        fetch: !req.noFetch,
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
              message: "请填写目标分支与待合并分支",
              code: "USAGE",
            },
          ],
        };
      }
      if (!req.files?.length) {
        return {
          messages: [
            {
              type: "error",
              message: "没有暂存的解决结果，请先完成冲突选择并「暂存结果」",
              code: "NO_STASH",
            },
          ],
        };
      }
      const data = await applyStashedResolve({
        cwd,
        into: req.into,
        from: req.from,
        files: req.files,
        remote: req.remote,
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

    if (req.type === "getGitConfig") {
      const config = await loadCfg();
      let cfg = config;
      const cliStatus = await buildCliStatus(cwd, cliStorageDir);
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
            configPath: configPath(),
            methodReady: ready.ok,
            methodReadyReason: ready.reason,
          },
        ],
      };
    }

    if (req.type === "saveGitConfig") {
      const prev = await loadCfg();
      const nextMethod = req.config.mrMethod;
      const nextGithub = req.config.githubToken ?? "";
      const nextGitlab = req.config.gitlabToken ?? "";
      let tokenValidation: ReturnType<typeof tokenResultPayload> | undefined;

      if (nextMethod === "token") {
        void onProgress?.({ percent: 40, label: "校验 Token 格式与有效性…" });
        const checked = await validateTokenForRepo(cwd, {
          githubToken: nextGithub,
          gitlabToken: nextGitlab,
        });
        tokenValidation = tokenResultPayload(checked);
        if (!checked.ok) {
          const cliStatus = await buildCliStatus(cwd, cliStorageDir);
          const ready = isMrMethodReady(prev, cliStatus);
          return {
            messages: [
              {
                type: "error",
                message: `Token 校验未通过：${tokenValidation.summary}`,
                code: "TOKEN_INVALID",
              },
              {
                type: "tokenValidateResult",
                ...tokenValidation,
              },
              {
                type: "gitConfigResult",
                config: prev,
                cliStatus,
                configPath: configPath(),
                methodReady: ready.ok,
                methodReadyReason: ready.reason,
                tokenValidation,
              },
            ],
          };
        }
      }

      const saved = await saveCfg({
        ...prev,
        mrMethod: nextMethod,
        githubToken: nextGithub,
        gitlabToken: nextGitlab,
      });
      const cliStatus = await buildCliStatus(cwd, cliStorageDir);
      const ready = isMrMethodReady(saved, cliStatus);
      return {
        messages: [
          {
            type: "gitConfigResult",
            config: saved,
            cliStatus,
            configPath: configPath(),
            methodReady: ready.ok,
            methodReadyReason: tokenValidation
              ? tokenValidation.summary
              : ready.reason,
            tokenValidation,
          },
        ],
      };
    }

    if (req.type === "validateToken") {
      void onProgress?.({ percent: 40, label: "校验 Token…" });
      const checked = await validateTokenForRepo(cwd, {
        githubToken: req.githubToken,
        gitlabToken: req.gitlabToken,
      });
      return {
        messages: [{ type: "tokenValidateResult", ...tokenResultPayload(checked) }],
      };
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
      const cliStatus = await buildCliStatus(cwd, cliStorageDir);
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
            configPath: configPath(),
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
      const cliStatus = await buildCliStatus(cwd, cliStorageDir);
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
      const data = await prepareCreateMr({
        cwd,
        into: req.into,
        from: req.from,
        sourceBranch: req.sourceBranch,
        remote: req.remote,
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
      const cliStatus = await buildCliStatus(cwd, cliStorageDir);
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
      const data = await createMergeRequest({
        cwd,
        sourceBranch: req.sourceBranch,
        targetBranch: req.targetBranch,
        title: req.title,
        body: req.body,
        reviewers: req.reviewers,
        remote: req.remote,
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
