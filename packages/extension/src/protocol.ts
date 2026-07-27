import type {
  BranchGraph,
  ConflictBlameResult,
  FetchResult,
  GitInsightProjectConfig,
  MrMethod,
} from "@git-insight/core";

/** Webview -> Extension host / preview server */
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
      /** 0 = 全量；默认由宿主按全量处理 */
      maxNodes?: number;
    }
  | { type: "preview"; into: string; from: string; noFetch?: boolean }
  /** @deprecated 同 preview（合并预演） */
  | { type: "blame"; into: string; from: string; noFetch?: boolean }
  | {
      type: "applyResolve";
      into: string;
      from: string;
      files: Array<{ path: string; resolvedContent: string }>;
      remote?: string;
      push?: boolean;
      tempBranch?: string;
    }
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
      reviewers?: string[];
      remote?: string;
    }
  | { type: "openExternal"; url: string }
  | { type: "getGitConfig" }
  | {
      type: "saveGitConfig";
      config: {
        mrMethod: MrMethod | null;
        githubToken?: string;
        gitlabToken?: string;
      };
    }
  | {
      type: "validateToken";
      platform: "github" | "gitlab";
      githubToken?: string;
      gitlabToken?: string;
      /** 校验后是否写入全局配置 */
      persist?: boolean;
      mrMethod?: MrMethod | null;
    }
  | { type: "downloadCli"; kind: "gh" | "glab" }
  | {
      type: "cliAuthLogin";
      /** system = PATH 中的 A；bundled = 扩展目录 B */
      scope: "system" | "bundled";
      kind: "gh" | "glab";
    };

export interface CliStatusPayload {
  platformHint: "github" | "gitlab" | "unknown";
  systemGh: { installed: boolean; loggedIn: boolean };
  systemGlab: { installed: boolean; loggedIn: boolean };
  bundledGh: { installed: boolean; loggedIn: boolean };
  bundledGlab: { installed: boolean; loggedIn: boolean };
  /** 有可用系统 CLI（按平台，需已登录） */
  systemCliOk: boolean;
  /** 扩展内 CLI 已下载且已登录（按平台） */
  bundledCliOk: boolean;
}

/** Extension host / preview server -> Webview */
export type HostMessage =
  | {
      type: "workspace";
      cwd: string | null;
      branches: Array<{ name: string; remote: boolean }>;
      error?: string;
      previewMode?: boolean;
    }
  | { type: "fetchResult"; data: FetchResult; report: string }
  | {
      type: "graphResult";
      data: BranchGraph;
      report: string;
      mermaid: string;
    }
  | {
      type: "previewResult";
      data: ConflictBlameResult;
      report: string;
      mermaid: string;
    }
  | { type: "error"; message: string; code?: string }
  | { type: "busy"; busy: boolean; label?: string; percent?: number }
  | { type: "progress"; percent: number; label: string }
  | { type: "focusTab"; tab: "config" | "graph" | "preview" }
  | {
      type: "applyResolveResult";
      tempBranch: string;
      commitSha: string;
      pushed: boolean;
      createMrUrl: string | null;
      messages: string[];
      into: string;
      from: string;
      previousBranch: string | null;
      usedWorktree: boolean;
    }
  | {
      type: "prepareCreateMrResult";
      platform: "github" | "gitlab" | "unknown";
      cli: "gh" | "glab" | null;
      sourceBranch: string;
      targetBranch: string;
      title: string;
      candidates: Array<{ username: string; name?: string; role?: string }>;
      createMrUrl: string | null;
      messages: string[];
      cliError?: string;
      method: MrMethod | null;
    }
  | {
      type: "createMrResult";
      platform: "github" | "gitlab" | "unknown";
      via: "gh" | "glab" | "token" | "browser";
      url: string | null;
      sourceBranch: string;
      targetBranch: string;
      messages: string[];
    }
  | {
      type: "gitConfigResult";
      config: GitInsightProjectConfig;
      cliStatus: CliStatusPayload;
      configPath: string;
      /** 方式是否就绪（不含推送顺序） */
      methodReady: boolean;
      methodReadyReason?: string;
      /** 方案 C 保存时附带的 Token 校验摘要 */
      tokenValidation?: {
        ok: boolean;
        platform: "github" | "gitlab";
        formatOk: boolean;
        formatMessage: string;
        apiChecked: boolean;
        apiOk: boolean;
        login?: string;
        expiresAt?: string | null;
        expiresMessage?: string;
        statusLabel: string;
        error?: string;
        summary: string;
        titleStatus: string;
      };
    }
  | {
      type: "tokenValidateResult";
      ok: boolean;
      platform: "github" | "gitlab";
      formatOk: boolean;
      formatMessage: string;
      apiChecked: boolean;
      apiOk: boolean;
      login?: string;
      expiresAt?: string | null;
      expiresMessage?: string;
      statusLabel: string;
      error?: string;
      summary: string;
      titleStatus: string;
    }
  | {
      type: "downloadCliResult";
      kind: "gh" | "glab";
      path: string;
      messages: string[];
    };
