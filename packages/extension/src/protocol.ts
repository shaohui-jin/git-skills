import type {
  BranchGraph,
  ConflictBlameResult,
  FetchResult,
} from "@git-insight/core";

/** Webview -> Extension host / preview server */
export type WebviewRequest =
  | { type: "ready" }
  | { type: "refreshWorkspace" }
  | { type: "setCwd"; path: string }
  | { type: "pickFolder" }
  | { type: "fetch"; remote?: string }
  | {
      type: "graph";
      into?: string;
      from?: string;
      noFetch?: boolean;
      /** 0 = 全量；默认由宿主按全量处理 */
      maxNodes?: number;
    }
  | { type: "preview"; into: string; from: string; noFetch?: boolean }
  /** @deprecated 同 preview（合并预演） */
  | { type: "blame"; into: string; from: string; noFetch?: boolean };

/** Extension host / preview server -> Webview */
export type HostMessage =
  | {
      type: "workspace";
      cwd: string | null;
      /** 全量分支；remote 由 refs 类型决定，勿用名称是否含 / 判断 */
      branches: Array<{ name: string; remote: boolean }>;
      error?: string;
      previewMode?: boolean;
    }
  | { type: "fetchResult"; data: FetchResult; report: string }
  | {
      type: "graphResult";
      data: BranchGraph;
      report: string;
      mermaid: string;
    }
  | {
      type: "previewResult";
      data: ConflictBlameResult;
      report: string;
      mermaid: string;
    }
  | { type: "error"; message: string; code?: string }
  | { type: "busy"; busy: boolean; label?: string }
  | { type: "focusTab"; tab: "graph" | "preview" };
