export interface BranchTip {
  name: string;
  sha: string;
  upstream?: string;
  remote: boolean;
}

export interface CommitNode {
  sha: string;
  parents: string[];
  message: string;
  author: string;
  time: number;
}

export interface BranchLineage {
  mergeBase: string;
  fromOnlyCount: number;
  intoOnlyCount: number;
  branchedFrom?: {
    sha: string;
    author: string;
    message: string;
    time: number;
  };
}

export interface BranchGraph {
  repoRoot: string;
  nodes: CommitNode[];
  tips: BranchTip[];
  edges: Array<[string, string]>;
  lineage?: BranchLineage;
  truncated: boolean;
  maxNodes: number;
  fetched?: boolean;
  fetchOk?: boolean;
  fetchError?: string;
}

export interface CommitRef {
  sha: string;
  author: string;
  message?: string;
  pr?: string;
  /** author-time（Unix 秒） */
  time?: number;
  authorEmail?: string;
}

export interface ConflictHunk {
  path: string;
  oursRange: [number, number];
  theirsRange: [number, number];
  oursCommits: CommitRef[];
  theirsCommits: CommitRef[];
}

export interface ConflictFile {
  path: string;
  contentConflict: boolean;
  hunks: ConflictHunk[];
  conflictContent?: string | null;
  oursContent?: string | null;
  theirsContent?: string | null;
  baseContent?: string | null;
}

export type MergeOutcome = "clean" | "conflicts" | "unrelated";

export interface ConflictBlameResult {
  repoRoot: string;
  into: string;
  from: string;
  intoSha: string;
  fromSha: string;
  mergeBase: string;
  clean: boolean;
  fetched: boolean;
  conflictFiles: ConflictFile[];
  messages: string[];
  outcome?: MergeOutcome;
  unrelatedHistories?: boolean;
  blamed: ConflictHunk[];
}

export interface FetchResult {
  repoRoot: string;
  remote: string;
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** 比 MergeOutcome 多两个只在批量场景出现的结论 */
export type SurveyOutcome = "clean" | "conflicts" | "unrelated" | "same" | "error";

export interface TempBranchState {
  name: string;
  local: boolean;
  /** 推上去了才谈得上申请 MR */
  remote: boolean;
}

export interface MergeSurveyCell {
  into: string;
  from: string;
  intoSha: string;
  fromSha: string;
  outcome: SurveyOutcome;
  /** 批量场景只给路径，不生成正文 */
  conflictPaths: string[];
  resultTree?: string;
  /** 同名临时分支已存在，说明之前解决过；由 core 查 git 得出 */
  tempBranch?: TempBranchState;
  error?: string;
}

export interface MergeSurveyResult {
  repoRoot: string;
  fetched: boolean;
  generatedAt: number;
  cells: MergeSurveyCell[];
}

export interface MergeChainStep {
  from: string;
  fromSha: string;
  outcome: SurveyOutcome;
  conflictPaths: string[];
  commit: string;
}

export interface MergeChainResult {
  into: string;
  intoSha: string;
  order: string[];
  steps: MergeChainStep[];
  /** 从头开始能连续干净合入的分支数 */
  cleanPrefix: number;
  blockedAt: string | null;
  blockedPaths: string[];
  /** 不是冲突而是别的原因卡住时（ref 解析失败等）的说明 */
  blockedReason?: string;
}

export interface SuggestOrderResult {
  best: MergeChainResult;
  baseline: MergeChainResult;
  tried: number;
}

/**
 * 一对分支「已一键解决并推送」的记录。
 *
 * 注意它不代表这一对已经能干净合并了：一键解决产出的是临时分支
 * `merge/<from>-into-<into>`，from 本身没动，重跑 merge-tree 照样冲突。
 * 所以矩阵里这是一个独立状态，不是把格子重算成绿。
 */
/**
 * 一对分支在「冲突 → 已处理 → 已提 MR」这条链路上走到哪了。
 *
 * 两条路径都用它：冲突的先 tempBranch 后 mr；干净的没有 tempBranch，直接提 MR。
 */
export interface PairProgress {
  into: string;
  from: string;
  /** 记录时两侧的 sha；重跑矩阵后对不上就说明这条记录过期了 */
  intoSha: string;
  fromSha: string;
  /** 一键解决产出的临时分支；干净直合没有这一步 */
  tempBranch?: string;
  /** MR 进展；没有表示还没申请过 */
  mr?: {
    url: string | null;
    /** browser 只是打开了创建页，MR 还没真的建出来，不能当已提交算 */
    via: "gh" | "glab" | "token" | "browser";
  };
}

/** 从矩阵跳进预演时带着的批处理上下文，让人知道自己在整批里的哪一步 */
export interface MatrixTrail {
  pairs: Array<{ into: string; from: string }>;
  index: number;
}

export type MrMethod = "cli" | "download-cli" | "token" | "browser";

export interface GitInsightConfigView {
  version: 1;
  mrMethod: MrMethod | null;
  githubToken?: string;
  gitlabToken?: string;
  /** 默认远程名（如 origin） */
  defaultRemote?: string;
  aiApiBaseUrl?: string;
  aiApiKey?: string;
  aiModel?: string;
  updatedAt: number;
}

export interface GitRemoteView {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface CliStatusPayload {
  platformHint: "github" | "gitlab" | "unknown";
  /** 默认远程 URL 规范化后的 https 网页根 */
  remoteWebOrigin?: string | null;
  remotes: GitRemoteView[];
  defaultRemote: string;
  systemGh: { installed: boolean; loggedIn: boolean };
  systemGlab: { installed: boolean; loggedIn: boolean };
  bundledGh: { installed: boolean; loggedIn: boolean };
  bundledGlab: { installed: boolean; loggedIn: boolean };
  systemCliOk: boolean;
  bundledCliOk: boolean;
}

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
  | { type: "graphResult"; data: BranchGraph; report: string; mermaid: string }
  | { type: "previewResult"; data: ConflictBlameResult; report: string; mermaid: string }
  | { type: "surveyResult"; data: MergeSurveyResult; report: string }
  | { type: "mergeOrderResult"; data: SuggestOrderResult; report: string }
  | { type: "error"; message: string; code?: string }
  | { type: "busy"; busy: boolean; label?: string; percent?: number }
  | { type: "progress"; percent: number; label: string }
  | { type: "focusTab"; tab: "config" | "graph" | "preview" }
  | {
      type: "seedPreview";
      into?: string;
      from?: string;
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
      config: GitInsightConfigView;
      cliStatus: CliStatusPayload;
      configPath: string;
      methodReady: boolean;
      methodReadyReason?: string;
      tokenValidation?: TokenValidateView;
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

export interface TokenValidateView {
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

export type TabId = "config" | "graph" | "preview";
