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
  /** 本次是否尝试了 fetch（未传 noFetch） */
  fetched?: boolean;
  /** fetch 是否成功；失败时 tips 可能落后于线上 */
  fetchOk?: boolean;
  /** fetch 失败原因摘要 */
  fetchError?: string;
}

export interface CommitRef {
  sha: string;
  author: string;
  message?: string;
  pr?: string;
  /** author-time（Unix 秒），来自 blame porcelain */
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
  /**
   * `merge-tree --write-tree` 产出的结果树 OID。冲突时同样有值，只是树里的
   * blob 带冲突标记。合并顺序模拟靠它接 `commit-tree` 串起下一步。
   */
  resultTree?: string;
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

export interface ProgressUpdate {
  /** 0–100 */
  percent: number;
  label: string;
}

export type ProgressReporter = (update: ProgressUpdate) => void | Promise<void>;

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
  /** 扩展配置中的 Token，用于 fetch 鉴权（避免系统登录弹窗） */
  authToken?: string;
  authProvider?: "github" | "gitlab" | "unknown";
  onProgress?: ProgressReporter;
}

export interface MergeOptions {
  cwd?: string;
  into: string;
  from: string;
  /** Default true. */
  fetch?: boolean;
  remote?: string;
  authToken?: string;
  authProvider?: "github" | "gitlab" | "unknown";
  /** Max files to run blame on; default 20. */
  maxBlameFiles?: number;
  /**
   * 是否为溯源到的 commit 关联 PR 号（每个 commit 一次 `gh` 网络调用）。
   * 默认关闭：文件多时它会主导整个预演耗时。
   */
  lookupPr?: boolean;
  onProgress?: ProgressReporter;
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
