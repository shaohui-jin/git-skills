import type { CommitRef } from "../types";

/** AI 选边规则（可组合） */
export type AiResolveRuleId =
  | "preferMine"
  | "preferOnline"
  | "newerWins"
  | "mergeWhenPossible";

export const AI_RESOLVE_RULES: Array<{
  id: AiResolveRuleId;
  title: string;
  desc: string;
}> = [
  {
    id: "preferMine",
    title: "默认偏我的",
    desc: "冲突块优先采「我的分支」；空/误删或锁文件等可采线上",
  },
  {
    id: "preferOnline",
    title: "默认偏线上",
    desc: "冲突块优先采「线上」；功能逻辑改动再采我的",
  },
  {
    id: "newerWins",
    title: "新覆盖旧",
    desc: "比较两侧相关 commit 最新时间，较新一侧整块胜出",
  },
  {
    id: "mergeWhenPossible",
    title: "可合并则合并",
    desc: "两边可兼容时输出合并正文；否则再按其它规则选边",
  },
];

export interface AiResolveHunkInput {
  id: string;
  path: string;
  leftText: string;
  rightText: string;
  baseText: string;
  oursCommits: CommitRef[];
  theirsCommits: CommitRef[];
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
