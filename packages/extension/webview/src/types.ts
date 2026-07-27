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
}

export interface CommitRef {
  sha: string;
  author: string;
  message?: string;
  pr?: string;
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

export type MrMethod = "cli" | "download-cli" | "token" | "browser";

export interface GitInsightConfigView {
  version: 1;
  mrMethod: MrMethod | null;
  githubToken?: string;
  gitlabToken?: string;
  updatedAt: number;
}

export interface CliStatusPayload {
  platformHint: "github" | "gitlab" | "unknown";
  systemGh: { installed: boolean; loggedIn: boolean };
  systemGlab: { installed: boolean; loggedIn: boolean };
  bundledGh: { installed: boolean; loggedIn: boolean };
  bundledGlab: { installed: boolean; loggedIn: boolean };
  systemCliOk: boolean;
  bundledCliOk: boolean;
}

export type HostMessage =
  | {
      type: "workspace";
      cwd: string | null;
      branches: Array<{ name: string; remote: boolean }>;
      error?: string;
      previewMode?: boolean;
    }
  | { type: "fetchResult"; data: FetchResult; report: string }
  | { type: "graphResult"; data: BranchGraph; report: string; mermaid: string }
  | { type: "previewResult"; data: ConflictBlameResult; report: string; mermaid: string }
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
