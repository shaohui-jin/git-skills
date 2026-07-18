import {
  buildBranchGraph,
  fetchRemote,
  rehearseMerge,
  reportFetch,
  reportGraph,
  reportMergeRehearsal,
  resolveRepoRoot,
  runGit,
  graphToMermaid,
  mergeToMermaid,
  GitError,
} from "@git-insight/core";
import type { HostMessage, WebviewRequest } from "./protocol.js";
import {
  ensureRemoteRepo,
  isRemoteOnlyMode,
  looksLikeRemoteRepo,
} from "./remoteRepo.js";

export async function listBranchNames(cwd: string): Promise<string[]> {
  const { stdout } = await runGit(cwd, [
    "for-each-ref",
    "--format=%(refname)%00%(refname:short)",
    "refs/heads",
    "refs/remotes",
  ]);
  const names: string[] = [];
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
    // 只保留 heads / remotes/<remote>/<branch>
    if (refname.startsWith("refs/heads/") || /^refs\/remotes\/[^/]+\/.+/.test(refname)) {
      names.push(shortName);
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
export async function handleWebviewRequest(
  req: WebviewRequest,
  cwd: string | null,
  options?: { previewMode?: boolean },
): Promise<{ messages: HostMessage[]; cwd?: string | null }> {
  const previewMode = options?.previewMode;

  if (req.type === "ready" || req.type === "refreshWorkspace") {
    return { messages: [await workspacePayload(cwd, previewMode)] };
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

    // 远程：真实 git clone / fetch（非写死样例）
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
      const data = await buildBranchGraph({
        cwd,
        into: req.into,
        from: req.from,
        fetch: !req.noFetch,
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

    return {
      messages: [{ type: "error", message: "未知请求", code: "UNKNOWN" }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = err instanceof GitError ? err.code : "UNKNOWN";
    return { messages: [{ type: "error", message, code }] };
  }
}
