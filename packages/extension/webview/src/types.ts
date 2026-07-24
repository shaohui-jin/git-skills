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

export interface MergePreviewResult {
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
  blamed?: ConflictHunk[];
  outcome?: MergeOutcome;
  unrelatedHistories?: boolean;
}

export interface ConflictBlameResult extends MergePreviewResult {
  blamed: ConflictHunk[];
}

export interface FetchResult {
  repoRoot: string;
  remote: string;
  ok: boolean;
  stdout: string;
  stderr: string;
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
  | { type: "focusTab"; tab: "graph" | "preview" }
  | {
      type: "applyResolveResult";
      tempBranch: string;
      commitSha: string;
      pushed: boolean;
      createMrUrl: string | null;
      messages: string[];
      into: string;
      from: string;
    };

export type TabId = "graph" | "preview";
