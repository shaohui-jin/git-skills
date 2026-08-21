import type {
  BatchMergePlanResult,
  BatchMergeRunResult,
  BatchMrPrecheckResult,
  BatchRunItem,
  BranchGraph,
  ConflictBlameResult,
  FetchResult,
  GitInsightProjectConfig,
  MergeSurveyResult,
  MrMethod,
  ResolverTemplateMeta,
  SuggestOrderResult,
} from "@shaohui_jin/git-insight-core";

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
      type: "survey";
      /** 列：线上目标 */
      intos: string[];
      /** 行：我的分支 */
      froms: string[];
      noFetch?: boolean;
    }
  | {
      type: "mergeOrder";
      into: string;
      branches: string[];
      noFetch?: boolean;
    }
  | {
      type: "applyResolve";
      into: string;
      from: string;
      /** 干净合并可传空数组（仅临时分支 merge + push） */
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
        /** 本会话解决记录的 commitSha */
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
      items: Array<BatchRunItem>;
      noFetch?: boolean;
      remote?: string;
    }
  | {
      /** 推送已存在的本地分支（批量分支重推 / 单分支 MR 前补推送） */
      type: "pushBranch";
      branch: string;
      remote?: string;
    }
  | {
      /** MR 前终检：批量分支 vs 最新 origin/into */
      type: "batchMrPrecheck";
      into: string;
      batchBranch: string;
      remote?: string;
    }
  | {
      /** 批量成功后清理：删除参与合并的本地 merge/* 临时分支 */
      type: "deleteLocalBranches";
      branches: string[];
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
      /** 指派人 + 审核人（同一批用户名） */
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
        defaultRemote?: string;
        aiApiBaseUrl?: string;
        aiApiKey?: string;
        aiModel?: string;
        autoResolveEnabled?: boolean;
        autoResolveTemplates?: string[];
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

export interface CliStatusPayload {
  platformHint: "github" | "gitlab" | "unknown";
  /** 默认远程 URL 规范化后的 https 站点根，如 https://gitlab.example.com */
  remoteWebOrigin?: string | null;
  /** 当前仓库 `git remote -v`（无仓库时为空） */
  remotes: Array<{ name: string; fetchUrl: string; pushUrl: string }>;
  /** 解析后的默认远程名 */
  defaultRemote: string;
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
  | { type: "theme"; theme: "light" | "dark" }
  | {
      type: "workspace";
      cwd: string | null;
      branches: Array<{
        name: string;
        remote: boolean;
        remoteName?: string;
        gitRef: string;
      }>;
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
  | { type: "surveyResult"; data: MergeSurveyResult; report: string }
  | { type: "mergeOrderResult"; data: SuggestOrderResult; report: string }
  | { type: "batchMergePlanResult"; data: BatchMergePlanResult }
  | { type: "batchMergeRunResult"; data: BatchMergeRunResult }
  | { type: "pushBranchResult"; branch: string; remote: string; sha: string }
  | { type: "batchMrPrecheckResult"; data: BatchMrPrecheckResult }
  | {
      type: "deleteLocalBranchesResult";
      deleted: string[];
      failed: Array<{ branch: string; error: string }>;
    }
  | { type: "error"; message: string; code?: string }
  | { type: "busy"; busy: boolean; label?: string; percent?: number }
  | { type: "progress"; percent: number; label: string }
  | { type: "focusTab"; tab: "config" | "graph" | "preview" }
  | {
      type: "seedPreview";
      into?: string;
      from?: string;
      /** 默认 true：种入分支后自动开始预演 */
      autoPreview?: boolean;
    }
  | {
      type: "applyResolveResult";
      tempBranch: string;
      commitSha: string;
      pushed: boolean;
      createMrUrl: string | null;
      messages: string[];
      into: string;
      from: string;
      /** 两侧当时的 sha：矩阵靠它判断「已处理」标记还算不算数 */
      intoSha: string;
      fromSha: string;
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
      /** 内建 resolver 模板元数据（供配置页勾选展示） */
      templates: ResolverTemplateMeta[];
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
    }
  | { type: "pong"; nonce: string; extensionVersion: string }
  | {
      type: "aiResolveBridgeReady";
      port: number;
      callbackUrl: string;
      prompt: string;
      promptFile: string;
      conflictsFile: string;
      resultFile: string;
      openedChat: boolean;
      copied: boolean;
      pasted?: boolean;
      submitted?: boolean;
      batchIndex?: number;
      batchTotal?: number;
    }
  | {
      type: "aiResolveConflictsResult";
      into: string;
      from: string;
      hunks: Array<{
        id: string;
        path: string;
        choice: "ours" | "theirs" | "merge" | "pending";
        mergedContent?: string;
        reason?: string;
      }>;
      model?: string;
      messages?: string[];
    };
