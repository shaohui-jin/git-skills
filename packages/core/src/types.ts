/** Stable JSON schema consumed by Skill and future web/extension UI. */

export interface CommitNode {
  sha: string;
  parents: string[];
  message: string;
  author: string;
  time: number;
}

export interface BranchTip {
  name: string;
  sha: string;
  upstream?: string;
  remote: boolean;
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
  /** True when merge-tree reported a content conflict on this path. */
  contentConflict: boolean;
  hunks: ConflictHunk[];
  /** Conflict-marker text (diff3) for display; null if unavailable. */
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
  /** 空字符串表示算不出共同祖先（无关历史） */
  mergeBase: string;
  clean: boolean;
  fetched: boolean;
  conflictFiles: ConflictFile[];
  /** Raw informational messages from merge-tree when available. */
  messages: string[];
  /** 预演结论：干净 / 内容冲突 / 无关历史 */
  outcome?: MergeOutcome;
  /** 两条历史没有共同祖先 */
  unrelatedHistories?: boolean;
}

/** Full merge rehearsal: preview + conflict contents + blame provenance. */
export interface ConflictBlameResult extends MergePreviewResult {
  blamed: ConflictHunk[];
}

/** Alias used by CLI / UI「合并预演」. */
export type MergeRehearsalResult = ConflictBlameResult;

export interface FetchResult {
  repoRoot: string;
  remote: string;
  ok: boolean;
  stdout: string;
  stderr: string;
}

export interface GraphOptions {
  cwd?: string;
  /** Limit DAG nodes; default 200. Pass `0` for unlimited (full graph). */
  maxNodes?: number;
  /** Optional pair for lineage focus. */
  into?: string;
  from?: string;
  /** Default true for skill usage. */
  fetch?: boolean;
  remote?: string;
}

export interface MergeOptions {
  cwd?: string;
  into: string;
  from: string;
  /** Default true. */
  fetch?: boolean;
  remote?: string;
  /** Max files to run blame on; default 20. */
  maxBlameFiles?: number;
}

export interface CliJsonResult<T> {
  ok: true;
  command: string;
  data: T;
  mermaid?: string;
  report?: string;
}

export interface CliJsonError {
  ok: false;
  command: string;
  error: string;
  code?: string;
}
