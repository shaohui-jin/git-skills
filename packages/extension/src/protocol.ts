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
  | { type: "graph"; into?: string; from?: string; noFetch?: boolean }
  | { type: "preview"; into: string; from: string; noFetch?: boolean }
  /** @deprecated 同 preview（合并预演） */
  | { type: "blame"; into: string; from: string; noFetch?: boolean };

/** Extension host / preview server -> Webview */
export type HostMessage =
  | {
      type: "workspace";
      cwd: string | null;
      branches: string[];
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
