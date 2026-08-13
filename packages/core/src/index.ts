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
  fetchRemoteQuiet,
  maybeFetch,
  probeRemoteAccess,
  resolveFetchAuth,
} from "./git/fetch.js";
export {
  listRemotes,
  readConfiguredDefaultRemote,
  resolveDefaultRemote,
  resolveRemoteName,
  splitRemoteTipName,
  userConfigHomePath,
  USER_CONFIG_HOME_FILE,
} from "./git/remotes.js";
export type { GitRemoteInfo } from "./git/remotes.js";
export {
  gitAuthConfigArgs,
  gitInteractiveEnv,
  gitNonInteractiveEnv,
  httpsUrlWithToken,
} from "./git/auth.js";
export type { GitAuthOptions, GitAuthProvider } from "./git/auth.js";
export { buildBranchGraph } from "./graph/builder.js";
export { previewMerge, previewMergeBySha } from "./merge/preview.js";
export {
  clearMergeSurveyCache,
  crossPairs,
  surveyMerges,
} from "./merge/survey.js";
export type {
  MergeSurveyCell,
  MergeSurveyOptions,
  MergeSurveyPair,
  MergeSurveyResult,
  SurveyOutcome,
  TempBranchState,
} from "./merge/survey.js";
export { simulateMergeChain, suggestMergeOrder } from "./merge/chain.js";
export type {
  MergeChainResult,
  MergeChainStep,
  SimulateChainOptions,
  SuggestOrderOptions,
  SuggestOrderResult,
} from "./merge/chain.js";
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
  autoResolveConflicts,
  builtinResolvers,
  readThreeWay,
  regenerate,
  takeOurs,
  takeTheirs,
  union,
} from "./merge/resolvers.js";
export type {
  AutoResolveOutcome,
  ConflictResolver,
  ResolveContext,
} from "./merge/resolvers.js";
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
  reportMergeOrder,
  reportMergeRehearsal,
  reportMergeSurvey,
  reportFetch,
} from "./report/chinese.js";
export { GIT_INSIGHT_EXTENSION_ID, openInsightPanel } from "./ui/openPanel.js";
export type { OpenPanelOptions, OpenPanelResult } from "./ui/openPanel.js";
