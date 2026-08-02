export type {
  GitInsightProjectConfig,
  MrMethod,
} from "./config/gitInsightConfig.js";
export {
  defaultGitInsightConfig,
  GIT_INSIGHT_CONFIG_FILE,
  GIT_INSIGHT_DIR,
  mrMethodLabel,
} from "./config/gitInsightConfig.js";
export {
  formatChinaDateTime,
  summarizeTokenValidation,
  titleSideStatus,
  validateGithubToken,
  validateGithubTokenFormat,
  validateGitlabToken,
  validateGitlabTokenFormat,
} from "./config/validateToken.js";
export type {
  TokenFormatResult,
  TokenPlatform,
  TokenValidateResult,
} from "./config/validateToken.js";

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
export {
  fetchRemote,
  maybeFetch,
  probeRemoteAccess,
  resolveFetchAuth,
} from "./git/fetch.js";
export {
  gitAuthConfigArgs,
  gitInteractiveEnv,
  gitNonInteractiveEnv,
  httpsUrlWithToken,
} from "./git/auth.js";
export type { GitAuthOptions, GitAuthProvider } from "./git/auth.js";
export { buildBranchGraph } from "./graph/builder.js";
export { previewMerge } from "./merge/preview.js";
export { conflictBlame } from "./merge/blame.js";
export { rehearseMerge } from "./merge/rehearsal.js";
export {
  applyStashedResolve,
  buildCreateMrUrl,
  defaultTempBranchName,
} from "./merge/applyResolve.js";
export type {
  ApplyResolveOptions,
  ApplyResolveResult,
  StashFilePayload,
} from "./merge/applyResolve.js";
export {
  branchNameForMr,
  isSameBranchForMr,
  needsTempBranchForMr,
} from "./merge/branchName.js";
export {
  createMergeRequest,
  detectMrPlatform,
  normalizeRemoteWebUrl,
  prepareCreateMr,
} from "./merge/createMr.js";
export type {
  CreateMergeRequestOptions,
  CreateMergeRequestResult,
  MrCandidate,
  MrPlatform,
  PrepareCreateMrOptions,
  PrepareCreateMrResult,
} from "./merge/createMr.js";
export { graphToMermaid, mergeToMermaid } from "./report/mermaid.js";
export {
  reportGraph,
  reportMerge,
  reportBlame,
  reportMergeRehearsal,
  reportFetch,
} from "./report/chinese.js";
