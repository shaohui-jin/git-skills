/** Host / webview 共用的 AI 选边载荷（与 webview conflict/aiResolveTypes 对齐） */

export type AiResolveRuleId =
  | "preferMine"
  | "preferOnline"
  | "newerWins"
  | "mergeWhenPossible";

export interface AiCommitRef {
  sha: string;
  author: string;
  message?: string;
  time?: number;
  authorEmail?: string;
}

export interface AiResolveHunkInput {
  id: string;
  path: string;
  leftText: string;
  rightText: string;
  baseText: string;
  oursCommits: AiCommitRef[];
  theirsCommits: AiCommitRef[];
}

export interface AiResolveRequestPayload {
  into: string;
  from: string;
  rules: AiResolveRuleId[];
  extraNotes: string;
  hunks: AiResolveHunkInput[];
}

export interface AiResolveHunkResult {
  id: string;
  path: string;
  choice: "ours" | "theirs" | "merge" | "pending";
  mergedContent?: string;
  reason?: string;
}

export interface AiResolveResponsePayload {
  hunks: AiResolveHunkResult[];
  model?: string;
  messages?: string[];
}
