export type {
  BranchGraph,
  BranchLineage,
  BranchTip,
  CliJsonError,
  CliJsonResult,
  CommitNode,
  CommitRef,
  ConflictBlameResult,
  ConflictFile,
  ConflictHunk,
  FetchResult,
  GraphOptions,
  MergeOptions,
  MergeOutcome,
  MergePreviewResult,
  MergeRehearsalResult,
  ProgressReporter,
  ProgressUpdate,
} from "./types.js";

export { GitError, resolveRepoRoot, runGit, tryMergeBase } from "./git/runner.js";
export { getGitVersion, assertMergeTreeSupported } from "./git/version.js";
export { fetchRemote, maybeFetch } from "./git/fetch.js";
export { buildBranchGraph } from "./graph/builder.js";
export { previewMerge } from "./merge/preview.js";
export { conflictBlame } from "./merge/blame.js";
export { rehearseMerge } from "./merge/rehearsal.js";
export { graphToMermaid, mergeToMermaid } from "./report/mermaid.js";
export {
  reportGraph,
  reportMerge,
  reportBlame,
  reportMergeRehearsal,
  reportFetch,
} from "./report/chinese.js";
