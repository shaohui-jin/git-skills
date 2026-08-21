export type WebviewRequest =
  | { type: "ready" }
  | { type: "refreshWorkspace" }
  | { type: "setCwd"; path: string }
  | { type: "pickFolder" }
  | { type: "fetch"; remote?: string }
  | {
      type: "graph";
      into?: string;
      from?: string;
      noFetch?: boolean;
      maxNodes?: number;
    }
  | { type: "preview"; into: string; from: string; noFetch?: boolean }
  | { type: "blame"; into: string; from: string; noFetch?: boolean }
  | { type: "survey"; intos: string[]; froms: string[]; noFetch?: boolean }
  | { type: "mergeOrder"; into: string; branches: string[]; noFetch?: boolean }
  | {
      type: "applyResolve";
      into: string;
      from: string;
      files: Array<{ path: string; resolvedContent: string }>;
      remote?: string;
      push?: boolean;
      /** 矩阵模式：不推送也保留本地临时分支 */
      keepLocal?: boolean;
      tempBranch?: string;
    }
  | {
      /** 批量合并干跑预演（零副作用，确认对话框内自动跑） */
      type: "batchMergePlan";
      into: string;
      entries: Array<{
        from: string;
        /** 冲突格子已解决过：必须有可用临时分支 */
        resolved?: boolean;
        commitSha?: string;
      }>;
      noFetch?: boolean;
      remote?: string;
    }
  | {
      /** 批量合并实跑：worktree 累积真合并 + 单次 push（sha 护栏内置） */
      type: "batchMergeRun";
      into: string;
      batchBranch: string;
      items: Array<{
        from: string;
        source: string;
        sourceKind: "branch" | "temp-local" | "temp-remote";
        sourceSha: string;
      }>;
      noFetch?: boolean;
      remote?: string;
    }
  | { type: "pushBranch"; branch: string; remote?: string }
  | { type: "batchMrPrecheck"; into: string; batchBranch: string; remote?: string }
  | { type: "deleteLocalBranches"; branches: string[] }
  | {
      type: "prepareCreateMr";
      into: string;
      from: string;
      sourceBranch?: string;
      remote?: string;
    }
  | {
      type: "createMr";
      sourceBranch: string;
      targetBranch: string;
      title?: string;
      body?: string;
      /** 指派人 + 审核人（同一批用户名） */
      reviewers?: string[];
      remote?: string;
    }
  | { type: "openExternal"; url: string }
  | { type: "getGitConfig" }
  | {
      type: "saveGitConfig";
      config: {
        mrMethod: "cli" | "download-cli" | "token" | "browser" | null;
        githubToken?: string;
        gitlabToken?: string;
        aiApiBaseUrl?: string;
        aiApiKey?: string;
        aiModel?: string;
      };
    }
  | {
      type: "validateToken";
      platform: "github" | "gitlab";
      githubToken?: string;
      gitlabToken?: string;
      persist?: boolean;
      mrMethod?: "cli" | "download-cli" | "token" | "browser" | null;
    }
  | { type: "downloadCli"; kind: "gh" | "glab" }
  | {
      type: "cliAuthLogin";
      scope: "system" | "bundled";
      kind: "gh" | "glab";
    }
  | { type: "ping"; nonce: string }
  | {
      type: "aiResolveConflicts";
      into: string;
      from: string;
      rules: Array<"preferMine" | "preferOnline" | "newerWins" | "mergeWhenPossible">;
      extraNotes: string;
      hunks: Array<{
        id: string;
        path: string;
        leftText: string;
        rightText: string;
        baseText: string;
        oursCommits: Array<{
          sha: string;
          author: string;
          message?: string;
          time?: number;
          authorEmail?: string;
        }>;
        theirsCommits: Array<{
          sha: string;
          author: string;
          message?: string;
          time?: number;
          authorEmail?: string;
        }>;
      }>;
    }
  | { type: "aiResolveCancelBridge" }
  | { type: "aiResolveCopyPrompt" };

export interface VsCodeApi {
  postMessage(message: WebviewRequest): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

declare const __GIT_INSIGHT_PREVIEW__: boolean | undefined;

let api: VsCodeApi | undefined;

function dispatchHostMessage(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { data }));
}

function createBrowserBridge(): VsCodeApi {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${proto}://${location.host}/ws`;
  let socket: WebSocket | null = null;
  let opened = false;
  const queue: WebviewRequest[] = [];

  const connect = () => {
    socket = new WebSocket(wsUrl);
    socket.addEventListener("open", () => {
      opened = true;
      while (queue.length > 0) {
        const msg = queue.shift();
        if (msg) {
          socket?.send(JSON.stringify(msg));
        }
      }
    });
    socket.addEventListener("message", (ev) => {
      try {
        dispatchHostMessage(JSON.parse(String(ev.data)));
      } catch {
        dispatchHostMessage({
          type: "error",
          message: "无法解析预览服务响应",
        });
      }
    });
    socket.addEventListener("close", () => {
      opened = false;
      dispatchHostMessage({
        type: "error",
        message: "与本地预览服务断开，请确认 pnpm preview 仍在运行",
      });
      setTimeout(connect, 1500);
    });
    socket.addEventListener("error", () => {
      // close handler reconnects
    });
  };

  connect();

  return {
    postMessage(message) {
      if (opened && socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(message));
      } else {
        queue.push(message);
      }
    },
    getState: () => undefined,
    setState: () => undefined,
  };
}

export function getVsCodeApi(): VsCodeApi {
  if (api) {
    return api;
  }

  const forcePreview =
    typeof __GIT_INSIGHT_PREVIEW__ !== "undefined" && __GIT_INSIGHT_PREVIEW__;

  if (!forcePreview) {
    try {
      api = acquireVsCodeApi();
      return api;
    } catch {
      // browser bridge
    }
  }

  api = createBrowserBridge();
  return api;
}

export function isPreviewMode(): boolean {
  return typeof __GIT_INSIGHT_PREVIEW__ !== "undefined" && !!__GIT_INSIGHT_PREVIEW__;
}
